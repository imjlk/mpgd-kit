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
 * succeeds.
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
  readonly deleted: number;
  readonly retained: number;
}

export interface AccountDeletionReceipt {
  readonly status: 'deleted';
  readonly deletionId: string;
  readonly completedAt: string;
  /** Purchase ledger rows kept, detached from the player, for the retention period. */
  readonly retainedPurchaseRecords: number;
}

export type AccountDeletionErrorCode =
  /** No signed-in session, or a session that no longer authenticates. */
  | 'UNAUTHORIZED'
  /** The request named another player. */
  | 'PLAYER_ID_MISMATCH'
  /** This server has no authentication or identity service for deletion. */
  | 'ACCOUNT_DELETION_NOT_CONFIGURED'
  /** The server failed part way; every step is idempotent, so retrying is safe. */
  | 'ACCOUNT_DELETION_FAILED'
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
   * Erases the player's data, deletes the identity, then erases again: the
   * second pass removes what a request that was already running wrote
   * during the first. Safe to retry after any failure.
   */
  deletePlayerAccount(input: { readonly playerId: string }): Promise<AccountDeletionReceipt>;
}

export function createAccountDeletionService(input: {
  readonly erasers: readonly PlayerDataEraser[];
  /** Required outside local development; without it sessions would survive the deletion. */
  readonly identity?: AccountDeletionIdentity;
  /** Records the audit entry. A failure is logged and does not fail the deletion. */
  readonly audit?: (entry: AccountDeletionAuditEntry) => Promise<void>;
  readonly now?: () => string;
  readonly createDeletionId?: () => string;
}): AccountDeletionService {
  const now = input.now ?? (() => new Date().toISOString());
  const createDeletionId = input.createDeletionId ?? (() => crypto.randomUUID());
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
      if (typeof playerId !== 'string' || playerId.length === 0) {
        throw new AccountDeletionError('UNAUTHORIZED');
      }
      const deletionId = createDeletionId();
      const requestedAt = now();
      const erasure = { playerId, retainedPlayerId: `${retainedPlayerIdPrefix}${deletionId}` };
      let first: PlayerDataErasureResult;
      let second: PlayerDataErasureResult;
      try {
        first = await eraseAll(erasure);
        if (input.identity !== undefined) {
          await input.identity.deletePlayer({ playerId });
        }
        second = await eraseAll(erasure);
      } catch (error) {
        throw new AccountDeletionError('ACCOUNT_DELETION_FAILED', { cause: error });
      }
      const completedAt = now();
      const entry: AccountDeletionAuditEntry = {
        deletionId,
        requestedAt,
        completedAt,
        identity: input.identity === undefined ? 'not-configured' : 'deleted',
        deleted: first.deleted + second.deleted,
        retained: first.retained + second.retained,
      };
      try {
        await input.audit?.(entry);
      } catch (error) {
        // The deletion itself is done; failing here would make the player
        // retry with a session that no longer exists.
        console.error(
          'Account deletion audit entry not recorded:',
          deletionId,
          error instanceof Error ? error.name : 'unknown error',
        );
      }
      return {
        status: 'deleted',
        deletionId,
        completedAt,
        retainedPurchaseRecords: entry.retained,
      };
    },
  };
}

/** The player id stored on a deleted player's kept purchase records. */
export function isRetainedPlayerId(playerId: string): boolean {
  return playerId.startsWith(retainedPlayerIdPrefix);
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
        response.status >= 500 ? 'ACCOUNT_DELETION_FAILED' : 'ACCOUNT_DELETION_UNREACHABLE',
      );
    },
  };
}

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
