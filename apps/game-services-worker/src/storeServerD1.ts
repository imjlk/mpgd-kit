import type {
  FinalizePurchaseGrantInput,
  GameServicesPurchaseGrantFinalizer,
  PurchaseGrantFinalization,
} from '@mpgd/game-services';

/**
 * D1 state of the store server upkeep (migration 0009_store_server.sql): the
 * Play grants whose acknowledge or consume is still owed, and the sweep
 * cursors. Google Play refunds a purchase that is not acknowledged within
 * three days of becoming PURCHASED, so a grant whose client went away is
 * retried here by the cron instead of waiting for that client.
 */

/** Play's acknowledgement window. After it, Google refunds and the voided sweep revokes. */
export const googlePlayAcknowledgementWindowMs = 3 * 24 * 60 * 60 * 1000;

/**
 * Delay after each failed attempt: 1 minute after the first failure, then 5,
 * 15, 1 hour, 3, and every 6 hours.
 */
const retryDelaysMs = [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000] as const;

export function googlePlayFinalizationRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(Math.floor(attempts), 1), retryDelaysMs.length) - 1;
  return retryDelaysMs[index] ?? 21_600_000;
}

export interface GooglePlayPendingFinalization {
  readonly ledgerEntryId: string;
  readonly playerId: string;
  readonly purchaseToken: string;
  readonly firstSeenAtMs: number;
  readonly nextAttemptAtMs: number;
  readonly attempts: number;
  readonly lastReason?: string;
}

interface PendingFinalizationRow {
  readonly ledger_entry_id: string;
  readonly player_id: string;
  readonly purchase_token: string;
  readonly first_seen_at_ms: number;
  readonly next_attempt_at_ms: number;
  readonly attempts: number;
  readonly last_reason: string | null;
}

export interface GooglePlayFinalizationOutbox {
  /** Keeps the token of a grant about to be finalized; a second call keeps the first row. */
  remember(input: {
    readonly ledgerEntryId: string;
    readonly playerId: string;
    readonly purchaseToken: string;
    readonly nowMs: number;
    /**
     * When Play's three-day window started: Google's purchase completion
     * time from the verified grant, else `nowMs`.
     */
    readonly firstSeenAtMs?: number;
  }): Promise<void>;
  /** The purchase is acknowledged or consumed (or will never be): the token is dropped. */
  forget(ledgerEntryId: string): Promise<void>;
  /** One more failed attempt: the next one is scheduled with backoff. */
  defer(input: {
    readonly ledgerEntryId: string;
    readonly reason: string;
    readonly nowMs: number;
  }): Promise<void>;
  /** Rows whose next attempt is due, oldest first. */
  due(input: { readonly nowMs: number; readonly limit: number }): Promise<
    readonly GooglePlayPendingFinalization[]
  >;
}

export function createD1GooglePlayFinalizationOutbox(db: D1Database): GooglePlayFinalizationOutbox {
  return {
    async remember({ ledgerEntryId, playerId, purchaseToken, nowMs, firstSeenAtMs }) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO google_play_pending_finalizations (
            ledger_entry_id, player_id, purchase_token, first_seen_at_ms, next_attempt_at_ms, attempts
          ) VALUES (?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          ledgerEntryId,
          playerId,
          purchaseToken,
          Math.min(firstSeenAtMs ?? nowMs, nowMs),
          nowMs + retryDelaysMs[0],
        )
        .run();
    },
    async forget(ledgerEntryId) {
      await db
        .prepare('DELETE FROM google_play_pending_finalizations WHERE ledger_entry_id = ?')
        .bind(ledgerEntryId)
        .run();
    },
    async defer({ ledgerEntryId, reason, nowMs }) {
      const row = await db
        .prepare('SELECT attempts FROM google_play_pending_finalizations WHERE ledger_entry_id = ?')
        .bind(ledgerEntryId)
        .first<{ readonly attempts: number }>();
      if (row === null) {
        return;
      }
      const attempts = row.attempts + 1;
      await db
        .prepare(
          `UPDATE google_play_pending_finalizations
             SET attempts = ?, next_attempt_at_ms = ?, last_reason = ?
           WHERE ledger_entry_id = ?`,
        )
        .bind(
          attempts,
          nowMs + googlePlayFinalizationRetryDelayMs(attempts),
          reason.slice(0, 200),
          ledgerEntryId,
        )
        .run();
    },
    async due({ nowMs, limit }) {
      if (limit < 1) {
        return [];
      }
      const { results } = await db
        .prepare(
          `SELECT * FROM google_play_pending_finalizations
           WHERE next_attempt_at_ms <= ?
           ORDER BY next_attempt_at_ms ASC
           LIMIT ?`,
        )
        .bind(nowMs, Math.floor(limit))
        .all<PendingFinalizationRow>();
      return results.map((row) => ({
        ledgerEntryId: row.ledger_entry_id,
        playerId: row.player_id,
        purchaseToken: row.purchase_token,
        firstSeenAtMs: row.first_seen_at_ms,
        nextAttemptAtMs: row.next_attempt_at_ms,
        attempts: row.attempts,
        ...(row.last_reason === null ? {} : { lastReason: row.last_reason }),
      }));
    },
  };
}

export interface StoreServerCursors {
  read(name: string): Promise<number | undefined>;
  write(name: string, valueMs: number, now: Date): Promise<void>;
}

export function createD1StoreServerCursors(db: D1Database): StoreServerCursors {
  return {
    async read(name) {
      const row = await db
        .prepare('SELECT value_ms FROM store_server_cursors WHERE name = ?')
        .bind(name)
        .first<{ readonly value_ms: number }>();
      return row === null ? undefined : row.value_ms;
    },
    async write(name, valueMs, now) {
      await db
        .prepare(
          `INSERT INTO store_server_cursors (name, value_ms, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET value_ms = excluded.value_ms,
             updated_at = excluded.updated_at`,
        )
        .bind(name, valueMs, now.toISOString())
        .run();
    },
  };
}

/**
 * Wraps the in-Worker Play finalizer so every grant it is asked to finalize
 * keeps its purchase token until the acknowledge or consume completes. The
 * row is written before the provider call, so a Worker that dies mid-call
 * still leaves it for the cron. Outbox failures are logged and never fail
 * the purchase: the grant is already durable and the client still retries.
 */
export function withGooglePlayFinalizationOutbox(
  finalizer: GameServicesPurchaseGrantFinalizer,
  outbox: GooglePlayFinalizationOutbox,
  now: () => number = Date.now,
): GameServicesPurchaseGrantFinalizer {
  const record = async (operation: () => Promise<void>, step: string): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      console.error(
        `Google Play finalization outbox ${step} failed:`,
        error instanceof Error ? error.name : 'unknown error',
      );
    }
  };
  return {
    ...(finalizer.supportsPurchaseGrant === undefined
      ? {}
      : {
          supportsPurchaseGrant: (input: Omit<FinalizePurchaseGrantInput, 'signal'>) =>
            finalizer.supportsPurchaseGrant?.(input) ?? true,
        }),
    async finalizePurchaseGrant(input) {
      const purchaseToken = readPurchaseToken(input);
      if (purchaseToken !== undefined) {
        await record(() => outbox.remember({
          ledgerEntryId: input.ledgerEntryId,
          playerId: input.request.playerId,
          purchaseToken,
          nowMs: now(),
          firstSeenAtMs: readCompletionTime(input) ?? now(),
        }), 'remember');
      }
      let result: PurchaseGrantFinalization;
      try {
        result = await finalizer.finalizePurchaseGrant(input);
      } catch (error) {
        if (purchaseToken !== undefined) {
          await record(() => outbox.defer({
            ledgerEntryId: input.ledgerEntryId,
            reason: 'PURCHASE_FINALIZER_ERROR',
            nowMs: now(),
          }), 'defer');
        }
        throw error;
      }
      if (purchaseToken !== undefined) {
        await record(
          () => result.status === 'completed'
            ? outbox.forget(input.ledgerEntryId)
            : outbox.defer({
                ledgerEntryId: input.ledgerEntryId,
                reason: result.reason ?? 'PURCHASE_FINALIZATION_PENDING',
                nowMs: now(),
              }),
          result.status === 'completed' ? 'forget' : 'defer',
        );
      }
      return result;
    },
  };
}

/** Google's purchase completion time the verifier recorded, the start of Play's window. */
function readCompletionTime(input: FinalizePurchaseGrantInput): number | undefined {
  const value = input.evidencePayload?.googlePlayPurchaseCompletionTime;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPurchaseToken(input: FinalizePurchaseGrantInput): string | undefined {
  const payload = input.request.evidence?.payload;
  const token = typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>).purchaseToken
    : undefined;
  return typeof token === 'string' && token.length > 0 && token.length <= 4096 ? token : undefined;
}
