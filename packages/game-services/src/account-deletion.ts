/**
 * Account deletion (Google Play "account deletion requirements", App Store
 * Review Guideline 5.1.1(v)): the server erases what game services keep for
 * a player, keeps only the purchase records the law requires (detached from
 * the player), and has the identity service end the player's sessions.
 *
 * Retention decision (see docs/GAME_SERVICES_BACKEND.md#account-deletion):
 * - Purchase ledger rows (`source: 'purchase'`), the revocations that reverse
 *   them and their notes are kept for five years, the period the Korean
 *   E-Commerce Act's enforcement decree (article 6(1)) sets for payment and
 *   supply records. They are rewritten so nothing links them to the player:
 *   a random ledger id and idempotency key, the player id replaced by
 *   `deleted:<deletionId>`, and a `playerId` payload key removed. What
 *   identifies the store transaction (store, product, platform transaction
 *   and order ids, the token digest, the store's own account binding) stays,
 *   so a dispute can be answered from the store receipt and the same store
 *   purchase can never be granted again.
 * - Everything else (rewarded-ad and admin grants, scores, verified
 *   leaderboard entries, notification endpoints, consent records, notices,
 *   reminders, sends and their history) is deleted.
 */
import {
  resolveGameServicesRequestHeaders,
  type GameServicesHeaderResolver,
} from './request-headers.js';
import type { EntitlementLedgerPayload } from './types.js';

/** The public route a signed-in player deletes their own account through. */
export const accountDeletionEndpoint = '/game-services/account/delete';

/** How long the detached purchase records are kept (Korean E-Commerce Act decree, art. 6(1)). */
export const retainedPurchaseRecordYears = 5;

/** The prefix of the player id that replaces a deleted player's on the records kept. */
export const retainedPlayerIdPrefix = 'deleted:';

export interface PlayerDataErasureInput {
  /** The player whose data is erased. */
  readonly playerId: string;
  /** Replaces the player id on the purchase records kept (`deleted:<deletionId>`). */
  readonly retainedPlayerId: string;
}

export interface PlayerDataErasureResult {
  /** Rows deleted. */
  readonly deleted: number;
  /** Purchase ledger rows kept, detached from the player. */
  readonly retained: number;
}

/** One store's part of an account deletion; idempotent, so it can run twice. */
export interface PlayerDataEraser {
  erasePlayerData(input: PlayerDataErasureInput): Promise<PlayerDataErasureResult>;
}

/**
 * The identity service's part (implemented by the identity Worker): revoke
 * every session family of the player and delete the guest record, so no
 * session authenticates as the player again. Idempotent: an unknown player
 * succeeds. It should delete the record last (or atomically): a failure
 * after the sessions are revoked answers the player a retryable error, but
 * the retry can no longer authenticate.
 */
export interface AccountDeletionIdentity {
  deletePlayer(input: { readonly playerId: string }): Promise<unknown>;
}

/** The audit entry of one deletion; it carries no player id or other personal data. */
export interface AccountDeletionAuditEntry {
  readonly deletionId: string;
  readonly requestedAt: string;
  readonly completedAt: string;
  /** `not-configured` only where no identity service exists (local development). */
  readonly identity: 'deleted' | 'not-configured';
  /**
   * `false` when a store's second erasure pass still failed after the
   * identity was deleted: the erasure stays pending (with the player id)
   * until `finishPendingAccountErasures` completes it.
   */
  readonly complete: boolean;
  /** Rows this request deleted; a retry after a failure counts only its own. */
  readonly deleted: number;
  readonly retained: number;
}

export interface AccountDeletionReceipt {
  readonly status: 'deleted';
  readonly deletionId: string;
  readonly completedAt: string;
  /**
   * Purchase ledger rows (grants, the revocations reversing them, and their
   * notes) this request kept, detached from the player, for the retention
   * period. A retry after a partial failure counts only what it kept itself.
   */
  readonly retainedPurchaseRecords: number;
}

export type AccountDeletionErrorCode =
  /** No signed-in session, or a session that no longer authenticates. */
  | 'UNAUTHORIZED'
  /** The request named another player. */
  | 'PLAYER_ID_MISMATCH'
  /** This server has no authentication or identity service for deletion. */
  | 'ACCOUNT_DELETION_NOT_CONFIGURED'
  /**
   * The server failed before the identity was deleted (or answered 5xx/429);
   * every step is idempotent, so retrying is safe.
   */
  | 'ACCOUNT_DELETION_FAILED'
  /** The server refused the request as malformed (another 4xx); retrying does not help. */
  | 'ACCOUNT_DELETION_REJECTED'
  /** The request did not reach the server or its answer was not read. */
  | 'ACCOUNT_DELETION_UNREACHABLE';

export class AccountDeletionError extends Error {
  readonly code: AccountDeletionErrorCode;
  readonly retryable: boolean;

  constructor(code: AccountDeletionErrorCode, options: { readonly cause?: unknown } = {}) {
    super(
      `Account deletion failed: ${code}.`,
      options.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'AccountDeletionError';
    this.code = code;
    this.retryable = code === 'ACCOUNT_DELETION_FAILED' || code === 'ACCOUNT_DELETION_UNREACHABLE';
  }
}

export interface AccountDeletionService {
  /**
   * Erases the player's data, records the erasure as pending, deletes the
   * identity, then erases again: the second pass removes what a request that
   * was already running wrote during the first. A failure before the
   * identity is deleted rejects with a retryable `ACCOUNT_DELETION_FAILED`.
   * Once the identity is deleted the player cannot retry, so each store's
   * second pass is tried three times with a short backoff; a store that
   * still fails leaves the pending erasure for `finishPendingAccountErasures`
   * (the Worker's cron) and is reported in the audit entry
   * (`complete: false`), never to the player.
   */
  deletePlayerAccount(input: { readonly playerId: string }): Promise<AccountDeletionReceipt>;
}

/**
 * An erasure that must be finished after the identity is gone. It holds the
 * player id, so it lives only until the second pass succeeds.
 */
export interface PendingAccountErasure extends PlayerDataErasureInput {
  readonly deletionId: string;
  readonly recordedAt: string;
}

export interface PendingAccountErasureStore {
  record(erasure: PendingAccountErasure): Promise<void>;
  clear(input: { readonly deletionId: string }): Promise<void>;
  /** The oldest pending erasures first. */
  list(input: { readonly limit: number }): Promise<readonly PendingAccountErasure[]>;
}

export function createInMemoryPendingAccountErasureStore(): PendingAccountErasureStore {
  const pending = new Map<string, PendingAccountErasure>();
  return {
    async record(erasure) {
      pending.set(erasure.deletionId, { ...erasure });
    },
    async clear({ deletionId }) {
      pending.delete(deletionId);
    },
    async list({ limit }) {
      return [...pending.values()]
        .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
        .slice(0, limit);
    },
  };
}

export function createAccountDeletionService(input: {
  readonly erasers: readonly PlayerDataEraser[];
  /**
   * The identity service. `null` only for local development without one:
   * the player's sessions then survive the deletion.
   */
  readonly identity: AccountDeletionIdentity | null;
  /** Keeps an erasure across the identity deletion; see `finishPendingAccountErasures`. */
  readonly pending: PendingAccountErasureStore;
  /** Records the audit entry. A failure is logged and does not fail the deletion. */
  readonly audit?: (entry: AccountDeletionAuditEntry) => Promise<void>;
  readonly now?: () => string;
  readonly createDeletionId?: () => string;
  /** Waits between second-pass attempts; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}): AccountDeletionService {
  const now = input.now ?? (() => new Date().toISOString());
  const createDeletionId = input.createDeletionId ?? (() => crypto.randomUUID());
  const sleep = input.sleep ?? defaultSleep;
  const eraseAll = async (erasure: PlayerDataErasureInput): Promise<PlayerDataErasureResult> => {
    let deleted = 0;
    let retained = 0;
    for (const eraser of input.erasers) {
      const result = await eraser.erasePlayerData(erasure);
      deleted += result.deleted;
      retained += result.retained;
    }
    return { deleted, retained };
  };
  return {
    async deletePlayerAccount({ playerId }) {
      if (typeof playerId !== 'string' || playerId.length === 0 || isRetainedPlayerId(playerId)) {
        // A `deleted:` id names kept records, never a player who can sign in.
        throw new AccountDeletionError('UNAUTHORIZED');
      }
      const deletionId = createDeletionId();
      const requestedAt = now();
      const erasure = { playerId, retainedPlayerId: `${retainedPlayerIdPrefix}${deletionId}` };
      let first: PlayerDataErasureResult;
      try {
        first = await eraseAll(erasure);
        await input.pending.record({ ...erasure, deletionId, recordedAt: requestedAt });
      } catch (error) {
        throw new AccountDeletionError('ACCOUNT_DELETION_FAILED', { cause: error });
      }
      try {
        if (input.identity !== null) {
          await input.identity.deletePlayer({ playerId });
        }
      } catch (error) {
        // The player still exists and retries; no sweep may erase what they
        // write meanwhile.
        await input.pending.clear({ deletionId }).catch(() => undefined);
        throw new AccountDeletionError('ACCOUNT_DELETION_FAILED', { cause: error });
      }
      // Each store's second pass on its own, so one failing store does not
      // stop the others.
      let deleted = first.deleted;
      let retained = first.retained;
      let complete = true;
      for (const eraser of input.erasers) {
        const result = await eraseWithRetries(eraser, erasure, deletionId, sleep);
        if (result === undefined) {
          complete = false;
          continue;
        }
        deleted += result.deleted;
        retained += result.retained;
      }
      if (complete) {
        await input.pending.clear({ deletionId }).catch((error: unknown) => {
          // The sweep finishes (erasing nothing more) and clears it later.
          console.error('Account deletion pending entry not cleared:', deletionId, describe(error));
        });
      }
      const completedAt = now();
      const entry: AccountDeletionAuditEntry = {
        deletionId,
        requestedAt,
        completedAt,
        identity: input.identity === null ? 'not-configured' : 'deleted',
        complete,
        deleted,
        retained,
      };
      await recordAudit(input.audit, entry);
      return {
        status: 'deleted',
        deletionId,
        completedAt,
        retainedPurchaseRecords: retained,
      };
    },
  };
}

/**
 * Finishes erasures a deletion left pending (its second pass failed after
 * the identity was deleted): erases again and clears each one that every
 * store completed. Run it from a scheduled job.
 */
export async function finishPendingAccountErasures(input: {
  readonly erasers: readonly PlayerDataEraser[];
  readonly pending: PendingAccountErasureStore;
  readonly limit?: number;
}): Promise<{ readonly finished: number; readonly failed: number }> {
  let finished = 0;
  let failed = 0;
  for (const erasure of await input.pending.list({ limit: input.limit ?? 10 })) {
    try {
      for (const eraser of input.erasers) {
        await eraser.erasePlayerData(erasure);
      }
      await input.pending.clear({ deletionId: erasure.deletionId });
      finished += 1;
    } catch (error) {
      failed += 1;
      console.error('Pending account erasure not finished:', erasure.deletionId, describe(error));
    }
  }
  return { finished, failed };
}

const secondPassAttempts = 3;
const secondPassBackoffMs = [100, 400] as const;

async function eraseWithRetries(
  eraser: PlayerDataEraser,
  erasure: PlayerDataErasureInput,
  deletionId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<PlayerDataErasureResult | undefined> {
  for (let attempt = 0; attempt < secondPassAttempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(secondPassBackoffMs[attempt - 1] ?? 400);
    }
    try {
      return await eraser.erasePlayerData(erasure);
    } catch (error) {
      console.error(
        'Account deletion second erasure pass failed:',
        deletionId,
        `attempt ${attempt + 1} of ${secondPassAttempts}`,
        describe(error),
      );
    }
  }
  return undefined;
}

async function recordAudit(
  audit: ((entry: AccountDeletionAuditEntry) => Promise<void>) | undefined,
  entry: AccountDeletionAuditEntry,
): Promise<void> {
  try {
    await audit?.(entry);
  } catch (error) {
    // The deletion itself is done; failing here would make the player retry
    // with a session that no longer exists.
    console.error('Account deletion audit entry not recorded:', entry.deletionId, describe(error));
  }
}

/** The error's name and message, cut short; store errors name tables, not players. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : 'unknown error';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The player id stored on a deleted player's kept purchase records. */
export function isRetainedPlayerId(playerId: string): boolean {
  return playerId.startsWith(retainedPlayerIdPrefix);
}

/** Refuses an erasure input whose ids could re-erase another deletion's kept records. */
export function assertPlayerDataErasureInput(input: PlayerDataErasureInput): PlayerDataErasureInput {
  if (
    typeof input.playerId !== 'string'
    || input.playerId.length === 0
    || isRetainedPlayerId(input.playerId)
    || typeof input.retainedPlayerId !== 'string'
    || !isRetainedPlayerId(input.retainedPlayerId)
    || input.retainedPlayerId.length <= retainedPlayerIdPrefix.length
  ) {
    throw new Error('Player data erasure needs a player id and a deleted:<id> retained player id.');
  }
  return input;
}

/** A fresh id for a kept ledger row; it carries nothing of the player's ids. */
export function createRetainedLedgerEntryId(): string {
  return `retained_${crypto.randomUUID()}`;
}

/** The kept row's payload: the store transaction stays, the player id goes. */
export function detachRetainedLedgerPayload(
  payload: EntitlementLedgerPayload,
): EntitlementLedgerPayload {
  const { playerId: _playerId, ...rest } = payload;
  void _playerId;
  return rest;
}

export interface AccountDeletionFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type AccountDeletionFetch = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<AccountDeletionFetchResponse>;

export interface AccountDeletionClient {
  /**
   * Deletes the signed-in player's account on the server. Resolves with the
   * receipt; rejects with an `AccountDeletionError`. After an
   * `ACCOUNT_DELETION_UNREACHABLE` failure the deletion may have completed:
   * a retry that answers `UNAUTHORIZED` means the session no longer exists.
   */
  deleteAccount(): Promise<AccountDeletionReceipt>;
}

export function createAccountDeletionClient(input: {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly getHeaders?: GameServicesHeaderResolver;
  readonly fetch?: AccountDeletionFetch;
}): AccountDeletionClient {
  const url = `${input.baseUrl.replace(/\/+$/gu, '')}${accountDeletionEndpoint}`;
  return {
    async deleteAccount() {
      const fetcher = input.fetch
        ?? (globalThis as { readonly fetch?: AccountDeletionFetch }).fetch;
      if (fetcher === undefined) {
        throw new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE');
      }
      const headers = await resolveGameServicesRequestHeaders({
        headers: input.headers,
        getHeaders: input.getHeaders,
      }).catch((error: unknown) => {
        throw new AccountDeletionError('UNAUTHORIZED', { cause: error });
      });
      if (!Object.keys(headers).includes('authorization')) {
        throw new AccountDeletionError('UNAUTHORIZED');
      }
      let response: AccountDeletionFetchResponse;
      let text: string;
      try {
        response = await fetcher(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: '{}',
        });
        text = await response.text();
      } catch (error) {
        throw new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE', { cause: error });
      }
      const body = parseJsonObject(text);
      if (response.status === 200) {
        const receipt = readReceipt(body);
        if (receipt === undefined) {
          throw new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE');
        }
        return receipt;
      }
      const code = body?.error;
      if (response.status === 401) {
        throw new AccountDeletionError('UNAUTHORIZED');
      }
      if (response.status === 403 && code === 'PLAYER_ID_MISMATCH') {
        throw new AccountDeletionError('PLAYER_ID_MISMATCH');
      }
      if (code === 'ACCOUNT_DELETION_NOT_CONFIGURED' || response.status === 404) {
        // 404: a server from before this route.
        throw new AccountDeletionError('ACCOUNT_DELETION_NOT_CONFIGURED');
      }
      throw new AccountDeletionError(
        response.status >= 500 || retryableClientStatuses.has(response.status)
          ? 'ACCOUNT_DELETION_FAILED'
          : 'ACCOUNT_DELETION_REJECTED',
      );
    },
  };
}

/** Request Timeout, Too Early, Too Many Requests: worth another try. */
const retryableClientStatuses: ReadonlySet<number> = new Set([408, 425, 429]);

function parseJsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
}

function readReceipt(
  body: Readonly<Record<string, unknown>> | undefined,
): AccountDeletionReceipt | undefined {
  if (
    body?.status !== 'deleted'
    || typeof body.deletionId !== 'string'
    || typeof body.completedAt !== 'string'
    || typeof body.retainedPurchaseRecords !== 'number'
    || !Number.isInteger(body.retainedPurchaseRecords)
    || body.retainedPurchaseRecords < 0
  ) {
    return undefined;
  }
  return {
    status: 'deleted',
    deletionId: body.deletionId,
    completedAt: body.completedAt,
    retainedPurchaseRecords: body.retainedPurchaseRecords,
  };
}
