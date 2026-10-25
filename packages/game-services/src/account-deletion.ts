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
   * until `finishPendingAccountErasures` completes it and records a
   * `complete: true` entry under the same `deletionId`.
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
   * identity, marks the pending erasure `identity-deleted`, then erases
   * again: the second pass removes what a request that was already running
   * wrote during the first. A failure before the identity is deleted rejects
   * with a retryable `ACCOUNT_DELETION_FAILED`. Once the identity is deleted
   * the player cannot retry, so each store's second pass is tried three
   * times with a short backoff; a store that still fails leaves the erasure
   * pending for `finishPendingAccountErasures` (the Worker's cron) and is
   * reported in the audit entry (`complete: false`), never to the player.
   */
  deletePlayerAccount(input: { readonly playerId: string }): Promise<AccountDeletionReceipt>;
}

/**
 * An erasure kept across the identity deletion. It holds the player id, so
 * it lives only until the erasure completes.
 */
export interface PendingAccountErasure extends PlayerDataErasureInput {
  readonly deletionId: string;
  readonly recordedAt: string;
  /**
   * `erasing` until the identity service confirmed the deletion. The sweep
   * erases only `identity-deleted` erasures: an `erasing` one belongs to a
   * request that failed or died before that confirmation, whose player most
   * likely still exists and retries, so the sweep discards it once it is
   * older than `staleErasingPendingMs` instead of erasing a live player.
   */
  readonly phase: 'erasing' | 'identity-deleted';
  /** Sweep attempts so far. */
  readonly attempts: number;
  /** When the sweep last tried it; the store lists least recently tried first. */
  readonly attemptedAt?: string;
}

export interface PendingAccountErasureStore {
  /** Inserts or replaces the erasure named by `deletionId`. */
  put(erasure: PendingAccountErasure): Promise<void>;
  clear(input: { readonly deletionId: string }): Promise<void>;
  /** At most `limit` erasures, least recently tried (`attemptedAt`, else `recordedAt`) first. */
  list(input: { readonly limit: number }): Promise<readonly PendingAccountErasure[]>;
}

/** An `erasing` erasure older than this (one hour) is discarded by the sweep. */
export const staleErasingPendingMs = 60 * 60 * 1000;

export function createInMemoryPendingAccountErasureStore(): PendingAccountErasureStore {
  const pending = new Map<string, PendingAccountErasure>();
  const triedAt = (erasure: PendingAccountErasure): string =>
    erasure.attemptedAt ?? erasure.recordedAt;
  return {
    async put(erasure) {
      pending.set(erasure.deletionId, { ...erasure });
    },
    async clear({ deletionId }) {
      pending.delete(deletionId);
    },
    async list({ limit }) {
      return [...pending.values()]
        .sort((left, right) => triedAt(left).localeCompare(triedAt(right)))
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
  return {
    async deletePlayerAccount({ playerId }) {
      if (typeof playerId !== 'string' || playerId.length === 0 || isRetainedPlayerId(playerId)) {
        // A `deleted:` id names kept records, never a player who can sign in.
        throw new AccountDeletionError('UNAUTHORIZED');
      }
      const deletionId = createDeletionId();
      const requestedAt = now();
      const erasure = { playerId, retainedPlayerId: `${retainedPlayerIdPrefix}${deletionId}` };
      const pendingErasure: PendingAccountErasure = {
        ...erasure,
        deletionId,
        recordedAt: requestedAt,
        phase: 'erasing',
        attempts: 0,
      };
      let first: PlayerDataErasureResult;
      try {
        first = await eraseAll(input.erasers, erasure);
        await input.pending.put(pendingErasure);
        if (input.identity !== null) {
          await input.identity.deletePlayer({ playerId });
        }
      } catch (error) {
        // The player most likely still exists and retries; an `erasing`
        // entry left behind is never erased, only discarded when stale.
        throw new AccountDeletionError('ACCOUNT_DELETION_FAILED', { cause: error });
      }
      try {
        await input.pending.put({ ...pendingErasure, phase: 'identity-deleted' });
      } catch (error) {
        // The inline second pass below still runs; only a sweep would miss it.
        logFailure('Account deletion pending entry not marked:', deletionId, playerId, error);
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
          // The sweep repeats the (now empty) erasure and clears it later.
          logFailure('Account deletion pending entry not cleared:', deletionId, playerId, error);
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
      await recordAudit(input.audit, entry, playerId);
      return {
        status: 'deleted',
        deletionId,
        completedAt,
        retainedPurchaseRecords: retained,
      };
    },
  };
}

export interface PendingAccountErasureSweep {
  /** `identity-deleted` erasures that every store completed and that were cleared. */
  readonly finished: number;
  /** Erasures a store failed, kept for the next sweep. */
  readonly failed: number;
  /** Stale `erasing` erasures discarded without erasing. */
  readonly discarded: number;
}

/**
 * Finishes erasures a deletion left pending: an `identity-deleted` one is
 * erased again and cleared once every store completed it, with an audit
 * entry that marks the deletion complete; an `erasing` one older than
 * `staleErasingPendingMs` is discarded without erasing. Run it from a
 * scheduled job. A failing erasure is tried again later, least recently
 * tried first, so one that keeps failing does not block the others.
 */
export async function finishPendingAccountErasures(input: {
  readonly erasers: readonly PlayerDataEraser[];
  readonly pending: PendingAccountErasureStore;
  readonly audit?: (entry: AccountDeletionAuditEntry) => Promise<void>;
  readonly now?: () => string;
  readonly limit?: number;
}): Promise<PendingAccountErasureSweep> {
  const now = input.now ?? (() => new Date().toISOString());
  let finished = 0;
  let failed = 0;
  let discarded = 0;
  for (const erasure of await input.pending.list({ limit: input.limit ?? 10 })) {
    const at = now();
    if (erasure.phase !== 'identity-deleted') {
      if (Date.parse(at) - Date.parse(erasure.recordedAt) >= staleErasingPendingMs) {
        await input.pending.clear({ deletionId: erasure.deletionId });
        discarded += 1;
      }
      continue;
    }
    let result: PlayerDataErasureResult;
    try {
      result = await eraseAll(input.erasers, erasure);
    } catch (error) {
      failed += 1;
      logFailure(
        'Pending account erasure not finished:',
        erasure.deletionId,
        erasure.playerId,
        error,
      );
      await input.pending
        .put({ ...erasure, attempts: erasure.attempts + 1, attemptedAt: at })
        .catch(() => undefined);
      continue;
    }
    try {
      await input.pending.clear({ deletionId: erasure.deletionId });
    } catch (error) {
      // Erased; the next sweep repeats the (now empty) erasure and clears it.
      logFailure(
        'Pending account erasure not cleared:',
        erasure.deletionId,
        erasure.playerId,
        error,
      );
    }
    finished += 1;
    await recordAudit(
      input.audit,
      {
        deletionId: erasure.deletionId,
        requestedAt: erasure.recordedAt,
        completedAt: at,
        identity: 'deleted',
        complete: true,
        deleted: result.deleted,
        retained: result.retained,
      },
      erasure.playerId,
    );
  }
  return { finished, failed, discarded };
}

const secondPassAttempts = 3;
const secondPassBackoffMs = [100, 400] as const;

async function eraseAll(
  erasers: readonly PlayerDataEraser[],
  erasure: PlayerDataErasureInput,
): Promise<PlayerDataErasureResult> {
  let deleted = 0;
  let retained = 0;
  for (const eraser of erasers) {
    const result = await eraser.erasePlayerData(erasure);
    deleted += result.deleted;
    retained += result.retained;
  }
  return { deleted, retained };
}

async function eraseWithRetries(
  eraser: PlayerDataEraser,
  erasure: PlayerDataErasureInput,
  deletionId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<PlayerDataErasureResult | undefined> {
  for (let attempt = 0; attempt < secondPassAttempts; attempt += 1) {
    try {
      if (attempt > 0) {
        await sleep(secondPassBackoffMs[attempt - 1] ?? 400);
      }
      return await eraser.erasePlayerData(erasure);
    } catch (error) {
      logFailure(
        `Account deletion second erasure pass failed (attempt ${attempt + 1} of ${secondPassAttempts}):`,
        deletionId,
        erasure.playerId,
        error,
      );
    }
  }
  return undefined;
}

async function recordAudit(
  audit: ((entry: AccountDeletionAuditEntry) => Promise<void>) | undefined,
  entry: AccountDeletionAuditEntry,
  playerId: string,
): Promise<void> {
  try {
    await audit?.(entry);
  } catch (error) {
    // The deletion itself is done; failing here would make the player retry
    // with a session that no longer exists.
    logFailure('Account deletion audit entry not recorded:', entry.deletionId, playerId, error);
  }
}

/**
 * Logs a failure by deletion id with the error's name and message, cut
 * short and with the player id scrubbed, so no log line names the player.
 */
function logFailure(message: string, deletionId: string, playerId: string, error: unknown): void {
  const described = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  console.error(message, deletionId, described.split(playerId).join('[player]').slice(0, 200));
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
    readonly signal?: AbortSignal;
  },
) => Promise<AccountDeletionFetchResponse>;

/** How long `deleteAccount()` waits for the session and the server by default. */
export const defaultAccountDeletionTimeoutMs = 30_000;

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
  /** Deadline for resolving the session headers and the server's answer; 30 s by default. */
  readonly timeoutMs?: number;
}): AccountDeletionClient {
  const url = `${input.baseUrl.replace(/\/+$/gu, '')}${accountDeletionEndpoint}`;
  const timeoutMs = input.timeoutMs ?? defaultAccountDeletionTimeoutMs;
  return {
    async deleteAccount() {
      const fetcher = input.fetch
        ?? (globalThis as { readonly fetch?: AccountDeletionFetch }).fetch;
      if (fetcher === undefined) {
        throw new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE');
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE'));
        }, timeoutMs);
      });
      try {
        let headers: Readonly<Record<string, string>>;
        try {
          headers = await Promise.race([
            resolveGameServicesRequestHeaders({
              headers: input.headers,
              getHeaders: input.getHeaders,
            }),
            deadline,
          ]);
        } catch (error) {
          // A resolver that failed (a refresh that could not reach the
          // identity service) sent nothing: retrying may work. A signed-out
          // session resolves without a header and is caught below.
          throw error instanceof AccountDeletionError
            ? error
            : new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE', { cause: error });
        }
        if (!Object.keys(headers).includes('authorization')) {
          throw new AccountDeletionError('UNAUTHORIZED');
        }
        let response: AccountDeletionFetchResponse;
        let text: string;
        try {
          const answer = async (): Promise<[AccountDeletionFetchResponse, string]> => {
            const received = await fetcher(url, {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: '{}',
              signal: controller.signal,
            });
            return [received, await received.text()];
          };
          [response, text] = await Promise.race([answer(), deadline]);
        } catch (error) {
          throw error instanceof AccountDeletionError
            ? error
            : new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE', { cause: error });
        }
        return readAnswer(response, text);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function readAnswer(response: AccountDeletionFetchResponse, text: string): AccountDeletionReceipt {
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
