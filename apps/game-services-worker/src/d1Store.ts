import {
  assertEntitlementLedgerGrant,
  assertEntitlementLedgerNote,
  assertEntitlementLedgerResult,
  assertEntitlementLedgerRevocation,
  assertEntitlementLedgerTransfer,
  assertEntitlementRevocationTransaction,
  assertLeaderboardScoreTransaction,
  assertProductGrantTransaction,
  assertRecordLeaderboardScoreRequest,
  assertRecordLeaderboardScoreResponse,
  chunkLedgerEntryIds,
  EntitlementTransferConflictError,
  EvidenceAlreadyProcessedError,
  RevocationKeyConflictError,
  type EntitlementLedgerGrant,
  type EntitlementLedgerNote,
  type EntitlementLedgerResult,
  type EntitlementLedgerRevocation,
  type EntitlementLedgerTransfer,
  type EntitlementPlatformEvidenceIdentity,
  type EntitlementRevocationTransaction,
  type EntitlementTransferResult,
  type GameServicesStore,
  type LeaderboardScoreTransaction,
  type ProductGrantTransaction,
  type RecordLeaderboardScoreRequest,
  type RecordLeaderboardScoreResponse,
} from '@mpgd/game-services';

type NoteRow = {
  note_id: string;
  kind: EntitlementLedgerNote['kind'];
  player_id: string;
  ledger_entry_id: string;
  revocation_ledger_entry_id: string | null;
  recorded_at: string;
  payload_json: string;
};

type EntitlementRow = {
  ledger_entry_id: string;
  player_id: string;
  grant_id: string;
  source: ProductGrantTransaction['source'];
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
  reason: EntitlementRevocationTransaction['reason'];
  revoked_at: string;
  payload_json: string;
  evidence_verification_id: string | null;
};

type TransferRow = {
  ledger_entry_id: string;
  player_id: string;
  revokes_ledger_entry_id: string;
  idempotency_key: string;
  revoked_at: string;
  payload_json: string;
  to_ledger_entry_id: string;
};

type LeaderboardRow = {
  ledger_entry_id: string;
  target: LeaderboardScoreTransaction['target'];
  leaderboard_id: string;
  player_id: string;
  score: number;
  run_id: string;
  submitted_at: string;
  platform_submission_id: string | null;
  recorded_at: string;
};

/** `D1Database` and `D1DatabaseSession` both prepare statements. */
type D1Queryable = Pick<D1Database, 'prepare'>;

export function createD1GameServicesStore(db: D1Database): GameServicesStore {
  return new D1GameServicesStore(db);
}

class D1GameServicesStore implements GameServicesStore {
  constructor(private readonly db: D1Database) {}

  async recordEntitlementGrant(
    input: EntitlementLedgerGrant,
  ): Promise<EntitlementLedgerResult> {
    const grant = assertEntitlementLedgerGrant(input);
    const ledgerEntryId = createEntitlementLedgerEntryId(grant);
    // The insert and the read-back share one primary session. A later SELECT on
    // the default binding can hit a replica that has not seen this write and
    // throw even though the unique indexes already recorded the grant.
    const session = this.db.withSession('first-primary');

    const result = await session
      .prepare(
        `INSERT OR IGNORE INTO entitlement_transactions (
          ledger_entry_id,
          player_id,
          grant_id,
          source,
          idempotency_key,
          granted_at,
          grant_json,
          payload_json,
          evidence_verification_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ledgerEntryId,
        grant.playerId,
        grant.grantId,
        grant.source,
        grant.idempotencyKey,
        grant.grantedAt,
        grant.grant === undefined ? null : JSON.stringify(grant.grant),
        JSON.stringify(grant.payload),
        grant.evidenceVerificationId ?? null,
      )
      .run();

    const transaction = await this.findEntitlementTransactionByIdempotency(grant, session);

    if (transaction === undefined) {
      if (
        grant.evidenceVerificationId !== undefined
        && await this.findEntitlementTransactionByEvidenceVerificationId({
          source: grant.source,
          evidenceVerificationId: grant.evidenceVerificationId,
        }, session) !== undefined
      ) {
        throw new EvidenceAlreadyProcessedError();
      }

      const platformEvidenceIdentity = getEntitlementPlatformEvidenceIdentity(grant);
      if (
        platformEvidenceIdentity !== undefined
        && await this.findEntitlementTransactionByPlatformEvidence(platformEvidenceIdentity, session)
          !== undefined
      ) {
        throw new EvidenceAlreadyProcessedError();
      }

      throw new Error('Failed to read entitlement transaction after insert.');
    }

    return assertEntitlementLedgerResult({
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: result.meta.changes === 0,
    });
  }

  async findEntitlementTransactionByIdempotency(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly playerId: string;
    readonly idempotencyKey: string;
  }, db: D1Queryable = this.db): Promise<ProductGrantTransaction | undefined> {
    const row = await db
      .prepare(
        `SELECT * FROM entitlement_transactions
         WHERE source = ? AND player_id = ? AND idempotency_key = ?`,
      )
      .bind(input.source, input.playerId, input.idempotencyKey)
      .first<EntitlementRow>();

    return row === null ? undefined : entitlementFromRow(row);
  }

  async getEntitlementTransaction(
    ledgerEntryId: string,
  ): Promise<ProductGrantTransaction | undefined> {
    const row = await this.db
      .prepare('SELECT * FROM entitlement_transactions WHERE ledger_entry_id = ?')
      .bind(ledgerEntryId)
      .first<EntitlementRow>();

    return row === null ? undefined : entitlementFromRow(row);
  }

  async listEntitlementTransactions(): Promise<readonly ProductGrantTransaction[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM entitlement_transactions ORDER BY granted_at ASC, ledger_entry_id ASC')
      .all<EntitlementRow>();

    return results.map(entitlementFromRow);
  }

  /** The grants with the given ids, one `IN` query per chunk of at most `ledgerReadChunkSize`. */
  async getEntitlementTransactions(
    ledgerEntryIds: readonly string[],
  ): Promise<readonly ProductGrantTransaction[]> {
    const found: ProductGrantTransaction[] = [];
    for (const chunk of chunkLedgerEntryIds([...new Set(ledgerEntryIds)])) {
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(`SELECT * FROM entitlement_transactions WHERE ledger_entry_id IN (${placeholders})`)
        .bind(...chunk)
        .all<EntitlementRow>();
      found.push(...results.map(entitlementFromRow));
    }
    return found;
  }

  /**
   * Appends a `revoke` entry (migration 0006). `INSERT OR IGNORE` makes a
   * replayed notification key, and a second revocation of one grant, read
   * back the first entry with `alreadyProcessed: true`; a key that already
   * reversed another grant is a `RevocationKeyConflictError`, a reused
   * authority identity an `EvidenceAlreadyProcessedError`, and the foreign
   * key keeps an entry for an unknown grant out.
   */
  async recordEntitlementRevocation(
    input: EntitlementLedgerRevocation,
  ): Promise<EntitlementLedgerResult> {
    const revocation = assertEntitlementLedgerRevocation(input);
    if (revocation.reason === 'transfer') {
      throw new Error('Transfer entries are written by recordEntitlementTransfer.');
    }
    const ledgerEntryId = createRevocationLedgerEntryId(revocation);
    // The insert and the read-backs share one primary session, so a transfer
    // committed just before is seen (as in recordEntitlementGrant).
    const session = this.db.withSession('first-primary');

    // A grant a transfer moved (migration 0011), or a key a transfer entry of
    // this player took, is not written a second time: the insert is skipped
    // and the existing entry answered below, as the in-memory store does.
    const result = await session
      .prepare(
        `INSERT OR IGNORE INTO entitlement_revocations (
          ledger_entry_id,
          player_id,
          revokes_ledger_entry_id,
          idempotency_key,
          reason,
          revoked_at,
          payload_json,
          evidence_verification_id
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM entitlement_transfers
          WHERE revokes_ledger_entry_id = ? OR (player_id = ? AND idempotency_key = ?)
        )`,
      )
      .bind(
        ledgerEntryId,
        revocation.playerId,
        revocation.revokesLedgerEntryId,
        revocation.idempotencyKey,
        revocation.reason,
        revocation.revokedAt,
        JSON.stringify(revocation.payload),
        revocation.evidenceVerificationId ?? null,
        revocation.revokesLedgerEntryId,
        revocation.playerId,
        revocation.idempotencyKey,
      )
      .run();

    const byKey = await session
      .prepare(
        `SELECT * FROM entitlement_revocations
         WHERE player_id = ? AND idempotency_key = ?`,
      )
      .bind(revocation.playerId, revocation.idempotencyKey)
      .first<RevocationRow>();
    const transferByKey = byKey === null
      ? await session
        .prepare('SELECT * FROM entitlement_transfers WHERE player_id = ? AND idempotency_key = ?')
        .bind(revocation.playerId, revocation.idempotencyKey)
        .first<TransferRow>()
      : null;
    const keyed = byKey ?? transferByKey;
    if (keyed !== null) {
      if (keyed.revokes_ledger_entry_id !== revocation.revokesLedgerEntryId) {
        throw new RevocationKeyConflictError();
      }
      return assertEntitlementLedgerResult({
        ledgerEntryId: keyed.ledger_entry_id,
        alreadyProcessed: byKey === null || result.meta.changes === 0,
      });
    }
    const byGrant = await session
      .prepare('SELECT * FROM entitlement_revocations WHERE revokes_ledger_entry_id = ?')
      .bind(revocation.revokesLedgerEntryId)
      .first<RevocationRow>();
    if (byGrant !== null) {
      return assertEntitlementLedgerResult({
        ledgerEntryId: byGrant.ledger_entry_id,
        alreadyProcessed: true,
      });
    }
    const transfer = await session
      .prepare('SELECT * FROM entitlement_transfers WHERE revokes_ledger_entry_id = ?')
      .bind(revocation.revokesLedgerEntryId)
      .first<TransferRow>();
    if (transfer !== null) {
      return assertEntitlementLedgerResult({
        ledgerEntryId: transfer.ledger_entry_id,
        alreadyProcessed: true,
      });
    }
    // Neither the key nor the grant holds the row: the insert was ignored by
    // the authority identity index.
    throw new EvidenceAlreadyProcessedError();
  }

  /**
   * Migration 0011: the receiving player's grant and the transfer entry in
   * one batch (one transaction). The transfer insert reads the grant it
   * moves inside the same statement and turns NULL (a NOT NULL failure that
   * rolls the batch back) when that grant is unknown, another player's, or
   * already reversed by a revoke entry; the unique keys refuse a second
   * move of it, a taken grant key, evidence id, or platform evidence.
   */
  async recordEntitlementTransfer(
    input: EntitlementLedgerTransfer,
  ): Promise<EntitlementTransferResult> {
    const { revocation, grant } = assertEntitlementLedgerTransfer(input);
    const grantLedgerEntryId = createEntitlementLedgerEntryId(grant);
    const transferLedgerEntryId = createRevocationLedgerEntryId(revocation);
    const session = this.db.withSession('first-primary');
    try {
      await session.batch([
        session
          .prepare(
            `INSERT INTO entitlement_transactions (
              ledger_entry_id,
              player_id,
              grant_id,
              source,
              idempotency_key,
              granted_at,
              grant_json,
              payload_json,
              evidence_verification_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            grantLedgerEntryId,
            grant.playerId,
            grant.grantId,
            grant.source,
            grant.idempotencyKey,
            grant.grantedAt,
            grant.grant === undefined ? null : JSON.stringify(grant.grant),
            JSON.stringify(grant.payload),
            grant.evidenceVerificationId ?? null,
          ),
        session
          .prepare(
            `INSERT INTO entitlement_transfers (
              ledger_entry_id,
              player_id,
              revokes_ledger_entry_id,
              idempotency_key,
              revoked_at,
              payload_json,
              to_ledger_entry_id
            ) VALUES (
              ?,
              ?,
              (
                SELECT ledger_entry_id FROM entitlement_transactions
                WHERE ledger_entry_id = ?
                  AND player_id = ?
                  AND source = 'purchase'
                  AND NOT EXISTS (
                    SELECT 1 FROM entitlement_revocations
                    WHERE revokes_ledger_entry_id = ? OR (player_id = ? AND idempotency_key = ?)
                  )
              ),
              ?,
              ?,
              ?,
              ?
            )`,
          )
          .bind(
            transferLedgerEntryId,
            revocation.playerId,
            revocation.revokesLedgerEntryId,
            revocation.playerId,
            revocation.revokesLedgerEntryId,
            revocation.playerId,
            revocation.idempotencyKey,
            revocation.idempotencyKey,
            revocation.revokedAt,
            JSON.stringify(revocation.payload),
            grantLedgerEntryId,
          ),
      ]);
      return {
        ledgerEntryId: grantLedgerEntryId,
        revocationLedgerEntryId: transferLedgerEntryId,
        alreadyProcessed: false,
      };
    } catch (error) {
      const recordedGrant = await this.findEntitlementTransactionByIdempotency(grant, session);
      const recordedTransfer = await session
        .prepare('SELECT * FROM entitlement_transfers WHERE player_id = ? AND idempotency_key = ?')
        .bind(revocation.playerId, revocation.idempotencyKey)
        .first<TransferRow>();
      if (
        recordedGrant !== undefined
        && recordedTransfer !== null
        && recordedGrant.evidenceVerificationId === grant.evidenceVerificationId
        && recordedTransfer.revokes_ledger_entry_id === revocation.revokesLedgerEntryId
        && recordedTransfer.to_ledger_entry_id === recordedGrant.ledgerEntryId
      ) {
        return {
          ledgerEntryId: recordedGrant.ledgerEntryId,
          revocationLedgerEntryId: recordedTransfer.ledger_entry_id,
          alreadyProcessed: true,
        };
      }
      const moved = await session
        .prepare('SELECT * FROM entitlement_transactions WHERE ledger_entry_id = ?')
        .bind(revocation.revokesLedgerEntryId)
        .first<EntitlementRow>();
      if (moved === null) {
        throw new Error('Entitlement transfer references an unknown grant.');
      }
      const platformEvidenceIdentity = getEntitlementPlatformEvidenceIdentity(grant);
      // The moved grant reversed in either table, or the transfer's key taken
      // by a revoke entry of the same player (one key space, as in memory).
      const reversed = await session
        .prepare(
          `SELECT 1 AS found FROM entitlement_revocations
           WHERE revokes_ledger_entry_id = ? OR (player_id = ? AND idempotency_key = ?)
           UNION ALL
           SELECT 1 AS found FROM entitlement_transfers WHERE revokes_ledger_entry_id = ?`,
        )
        .bind(
          revocation.revokesLedgerEntryId,
          revocation.playerId,
          revocation.idempotencyKey,
          revocation.revokesLedgerEntryId,
        )
        .first<{ found: number }>();
      if (
        moved.player_id !== revocation.playerId
        || moved.source !== 'purchase'
        || reversed !== null
        || recordedGrant !== undefined
        || recordedTransfer !== null
        || (
          grant.evidenceVerificationId !== undefined
          && await this.findEntitlementTransactionByEvidenceVerificationId({
            source: grant.source,
            evidenceVerificationId: grant.evidenceVerificationId,
          }, session) !== undefined
        )
        || (
          platformEvidenceIdentity !== undefined
          && await this.findEntitlementTransactionByPlatformEvidence(
            platformEvidenceIdentity,
            session,
          ) !== undefined
        )
      ) {
        throw new EntitlementTransferConflictError();
      }
      throw error;
    }
  }

  async findEntitlementRevocations(input: {
    readonly ledgerEntryIds: readonly string[];
  }): Promise<readonly EntitlementRevocationTransaction[]> {
    const revocations: EntitlementRevocationTransaction[] = [];
    for (const chunk of chunkLedgerEntryIds([...new Set(input.ledgerEntryIds)])) {
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(
          `SELECT * FROM entitlement_revocations
           WHERE revokes_ledger_entry_id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<RevocationRow>();
      revocations.push(...results.map(revocationFromRow));
      // Transfers (migration 0011) are revoke entries with reason `transfer`;
      // a second query keeps each within D1's bound-parameter cap.
      const transfers = await this.db
        .prepare(
          `SELECT * FROM entitlement_transfers
           WHERE revokes_ledger_entry_id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<TransferRow>();
      revocations.push(...transfers.results.map(transferFromRow));
    }
    return revocations.sort((left, right) =>
      left.revokedAt.localeCompare(right.revokedAt)
      || left.ledgerEntryId.localeCompare(right.ledgerEntryId));
  }

  /** Migration 0009_store_server.sql: entitlement_notes. */
  async recordEntitlementNote(
    input: EntitlementLedgerNote,
  ): Promise<{ readonly alreadyRecorded: boolean }> {
    const note = assertEntitlementLedgerNote(input);
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO entitlement_notes (
          note_id, kind, player_id, ledger_entry_id, revocation_ledger_entry_id,
          recorded_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        note.noteId,
        note.kind,
        note.playerId,
        note.ledgerEntryId,
        note.revocationLedgerEntryId ?? null,
        note.recordedAt,
        JSON.stringify(note.payload),
      )
      .run();
    return { alreadyRecorded: result.meta.changes === 0 };
  }

  async findEntitlementNotes(input: {
    readonly ledgerEntryIds: readonly string[];
  }): Promise<readonly EntitlementLedgerNote[]> {
    const notes: EntitlementLedgerNote[] = [];
    for (const chunk of chunkLedgerEntryIds([...new Set(input.ledgerEntryIds)])) {
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(`SELECT * FROM entitlement_notes WHERE ledger_entry_id IN (${placeholders})`)
        .bind(...chunk)
        .all<NoteRow>();
      notes.push(...results.map((row) => assertEntitlementLedgerNote({
        noteId: row.note_id,
        kind: row.kind,
        playerId: row.player_id,
        ledgerEntryId: row.ledger_entry_id,
        ...(row.revocation_ledger_entry_id === null
          ? {}
          : { revocationLedgerEntryId: row.revocation_ledger_entry_id }),
        recordedAt: row.recorded_at,
        payload: JSON.parse(row.payload_json) as EntitlementLedgerNote['payload'],
      })));
    }
    return notes.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  }

  async recordLeaderboardScore(
    input: RecordLeaderboardScoreRequest,
    options: { readonly recordedAt?: string } = {},
  ): Promise<RecordLeaderboardScoreResponse> {
    const request = assertRecordLeaderboardScoreRequest(input);
    const ledgerEntryId = createLeaderboardLedgerEntryId(request);

    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO leaderboard_transactions (
          ledger_entry_id,
          target,
          leaderboard_id,
          player_id,
          score,
          run_id,
          submitted_at,
          platform_submission_id,
          recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ledgerEntryId,
        request.target,
        request.leaderboardId,
        request.playerId,
        request.score,
        request.runId,
        request.submittedAt,
        request.platformSubmissionId ?? null,
        options.recordedAt ?? new Date().toISOString(),
      )
      .run();

    const transaction = await this.findLeaderboardByRun(request);

    if (transaction === undefined) {
      throw new Error('Failed to read leaderboard transaction after insert.');
    }

    return assertRecordLeaderboardScoreResponse({
      submitted: true,
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: result.meta.changes === 0,
      rank: await this.rankFor(transaction),
    });
  }

  async getLeaderboardTransaction(
    ledgerEntryId: string,
  ): Promise<LeaderboardScoreTransaction | undefined> {
    const row = await this.db
      .prepare('SELECT * FROM leaderboard_transactions WHERE ledger_entry_id = ?')
      .bind(ledgerEntryId)
      .first<LeaderboardRow>();

    return row === null ? undefined : leaderboardFromRow(row);
  }

  async listLeaderboardTransactions(): Promise<readonly LeaderboardScoreTransaction[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM leaderboard_transactions
         ORDER BY leaderboard_id ASC, score DESC, submitted_at ASC`,
      )
      .all<LeaderboardRow>();

    return results.map(leaderboardFromRow);
  }

  async findEntitlementTransactionByEvidenceVerificationId(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly evidenceVerificationId: string;
  }, db: D1Queryable = this.db): Promise<ProductGrantTransaction | undefined> {
    const row = await db
      .prepare(
        `SELECT * FROM entitlement_transactions
         WHERE source = ? AND evidence_verification_id = ?`,
      )
      .bind(input.source, input.evidenceVerificationId)
      .first<EntitlementRow>();

    return row === null ? undefined : entitlementFromRow(row);
  }

  async findEntitlementTransactionByPlatformEvidence(
    input: EntitlementPlatformEvidenceIdentity,
    db: D1Queryable = this.db,
  ): Promise<ProductGrantTransaction | undefined> {
    const evidenceJsonPath = input.source === 'purchase'
      ? '$.platformTransactionId'
      : '$.platformImpressionId';
    // The predicates match the partial unique index of migration 0004, so the
    // lookup is an index probe rather than a table scan.
    const row = await db
      .prepare(
        `SELECT * FROM entitlement_transactions
         WHERE source = ?
           AND json_type(payload_json, '$.target') = 'text'
           AND json_type(payload_json, '${evidenceJsonPath}') = 'text'
           AND json_extract(payload_json, '$.target') = ?
           AND json_extract(payload_json, '${evidenceJsonPath}') = ?`,
      )
      .bind(input.source, input.target, input.platformEvidenceId)
      .first<EntitlementRow>();

    return row === null ? undefined : entitlementFromRow(row);
  }

  private async findLeaderboardByRun(
    request: RecordLeaderboardScoreRequest,
  ): Promise<LeaderboardScoreTransaction | undefined> {
    const row = await this.db
      .prepare(
        `SELECT * FROM leaderboard_transactions
         WHERE target = ? AND leaderboard_id = ? AND player_id = ? AND run_id = ?`,
      )
      .bind(request.target, request.leaderboardId, request.playerId, request.runId)
      .first<LeaderboardRow>();

    return row === null ? undefined : leaderboardFromRow(row);
  }

  private async rankFor(transaction: LeaderboardScoreTransaction): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) + 1 AS rank
         FROM leaderboard_transactions
         WHERE leaderboard_id = ?
           AND (
             score > ?
             OR (score = ? AND submitted_at < ?)
             OR (score = ? AND submitted_at = ? AND ledger_entry_id < ?)
           )`,
      )
      .bind(
        transaction.leaderboardId,
        transaction.score,
        transaction.score,
        transaction.submittedAt,
        transaction.score,
        transaction.submittedAt,
        transaction.ledgerEntryId,
      )
      .first<{ rank: number }>();

    return row?.rank ?? 1;
  }
}

function entitlementFromRow(row: EntitlementRow): ProductGrantTransaction {
  const baseTransaction = {
    ledgerEntryId: row.ledger_entry_id,
    playerId: row.player_id,
    grantId: row.grant_id,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    grantedAt: row.granted_at,
    payload: JSON.parse(row.payload_json) as ProductGrantTransaction['payload'],
    ...(row.evidence_verification_id === null
      ? {}
      : { evidenceVerificationId: row.evidence_verification_id }),
  };

  return assertProductGrantTransaction(
    row.grant_json === null
      ? baseTransaction
      : {
          ...baseTransaction,
          grant: JSON.parse(row.grant_json) as NonNullable<ProductGrantTransaction['grant']>,
        },
  );
}

function revocationFromRow(row: RevocationRow): EntitlementRevocationTransaction {
  return assertEntitlementRevocationTransaction({
    ledgerEntryId: row.ledger_entry_id,
    playerId: row.player_id,
    revokesLedgerEntryId: row.revokes_ledger_entry_id,
    idempotencyKey: row.idempotency_key,
    reason: row.reason,
    revokedAt: row.revoked_at,
    payload: JSON.parse(row.payload_json) as EntitlementRevocationTransaction['payload'],
    ...(row.evidence_verification_id === null
      ? {}
      : { evidenceVerificationId: row.evidence_verification_id }),
  });
}

function transferFromRow(row: TransferRow): EntitlementRevocationTransaction {
  return assertEntitlementRevocationTransaction({
    ledgerEntryId: row.ledger_entry_id,
    playerId: row.player_id,
    revokesLedgerEntryId: row.revokes_ledger_entry_id,
    idempotencyKey: row.idempotency_key,
    reason: 'transfer',
    revokedAt: row.revoked_at,
    payload: JSON.parse(row.payload_json) as EntitlementRevocationTransaction['payload'],
  });
}

function getEntitlementPlatformEvidenceIdentity(
  grant: EntitlementLedgerGrant,
): EntitlementPlatformEvidenceIdentity | undefined {
  if (grant.source !== 'purchase' && grant.source !== 'ad_reward') {
    return undefined;
  }

  const target = grant.payload.target;
  const platformEvidenceId = grant.source === 'purchase'
    ? grant.payload.platformTransactionId
    : grant.payload.platformImpressionId;

  return typeof target === 'string'
    && target.length > 0
    && typeof platformEvidenceId === 'string'
    && platformEvidenceId.length > 0
    ? { source: grant.source, target, platformEvidenceId }
    : undefined;
}

function leaderboardFromRow(row: LeaderboardRow): LeaderboardScoreTransaction {
  return assertLeaderboardScoreTransaction({
    target: row.target,
    playerId: row.player_id,
    leaderboardId: row.leaderboard_id,
    score: row.score,
    runId: row.run_id,
    submittedAt: row.submitted_at,
    ...(row.platform_submission_id === null
      ? {}
      : { platformSubmissionId: row.platform_submission_id }),
    ledgerEntryId: row.ledger_entry_id,
    recordedAt: row.recorded_at,
  });
}

function createEntitlementLedgerEntryId(grant: EntitlementLedgerGrant): string {
  return [
    'ledger',
    encodeIdSegment(grant.source),
    encodeIdSegment(grant.playerId),
    encodeIdSegment(grant.idempotencyKey),
  ].join('_');
}

function createRevocationLedgerEntryId(revocation: EntitlementLedgerRevocation): string {
  return [
    'revoke',
    encodeIdSegment(revocation.playerId),
    encodeIdSegment(revocation.idempotencyKey),
  ].join('_');
}

function createLeaderboardLedgerEntryId(request: RecordLeaderboardScoreRequest): string {
  return [
    'leaderboard',
    encodeIdSegment(request.target),
    encodeIdSegment(request.leaderboardId),
    encodeIdSegment(request.playerId),
    encodeIdSegment(request.runId),
  ].join('_');
}

function encodeIdSegment(value: string): string {
  return `${value.length}:${encodeURIComponent(value)}`;
}
