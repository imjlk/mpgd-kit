/**
 * Account deletion on the Worker (docs/GAME_SERVICES_BACKEND.md#account-deletion):
 * `POST /game-services/account/delete` for the signed-in player, the D1
 * erasure of every table that keys a player, the pending erasures and audit
 * entries (migration 0010_account_deletion.sql), the cron's sweep, and the
 * retention purge of the purchase records kept for a deleted player.
 */
import {
  accountDeletionEndpoint,
  AccountDeletionError,
  assertPlayerDataErasureInput,
  createAccountDeletionService,
  createRetainedLedgerEntryId,
  detachRetainedLedgerPayload,
  finishPendingAccountErasures,
  retainedPlayerIdPrefix,
  retainedPurchaseRecordYears,
  type AccountDeletionAuditEntry,
  type AccountDeletionIdentity,
  type AccountDeletionReceipt,
  type EntitlementLedgerPayload,
  type PendingAccountErasure,
  type PendingAccountErasureStore,
  type PendingAccountErasureSweep,
  type PlayerDataEraser,
} from '@mpgd/game-services';

/**
 * The identity Worker's account deletion entrypoint: revoke every session
 * family of the player and delete the guest record (idempotent; an unknown
 * player succeeds). Bind it as `GAME_SERVICES_ACCOUNT_DELETION`.
 */
export interface GameServicesAccountDeletionBinding extends AccountDeletionIdentity {
  deletePlayer(input: { readonly playerId: string }): Promise<unknown>;
}

/** Who a deletion request authenticates as, and how. */
export type AccountDeletionPrincipal =
  | {
      readonly status: 'authenticated';
      readonly playerId: string;
      /** A local development session (`MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS`). */
      readonly development: boolean;
    }
  | { readonly status: 'rejected'; readonly response: Response };

export interface AccountDeletionRouteInput {
  readonly corsHeaders: Readonly<Record<string, string>>;
  /** Resolves the request's session, or answers it (401, 500, 503). */
  authenticate(request: Request): Promise<AccountDeletionPrincipal>;
  /**
   * The deletion service for this principal, or `undefined` when this
   * deployment cannot delete (no identity service outside local
   * development): 503.
   */
  service(principal: { readonly development: boolean }):
    | ReturnType<typeof createAccountDeletionService>
    | undefined;
}

const maxBodyBytes = 4 * 1024;

/** Mounts `POST /game-services/account/delete`; answers `undefined` for other paths. */
export function createAccountDeletionFetchHandler(
  input: AccountDeletionRouteInput,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    if (new URL(request.url).pathname !== accountDeletionEndpoint) {
      return undefined;
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: input.corsHeaders });
    }
    if (request.method !== 'POST') {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { ...input.corsHeaders, allow: 'POST' });
    }
    const principal = await input.authenticate(request);
    if (principal.status === 'rejected') {
      return withHeaders(principal.response, input.corsHeaders);
    }
    // A body the client cut off reads as malformed, not as a server failure.
    const body = await readBody(request).catch(() => undefined);
    if (body === undefined) {
      return json({ error: 'BAD_REQUEST' }, 400, input.corsHeaders);
    }
    // The session names the player; a body that names someone else is refused.
    if (body.playerId !== undefined && body.playerId !== principal.playerId) {
      return json({ error: 'PLAYER_ID_MISMATCH' }, 403, input.corsHeaders);
    }
    let receipt: AccountDeletionReceipt;
    try {
      const service = input.service(principal);
      if (service === undefined) {
        return json({ error: 'ACCOUNT_DELETION_NOT_CONFIGURED' }, 503, input.corsHeaders);
      }
      receipt = await service.deletePlayerAccount({ playerId: principal.playerId });
    } catch (error) {
      if (error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED') {
        return json({ error: 'UNAUTHORIZED' }, 401, input.corsHeaders);
      }
      // The cause's name and message (store errors name tables, not players).
      console.error(
        'Account deletion failed:',
        describe(
          error instanceof Error && error.cause instanceof Error ? error.cause : error,
          principal.playerId,
        ),
      );
      return json({ error: 'ACCOUNT_DELETION_FAILED', retryable: true }, 500, input.corsHeaders);
    }
    return json(receipt, 200, input.corsHeaders);
  };
}

/** The JSON object body (empty is `{}`), read only up to the size limit. */
async function readBody(request: Request): Promise<Readonly<Record<string, unknown>> | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > maxBodyBytes) {
    return undefined;
  }
  const bytes: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        return undefined;
      }
      bytes.push(value);
    }
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of bytes) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(joined);
  if (text.trim().length === 0) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
}

function json(body: unknown, status: number, headers: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function withHeaders(response: Response, headers: Readonly<Record<string, string>>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    merged.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: merged });
}

type GrantRow = {
  ledger_entry_id: string;
  player_id: string;
  grant_id: string;
  source: string;
  idempotency_key: string;
  granted_at: string;
  grant_json: string | null;
  payload_json: string;
  evidence_verification_id: string | null;
};

type RevocationRow = {
  ledger_entry_id: string;
  player_id: string;
  revokes_ledger_entry_id: string;
  idempotency_key: string;
  reason: string;
  revoked_at: string;
  payload_json: string;
  evidence_verification_id: string | null;
};

type NoteRow = {
  note_id: string;
  kind: string;
  player_id: string;
  ledger_entry_id: string;
  revocation_ledger_entry_id: string | null;
  recorded_at: string;
  payload_json: string;
};

/**
 * Every table of the reference migrations that keys a player, with how the
 * erasure treats it. `retained` rows are rewritten detached from the player
 * (see `@mpgd/game-services/account-deletion`); every other row is deleted.
 * The D1 test checks this list against the migrations.
 */
export const d1PlayerTables = {
  entitlement_transactions: 'player_id (purchase grants retained)',
  entitlement_revocations: 'player_id (retained with their grant)',
  entitlement_notes: 'player_id (retained with their grant)',
  google_play_pending_finalizations: 'player_id (retained with their grant until finalized)',
  leaderboard_transactions: 'player_id',
  admob_ssv_callbacks: 'player_id',
  verified_leaderboard_attempts: 'participant_id',
  verified_leaderboard_entries: 'participant_id',
  notification_consent_records: 'player_id',
  notification_endpoints: 'player_id',
  notification_platform_registrations: 'player_id',
  notification_notices_given: 'player_id',
  notification_sends: 'player_id',
  notification_delivery_history: 'player_id',
  notification_schedule: 'player_id',
  account_deletion_pending: 'player_id (the deletion itself)',
} as const;

/** Tables deleted by player with one statement each; the ledger tables are rewritten row by row. */
const deletedByPlayer: readonly (readonly [table: string, column: string])[] = [
  ['leaderboard_transactions', 'player_id'],
  ['admob_ssv_callbacks', 'player_id'],
  ['verified_leaderboard_entries', 'participant_id'],
  ['verified_leaderboard_attempts', 'participant_id'],
  ['notification_consent_records', 'player_id'],
  ['notification_endpoints', 'player_id'],
  ['notification_platform_registrations', 'player_id'],
  ['notification_notices_given', 'player_id'],
  ['notification_sends', 'player_id'],
  ['notification_delivery_history', 'player_id'],
  ['notification_schedule', 'player_id'],
];

/**
 * The D1 erasure: one batch (a transaction) over every player table. The
 * ledger rows are read first and rewritten by id, so a row written between
 * the read and the batch is left for the pending erasure's sweep instead of being
 * half-handled; a revocation written meanwhile for a grant being rewritten
 * fails the batch (the grant's foreign key), which the caller retries.
 */
export function createD1PlayerDataEraser(db: D1Database): PlayerDataEraser {
  return {
    async erasePlayerData(input) {
      const { playerId, retainedPlayerId } = assertPlayerDataErasureInput(input);
      const session = db.withSession('first-primary');
      // Purchase grants are rewritten row by row; every other grant of the
      // player (one per rewarded ad, possibly thousands) goes in set-based
      // statements, so the batch does not grow with them.
      const purchaseGrants = `SELECT ledger_entry_id FROM entitlement_transactions
        WHERE player_id = ?1 AND source = 'purchase'`;
      const otherGrants = `SELECT ledger_entry_id FROM entitlement_transactions
        WHERE player_id = ?1 AND source <> 'purchase'`;
      const allGrants = 'SELECT ledger_entry_id FROM entitlement_transactions WHERE player_id = ?1';
      // Revocations and notes about the player's purchase grants, and those a
      // game-owned writer filed under the player for another player's grant.
      const revocationsWhere = `revokes_ledger_entry_id IN (${purchaseGrants})
        OR (player_id = ?1 AND revokes_ledger_entry_id NOT IN (${allGrants}))`;
      const grants = (await session
        .prepare("SELECT * FROM entitlement_transactions WHERE player_id = ?1 AND source = 'purchase'")
        .bind(playerId)
        .all<GrantRow>()).results;
      const revocations = (await session
        .prepare(`SELECT * FROM entitlement_revocations WHERE ${revocationsWhere}`)
        .bind(playerId)
        .all<RevocationRow>()).results;
      const notes = (await session
        .prepare(`SELECT * FROM entitlement_notes
          WHERE (ledger_entry_id IN (${purchaseGrants})
              OR revocation_ledger_entry_id IN (
                SELECT ledger_entry_id FROM entitlement_revocations WHERE ${revocationsWhere}
              )
              OR (player_id = ?1 AND ledger_entry_id NOT IN (${allGrants})))
            /* Notes about the player's other grants go with them, set-based. */
            AND ledger_entry_id NOT IN (${otherGrants})`)
        .bind(playerId)
        .all<NoteRow>()).results;

      const keptGrantIds = new Map<string, string>();
      for (const grant of grants) {
        keptGrantIds.set(grant.ledger_entry_id, createRetainedLedgerEntryId());
      }
      // A selected revocation or note is kept with the grant it is about: a
      // kept purchase grant, or (only through a game-owned writer) another
      // player's grant, which stays.
      const keptGrantOf = (ledgerEntryId: string): string =>
        keptGrantIds.get(ledgerEntryId) ?? ledgerEntryId;
      const keptRevocationIds = new Map<string, string>();
      for (const revocation of revocations) {
        keptRevocationIds.set(revocation.ledger_entry_id, createRetainedLedgerEntryId());
      }

      const statements: D1PreparedStatement[] = [
        // The owed Play finalizations are moved to the rewritten grants before
        // the old grants go: their keys point at the new ids until those are
        // inserted later in this transaction.
        session.prepare('PRAGMA defer_foreign_keys = true'),
        session.prepare(`DELETE FROM entitlement_notes WHERE ledger_entry_id IN (${otherGrants})`)
          .bind(playerId),
        session.prepare(`DELETE FROM entitlement_revocations
            WHERE revokes_ledger_entry_id IN (${otherGrants})`)
          .bind(playerId),
        // Their Play finalization rows, if any, go by the foreign key's cascade.
        session.prepare(`DELETE FROM entitlement_transactions
            WHERE player_id = ?1 AND source <> 'purchase'`)
          .bind(playerId),
      ];
      // The set-based deletes are statements [setBasedStart, setBasedEnd),
      // after the PRAGMA.
      const setBasedStart = 1;
      const setBasedEnd = statements.length;
      for (const note of notes) {
        statements.push(session.prepare('DELETE FROM entitlement_notes WHERE note_id = ?').bind(note.note_id));
      }
      // By grant id, not from a read: a finalization the purchase path wrote
      // after the reads above moves too, instead of going with the old grant
      // by the cascade. Kept until the cron acknowledges or consumes the
      // purchase within Play's three-day window; the row (with the raw
      // token) then goes.
      for (const [oldId, newId] of keptGrantIds) {
        statements.push(
          session.prepare(`UPDATE google_play_pending_finalizations
              SET ledger_entry_id = ?, player_id = ? WHERE ledger_entry_id = ?`)
            .bind(newId, retainedPlayerId, oldId),
        );
      }
      // One filed under the player for another player's grant.
      statements.push(
        session.prepare('UPDATE google_play_pending_finalizations SET player_id = ? WHERE player_id = ?')
          .bind(retainedPlayerId, playerId),
      );
      for (const revocation of revocations) {
        statements.push(
          session.prepare('DELETE FROM entitlement_revocations WHERE ledger_entry_id = ?')
            .bind(revocation.ledger_entry_id),
        );
      }
      for (const grant of grants) {
        statements.push(
          session.prepare('DELETE FROM entitlement_transactions WHERE ledger_entry_id = ?')
            .bind(grant.ledger_entry_id),
        );
      }
      let retained = 0;
      for (const grant of grants) {
        const ledgerEntryId = keptGrantIds.get(grant.ledger_entry_id);
        if (ledgerEntryId === undefined) {
          continue;
        }
        statements.push(session.prepare(`INSERT INTO entitlement_transactions (
            ledger_entry_id, player_id, grant_id, source, idempotency_key, granted_at,
            grant_json, payload_json, evidence_verification_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          ledgerEntryId,
          retainedPlayerId,
          grant.grant_id,
          grant.source,
          ledgerEntryId,
          grant.granted_at,
          grant.grant_json,
          detachPayloadJson(grant.payload_json),
          grant.evidence_verification_id,
        ));
        retained += 1;
      }
      for (const revocation of revocations) {
        const ledgerEntryId = keptRevocationIds.get(revocation.ledger_entry_id);
        const revokes = keptGrantOf(revocation.revokes_ledger_entry_id);
        if (ledgerEntryId === undefined) {
          continue;
        }
        statements.push(session.prepare(`INSERT INTO entitlement_revocations (
            ledger_entry_id, player_id, revokes_ledger_entry_id, idempotency_key, reason,
            revoked_at, payload_json, evidence_verification_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          ledgerEntryId,
          retainedPlayerId,
          revokes,
          ledgerEntryId,
          revocation.reason,
          revocation.revoked_at,
          detachPayloadJson(revocation.payload_json),
          revocation.evidence_verification_id,
        ));
        retained += 1;
      }
      for (const note of notes) {
        const grant = keptGrantOf(note.ledger_entry_id);
        const revocation = note.revocation_ledger_entry_id === null
          ? null
          : (keptRevocationIds.get(note.revocation_ledger_entry_id) ?? note.revocation_ledger_entry_id);
        statements.push(session.prepare(`INSERT INTO entitlement_notes (
            note_id, kind, player_id, ledger_entry_id, revocation_ledger_entry_id,
            recorded_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
          note.note_id,
          note.kind,
          retainedPlayerId,
          grant,
          revocation,
          note.recorded_at,
          detachPayloadJson(note.payload_json),
        ));
        retained += 1;
      }
      const byPlayerStart = statements.length;
      for (const [table, column] of deletedByPlayer) {
        statements.push(session.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(playerId));
      }
      const results = await session.batch(statements);
      const changes = (from: number, to: number): number =>
        results.slice(from, to).reduce((total, result) => total + (result.meta.changes ?? 0), 0);
      // Every selected ledger row is kept (rewritten); deleted rows are the
      // set-based and by-player statements' changes.
      return {
        deleted: changes(setBasedStart, setBasedEnd) + changes(byPlayerStart, results.length),
        retained,
      };
    },
  };
}

function detachPayloadJson(payloadJson: string): string {
  return JSON.stringify(
    detachRetainedLedgerPayload(JSON.parse(payloadJson) as EntitlementLedgerPayload),
  );
}

type PendingRow = {
  deletion_id: string;
  player_id: string;
  retained_player_id: string;
  phase: PendingAccountErasure['phase'];
  recorded_at: string;
  attempts: number;
  attempted_at: string | null;
};

export function createD1PendingAccountErasureStore(db: D1Database): PendingAccountErasureStore {
  return {
    async put(erasure) {
      await db.prepare(`INSERT INTO account_deletion_pending (
          deletion_id, player_id, retained_player_id, phase, recorded_at, attempts, attempted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (deletion_id) DO UPDATE SET
          phase = excluded.phase,
          attempts = excluded.attempts,
          attempted_at = excluded.attempted_at`)
        .bind(
          erasure.deletionId,
          erasure.playerId,
          erasure.retainedPlayerId,
          erasure.phase,
          erasure.recordedAt,
          erasure.attempts,
          erasure.attemptedAt ?? null,
        )
        .run();
    },
    async clear({ deletionId }) {
      await db.prepare('DELETE FROM account_deletion_pending WHERE deletion_id = ?').bind(deletionId).run();
    },
    async list({ limit, identityDeletedBefore }) {
      const rows = (await db.prepare(`SELECT * FROM account_deletion_pending
          WHERE ?1 IS NULL OR phase <> 'identity-deleted' OR recorded_at <= ?1
          ORDER BY CASE phase WHEN 'identity-deleted' THEN 0 ELSE 1 END,
            COALESCE(attempted_at, recorded_at), deletion_id
          LIMIT ?2`)
        .bind(identityDeletedBefore ?? null, limit)
        .all<PendingRow>()).results;
      return rows.map((row) => ({
        deletionId: row.deletion_id,
        playerId: row.player_id,
        retainedPlayerId: row.retained_player_id,
        phase: row.phase,
        recordedAt: row.recorded_at,
        attempts: row.attempts,
        ...(row.attempted_at === null ? {} : { attemptedAt: row.attempted_at }),
      }));
    },
  };
}

/**
 * One entry per deletion id: a sweep that completes an earlier deletion
 * updates its completion and adds its counts.
 */
export function createD1AccountDeletionAudit(
  db: D1Database,
): (entry: AccountDeletionAuditEntry) => Promise<void> {
  return async (entry) => {
    await db.prepare(`INSERT INTO account_deletion_audit (
        deletion_id, requested_at, completed_at, identity, complete, deleted_rows, retained_rows
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (deletion_id) DO UPDATE SET
        completed_at = excluded.completed_at,
        complete = excluded.complete,
        deleted_rows = account_deletion_audit.deleted_rows + excluded.deleted_rows,
        retained_rows = account_deletion_audit.retained_rows + excluded.retained_rows`)
      .bind(
        entry.deletionId,
        entry.requestedAt,
        entry.completedAt,
        entry.identity,
        entry.complete ? 1 : 0,
        entry.deleted,
        entry.retained,
      )
      .run();
  };
}

/** The memory store's audit: one log line, with no player data. */
export async function logAccountDeletionAudit(entry: AccountDeletionAuditEntry): Promise<void> {
  console.info('Account deletion:', JSON.stringify(entry));
}

/**
 * Deletes the purchase records kept for deleted players once the retention
 * period (`retainedPurchaseRecordYears`) has passed since the grant and
 * since any revocation of it, with their notes and any leftover Play
 * finalization row. One batch; answers how many grants went.
 */
export async function purgeExpiredRetainedPurchaseRecords(
  db: D1Database,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - retainedPurchaseRecordYears);
  const cutoffText = cutoff.toISOString();
  // A range over the player index: every id that starts with the prefix.
  const prefixStart = retainedPlayerIdPrefix;
  const prefixEnd = `${retainedPlayerIdPrefix.slice(0, -1)}${
    String.fromCharCode(retainedPlayerIdPrefix.charCodeAt(retainedPlayerIdPrefix.length - 1) + 1)
  }`;
  const expired = `SELECT g.ledger_entry_id FROM entitlement_transactions g
    WHERE g.player_id >= ?2 AND g.player_id < ?3
      AND g.granted_at < ?1
      AND NOT EXISTS (
        SELECT 1 FROM entitlement_revocations r
        WHERE r.revokes_ledger_entry_id = g.ledger_entry_id AND r.revoked_at >= ?1
      )`;
  const results = await db.batch([
    // Also notes about another grant that point at a revocation being purged:
    // they would hold the revocation's RESTRICT key and fail the batch.
    db.prepare(`DELETE FROM entitlement_notes WHERE ledger_entry_id IN (${expired})
        OR revocation_ledger_entry_id IN (
          SELECT ledger_entry_id FROM entitlement_revocations
          WHERE revokes_ledger_entry_id IN (${expired})
        )`).bind(cutoffText, prefixStart, prefixEnd),
    db.prepare(`DELETE FROM google_play_pending_finalizations WHERE ledger_entry_id IN (${expired})`)
      .bind(cutoffText, prefixStart, prefixEnd),
    db.prepare(`DELETE FROM entitlement_revocations WHERE revokes_ledger_entry_id IN (${expired})`)
      .bind(cutoffText, prefixStart, prefixEnd),
    db.prepare(`DELETE FROM entitlement_transactions WHERE ledger_entry_id IN (${expired})`)
      .bind(cutoffText, prefixStart, prefixEnd),
  ]);
  return results[3]?.meta.changes ?? 0;
}

/**
 * The cron's part: finish pending erasures and purge expired kept purchase
 * records. A failure is logged and never stops the other cron work.
 */
export async function runScheduledAccountDeletion(input: {
  readonly db: D1Database | undefined;
  readonly erasers: readonly PlayerDataEraser[];
  readonly pending: PendingAccountErasureStore;
  readonly audit: (entry: AccountDeletionAuditEntry) => Promise<void>;
  readonly now?: () => Date;
}): Promise<{ readonly sweep?: PendingAccountErasureSweep; readonly purged?: number }> {
  const now = input.now ?? (() => new Date());
  let sweep: PendingAccountErasureSweep | undefined;
  let purged: number | undefined;
  try {
    sweep = await finishPendingAccountErasures({
      erasers: input.erasers,
      pending: input.pending,
      audit: input.audit,
      now: () => now().toISOString(),
    });
  } catch (error) {
    console.error('Pending account erasures sweep failed:', describe(error));
  }
  if (input.db !== undefined) {
    try {
      purged = await purgeExpiredRetainedPurchaseRecords(input.db, now());
    } catch (error) {
      console.error('Retained purchase records purge failed:', describe(error));
    }
  }
  return {
    ...(sweep === undefined ? {} : { sweep }),
    ...(purged === undefined ? {} : { purged }),
  };
}

/** The error's name and message with `redact` (a player id) scrubbed, then cut short. */
function describe(error: unknown, redact?: string): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const text = `${error.name}: ${error.message}`;
  return (redact === undefined || redact.length === 0 ? text : text.split(redact).join('[player]'))
    .slice(0, 200);
}
