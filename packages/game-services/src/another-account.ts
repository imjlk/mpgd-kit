/**
 * Another account's purchase (RFC "Another account's purchase"): a verify
 * whose store binding (Google Play `obfuscatedAccountId` /
 * `obfuscatedProfileId`, StoreKit `appAccountToken`) names another account
 * than the requesting player's. It is not granted, nothing is recorded, and
 * the store transaction stays recoverable by the account it is bound to, so
 * the backend answers it as a retryable error instead of a `rejected`
 * receipt: HTTP 409 `{ error: 'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT', reason }`,
 * or the oRPC error code `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT` (status 409,
 * `data.reason`). A client from before this answer treats it as a transport
 * failure and keeps the record open; the commerce reconciler parks it.
 *
 * No schema, DOM, or transport dependencies: the server, the client, and a
 * game server wrapping the reference verifiers share these helpers.
 */

/** The error code of the answer, on HTTP (`error`) and oRPC (`code`) alike. */
export const purchaseBoundToAnotherAccountCode = 'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT' as const;

/** The HTTP status of the answer: the purchase conflicts with the requesting player's account. */
export const purchaseBoundToAnotherAccountStatus = 409;

/**
 * The binding mismatch reasons of the reference verifiers. Each one means
 * the purchase carries another account's binding: a purchase without one
 * answers `GOOGLE_PLAY_ACCOUNT_ID_MISSING`, `GOOGLE_PLAY_PROFILE_ID_MISSING`,
 * `GOOGLE_PLAY_ACCOUNT_BINDING_UNEXPECTED`, or `APP_STORE_ACCOUNT_TOKEN_MISSING`
 * instead, which stay `rejected`. A backend from before this answer, or a game
 * server that maps every refusal to `rejected`, still answers these reasons
 * as a `rejected` receipt; the commerce reconciler reads that receipt as this
 * answer too.
 */
export const storeAccountMismatchReasons = Object.freeze([
  'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  'GOOGLE_PLAY_PROFILE_MISMATCH',
  'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
] as const);

export type StoreAccountMismatchReason = (typeof storeAccountMismatchReasons)[number];

export function isStoreAccountMismatchReason(
  reason: unknown,
): reason is StoreAccountMismatchReason {
  return typeof reason === 'string'
    && (storeAccountMismatchReasons as readonly string[]).includes(reason);
}

const reasonPattern = /^[A-Za-z0-9_.:-]{1,128}$/u;

function readReason(value: unknown): string | undefined {
  return typeof value === 'string' && reasonPattern.test(value) ? value : undefined;
}

/**
 * Thrown by the reference backend's `verifyPurchase` for another account's
 * purchase; the HTTP handler and the oRPC router turn it into the 409
 * answer. A game server that calls `backend.purchases.verifyPurchase` itself
 * answers it the same way (see `docs/GAME_SERVICES_BACKEND.md`). Its
 * `message` starts with the code, so a Workers RPC caller whose runtime
 * keeps only the message still recognizes it.
 */
export class GameServicesPurchaseBoundToAnotherAccountError extends Error {
  readonly code = purchaseBoundToAnotherAccountCode;
  readonly status = purchaseBoundToAnotherAccountStatus;
  /** The store's binding mismatch, for example `GOOGLE_PLAY_ACCOUNT_MISMATCH`. */
  readonly reason: string;

  constructor(reason: string) {
    const checked = readReason(reason) ?? purchaseBoundToAnotherAccountCode;
    super(`${purchaseBoundToAnotherAccountCode}: ${checked}`);
    this.name = 'GameServicesPurchaseBoundToAnotherAccountError';
    this.reason = checked;
  }
}

/** The body of the HTTP 409 answer. */
export interface PurchaseBoundToAnotherAccountBody {
  readonly error: typeof purchaseBoundToAnotherAccountCode;
  readonly reason: string;
}

export function createPurchaseBoundToAnotherAccountBody(
  reason: string,
): PurchaseBoundToAnotherAccountBody {
  return {
    error: purchaseBoundToAnotherAccountCode,
    reason: readReason(reason) ?? purchaseBoundToAnotherAccountCode,
  };
}

/**
 * The binding mismatch of an error that carries the answer, or undefined for
 * any other error. It reads every shape a client meets: the thrown
 * `GameServicesPurchaseBoundToAnotherAccountError` (an in-process backend),
 * an oRPC error (`code`, `data.reason`), a `GameServicesBackendError` of the
 * HTTP transport (`status` 409 and `body.error`), and an error rebuilt from
 * its message alone (a Workers RPC caller without enhanced error
 * serialization).
 */
export function readPurchaseBoundToAnotherAccount(
  error: unknown,
): { readonly reason: string } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as {
    readonly code?: unknown;
    readonly reason?: unknown;
    readonly data?: unknown;
    readonly status?: unknown;
    readonly body?: unknown;
    readonly message?: unknown;
  };
  const fallback = { reason: purchaseBoundToAnotherAccountCode };
  if (candidate.code === purchaseBoundToAnotherAccountCode) {
    const data = candidate.data;
    const dataReason = typeof data === 'object' && data !== null
      ? readReason((data as { readonly reason?: unknown }).reason)
      : undefined;
    const reason = readReason(candidate.reason) ?? dataReason;
    return reason === undefined ? fallback : { reason };
  }
  const body = candidate.body;
  if (
    candidate.status === purchaseBoundToAnotherAccountStatus
    && typeof body === 'object'
    && body !== null
    && (body as { readonly error?: unknown }).error === purchaseBoundToAnotherAccountCode
  ) {
    const reason = readReason((body as { readonly reason?: unknown }).reason);
    return reason === undefined ? fallback : { reason };
  }
  const message = candidate.message;
  const prefix = `${purchaseBoundToAnotherAccountCode}: `;
  if (typeof message === 'string' && message.startsWith(prefix)) {
    const reason = readReason(message.slice(prefix.length));
    return reason === undefined ? fallback : { reason };
  }
  return undefined;
}
