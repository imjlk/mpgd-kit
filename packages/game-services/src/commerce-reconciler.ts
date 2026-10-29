import type { LogicalProductId, PurchaseResult } from '@mpgd/platform';
import {
  assertCommercePurchaseTransition,
  assertRequestPurchaseSupported,
  CommerceError,
  commerceErrorInfoOf,
  createDerivedPurchaseIdempotencyKey,
  isTerminalCommercePurchaseState,
  summarizeCommercePurchaseState,
  type CommerceCapabilities,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceLogicalProductId,
  type CommerceProvider,
  type CommercePurchaseState,
  type CommercePurchaseSummaryStatus,
  type FetchProductsInput,
  type PurchaseKind,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
  type StorePurchaseAccountBinding,
} from '@mpgd/platform/commerce';

import {
  isStoreAccountMismatchReason,
  readPurchaseBoundToAnotherAccount,
} from './another-account.js';
import type { PurchaseVerificationApi } from './client.js';
import {
  compareCommerceServiceCapabilities,
  type CommerceServiceAlignment,
} from './commerce-evidence-registry.js';
import { chunkLedgerEntryIds } from './commerce-ledger.js';
import type { MonetizationOperationStore } from './monetization-recovery.js';
import type { GameServicesPurchaseInput, GameServicesPurchaseResult } from './operations.js';
import type {
  GameServicesLedgerTarget,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types.js';

/**
 * Commerce v2 reconciler (RFC "Purchase lifecycle", "Reconciler", and
 * "Idempotency keys"). One reconciler per `CommerceProvider` replaces the
 * per-store recovery drivers: it journals every purchase the game starts or
 * the store reports as one record moving through the RFC states, sends the
 * saved verify request to the game backend, and finishes a purchase only after
 * the backend's ledger grant. Nothing here grants: only the backend response
 * moves a record to `granted`, and only the backend ledger moves it to
 * `revoked`.
 */

/** Journal record kind of a commerce v2 purchase. */
export const commercePurchaseOperationKind = 'commerce-purchase' as const;

export type CommercePurchaseOrigin = 'game' | 'discovered';

/**
 * One commerce v2 purchase in the `MonetizationOperationStore`. `key` is the
 * store's global key (`createCommercePurchaseOperationKey`, player-scoped for
 * a durable restored while another player's record holds the shared key); `idempotencyKey`
 * is the purchase key the backend sees: the game's key for a purchase the
 * game started, or the derived key of a purchase discovered from the store.
 * Every state change is its own revision; `request` is saved before the
 * first send and resent unchanged; `response` is the last backend answer.
 */
export interface CommercePurchaseOperationRecord {
  readonly kind: typeof commercePurchaseOperationKind;
  /** The store must enforce uniqueness across users, not just within one account. */
  readonly key: string;
  readonly playerId: string;
  readonly target: string;
  readonly deploymentTarget: string;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly store: StoreId;
  readonly logicalId: LogicalProductId;
  /** Unknown while the catalog cannot be read; a client or host finish waits until it is. */
  readonly productKind?: PurchaseKind;
  readonly origin: CommercePurchaseOrigin;
  readonly state: CommercePurchaseState;
  readonly updatedAt: string;
  /** The game's purchase input; absent for a purchase discovered from the store. */
  readonly input?: GameServicesPurchaseInput;
  /** Full checkout identity, including an optional offer or quantity, bound before launch. */
  readonly checkoutInput?: RequestPurchaseInput;
  readonly purchase?: StorePurchase;
  /** Saved before the first send and resent unchanged on later passes. */
  readonly request?: VerifyPurchaseRequest;
  readonly response?: VerifyPurchaseResponse;
  readonly ledgerEntryId?: string;
  /** A retryable error on `requested` means the provider proved checkout never started. */
  readonly error?: CommerceErrorInfo;
  readonly revokedBy?: string;
  /**
   * The backend answered that the store binds this purchase to another
   * account than this record's player (RFC "Another account's purchase"):
   * `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT`, or a `rejected` receipt with a
   * store binding mismatch reason from a backend before that answer. The
   * record is parked in `verifying`: never sent again automatically, not
   * listed among the player's recoverable records, summarized as `rejected`
   * for this player, and its shared key no longer refuses another player
   * of the install, who journals the purchase under its own player-scoped
   * key. Only this player's Restore Purchases, when the store reports the
   * purchase again, sends it once more.
   */
  readonly anotherAccount?: {
    /** The store's binding mismatch, for example `GOOGLE_PLAY_ACCOUNT_MISMATCH`. */
    readonly reason: string;
    readonly reportedAt: string;
  };
}

/**
 * The store key of a commerce v2 purchase record: one namespace per ledger
 * target, shared by every player of the install. `playerId` names the
 * player-scoped key the reconciler uses only when another player's record
 * already holds the shared key of a durable this player restores (a logout,
 * then the next guest's Restore Purchases on the same install).
 */
export function createCommercePurchaseOperationKey(
  target: string,
  idempotencyKey: string,
  playerId?: string,
): string {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new Error('Commerce purchase operations require a nonempty idempotency key.');
  }
  if (playerId === undefined) {
    return JSON.stringify([target, commercePurchaseOperationKind, idempotencyKey]);
  }
  if (typeof playerId !== 'string' || playerId.trim() === '') {
    throw new Error('A player-scoped commerce purchase key requires a nonempty player id.');
  }
  return JSON.stringify([target, commercePurchaseOperationKind, idempotencyKey, playerId]);
}

export function isCommercePurchaseOperationRecord(
  record: unknown,
): record is CommercePurchaseOperationRecord {
  return typeof record === 'object'
    && record !== null
    && (record as { readonly kind?: unknown }).kind === commercePurchaseOperationKind;
}

/**
 * Summary status of a record: the RFC mapping, with `revoked` kept distinct.
 * A record parked as another account's purchase is `rejected` for its
 * player: nothing was granted to it, and nothing will be.
 */
export function summarizeCommercePurchaseOperation(
  record: CommercePurchaseOperationRecord,
): CommercePurchaseSummaryStatus {
  if (isRetryableBeforeLaunch(record)) {
    return 'failed';
  }
  if (isParkedForAnotherAccount(record)) {
    return 'rejected';
  }
  return summarizeCommercePurchaseState(record.state);
}

/** A `verifying` record the backend answered as another account's purchase. */
export function isParkedForAnotherAccount(record: CommercePurchaseOperationRecord): boolean {
  return record.state === 'verifying' && record.anotherAccount !== undefined;
}

/**
 * Whether another player's record under a shared key leaves the key to this
 * player: parked as another account's purchase, or (a journal written before
 * that answer) `rejected` with a store binding mismatch reason. Either way
 * the purchase was never its player's, and nothing on the backend holds it.
 */
function releasesSharedKey(record: CommercePurchaseOperationRecord): boolean {
  return isParkedForAnotherAccount(record)
    || (record.state === 'rejected'
      && record.response !== undefined
      && !record.response.verified
      && isStoreAccountMismatchReason(record.response.reason));
}

function isRetryableBeforeLaunch(record: CommercePurchaseOperationRecord): boolean {
  return record.state === 'requested' && record.error?.retryable === true
    && record.purchase === undefined && record.request === undefined;
}

/**
 * Only `granted` and `finishing` records that hold the backend's ledger entry
 * id and a store transaction may be finished. The StoreKit SDK keeps no
 * finish allow-list of its own (the removed v1 driver paired transactions in
 * `finishGrantedTransaction`), so this is the finish gate for every `client`
 * and `host` owner: the ledger entry id comes from the journal revision the
 * backend grant wrote. The one other finish call is a `finished` consumable a
 * `client` store reports again, finished with the same journaled ledger entry
 * (see `finishReportedAgain` in `createCommerceReconciler`).
 */
export function assertCommerceFinishAllowed(
  record: CommercePurchaseOperationRecord,
): { readonly transactionId: string; readonly ledgerEntryId: string } {
  if (record.state !== 'granted' && record.state !== 'finishing') {
    throw new Error(
      `Commerce purchase ${record.idempotencyKey} is ${record.state}; only granted or finishing records are finished.`,
    );
  }
  const ledgerEntryId = record.ledgerEntryId;
  const transactionId = record.purchase?.transactionId;
  if (typeof ledgerEntryId !== 'string' || ledgerEntryId.trim() === '') {
    throw new Error(
      `Commerce purchase ${record.idempotencyKey} has no ledger entry id; the backend grant must finish it.`,
    );
  }
  if (typeof transactionId !== 'string' || transactionId.trim() === '') {
    throw new Error(
      `Commerce purchase ${record.idempotencyKey} has no store transaction to finish.`,
    );
  }
  return { transactionId, ledgerEntryId };
}

/** The `GameServicesPurchaseResult` a journal record stands for; `pending` allows no client-side grant. */
export function toGameServicesPurchaseResult(
  record: CommercePurchaseOperationRecord,
): GameServicesPurchaseResult {
  const status = summarizeCommercePurchaseOperation(record);
  return {
    status,
    purchase: toPurchaseResult(record),
    ...(record.response === undefined ? {} : { verification: record.response }),
    ...(record.ledgerEntryId === undefined ? {} : { ledgerEntryId: record.ledgerEntryId }),
  };
}

function toPurchaseResult(record: CommercePurchaseOperationRecord): PurchaseResult {
  const purchase = record.purchase;
  if (record.state === 'cancelled' || record.state === 'failed' || isRetryableBeforeLaunch(record)) {
    return {
      status: record.state === 'cancelled' ? 'cancelled' : 'failed',
      entitlementIds: [],
      ...(record.error === undefined ? {} : { diagnostic: toDiagnostic(record.error) }),
    };
  }
  if (purchase === undefined) {
    return { status: 'pending', entitlementIds: [] };
  }
  return {
    status: purchase.state === 'purchased' ? 'completed' : 'pending',
    transactionId: purchase.transactionId,
    entitlementIds: [],
    evidence: purchase.evidence,
  };
}

function toDiagnostic(error: CommerceErrorInfo): NonNullable<PurchaseResult['diagnostic']> {
  const providerCode = error.storeCode;
  return {
    code: error.code,
    retryable: error.retryable,
    ...(providerCode !== undefined && /^[A-Za-z0-9_.:-]{1,128}$/u.test(providerCode)
      ? { providerCode }
      : {}),
  };
}

// Reconciler.

/** A catalog entry the reconciler resolves kinds and SKUs from without a store read. */
export interface CommerceReconcilerProduct {
  readonly logicalId: LogicalProductId;
  readonly kind: PurchaseKind;
  readonly storeSku?: string;
}

export type CommerceReconcilerFailureStage =
  | 'capabilities'
  | 'available'
  | 'catalog'
  | 'match'
  | 'journal'
  | 'verify'
  | 'finish'
  | 'ledger-status'
  | 'restore'
  /** `sessionCheck` refused: the reconciler's player is not the session's now. */
  | 'session';

export type CommerceReconcilerEvent =
  | {
      readonly type: 'transition';
      readonly record: CommercePurchaseOperationRecord;
      /** Undefined when the record was just reserved. */
      readonly previous: CommercePurchaseState | undefined;
    }
  | { readonly type: 'verify-requested'; readonly record: CommercePurchaseOperationRecord }
  | {
      readonly type: 'verify-result';
      readonly record: CommercePurchaseOperationRecord;
      readonly response: VerifyPurchaseResponse;
    }
  | {
      /**
       * The backend answered the record's verify as another account's
       * purchase (RFC "Another account's purchase"): the record is parked,
       * nothing was granted, and it is not a failure. `response` is the
       * receipt of a backend before that answer (`rejected` with a store
       * binding mismatch reason); absent for the 409 answer.
       */
      readonly type: 'another-account';
      readonly record: CommercePurchaseOperationRecord;
      readonly reason: string;
      readonly response?: VerifyPurchaseResponse;
    }
  | {
      readonly type: 'failure';
      readonly stage: CommerceReconcilerFailureStage;
      readonly idempotencyKey?: string;
      readonly error: unknown;
    };

export interface CreateCommerceReconcilerInput {
  readonly provider: CommerceProvider;
  /** The game backend; `getPurchaseLedgerStatus` enables the revocation pass once the server exposes it (C2). */
  readonly backend: PurchaseVerificationApi;
  /** Durable, compare-and-swap journal shared with the recoverable monetization client's rewarded-ad records. */
  readonly store: MonetizationOperationStore;
  readonly playerId: string;
  /** Ledger target sent as `VerifyPurchaseRequest.target`. */
  readonly target: GameServicesLedgerTarget;
  readonly deploymentTarget?: string;
  /**
   * Catalog mapping consulted before `fetchProducts`; required for a provider
   * whose product list cannot be read before the first purchase.
   */
  readonly products?: readonly CommerceReconcilerProduct[];
  readonly now?: () => string;
  readonly onEvent?: (event: CommerceReconcilerEvent) => void;
  /**
   * How long a `launched` record with no store purchase keeps serializing
   * purchases of its product. After it the attempt is `failed` with
   * `OUTCOME_UNKNOWN`; a purchase the store reports later is journaled under
   * its derived key. Defaults to 24 hours; `Infinity` keeps the RFC rule
   * without expiry.
   */
  readonly staleLaunchedAfterMs?: number;
  /**
   * Minimum time before an event-triggered pass retries a record's backend
   * or store step: resending a backend-pending request, a verify or finish
   * that failed in transport, a finalization re-read, or a catalog lookup.
   * An explicit trigger (`start`, `reconcile`, `restorePurchases`) always
   * retries. Defaults to one minute; `0` retries on every pass.
   */
  readonly retryIntervalMs?: number;
  /**
   * How long a running store call keeps its product serialized and its
   * events waiting. A call that has not answered after this (a store sheet
   * that never settles) stops deferring: events for the product are
   * reconciled as they come and a new purchase of it may start. Defaults to
   * ten minutes.
   */
  readonly inFlightTimeoutMs?: number;
  /**
   * How long the backend's `getCommerceCapabilities` read may take at start
   * and on explicit passes before the last comparison is kept. Defaults to
   * ten seconds.
   */
  readonly serviceCapabilitiesTimeoutMs?: number;
  /**
   * Whether the reconciler may act for `playerId` right now; an error says
   * why not (`createGameServicesRuntime` passes its session player check).
   * It is read synchronously before every pass, before each queued event and
   * each record a pass handles, before a store read, restore, or finish, and
   * for a purchase at its start, right before its record is reserved, and
   * right before the store UI opens. A refusal never ends a record: a pass stops with the
   * journal as it is and the events still queued (a `failure` event with
   * stage `session` reports it), a purchase answers the error with no store
   * UI (a reserved attempt stays retryable), and `restorePurchases` rejects
   * with it. So one player's journaled purchases are never verified,
   * restored, or finished while another player's session headers or account
   * binding are current. Return a retryable `CommerceError`.
   */
  readonly sessionCheck?: () => CommerceError | undefined;
  /**
   * Whether the reconciler's owner closed for good (`createGameServicesRuntime`
   * passes its disposed or player-changed state). Read synchronously when
   * `start()` is called and again right before it subscribes (after the
   * journal read): while it answers true, `start()` subscribes nothing and
   * starts nothing, and resolves without an error. So a caller that reaches
   * `start()` after `stop()` (a recovery pass that outlived its owner's
   * dispose), or a start that was still reading the journal when its owner
   * stopped waiting for it, leaves no store subscription.
   * Unlike `sessionCheck`, a signed-out session is not closed: the reconciler
   * still subscribes then and its work waits for the session. Omitted, a
   * stopped reconciler can be started again.
   */
  readonly closed?: () => boolean;
  /**
   * This player's store account binding: the value the store provider binds
   * the player's new purchases to (Google Play's obfuscated account id,
   * StoreKit's app account token). A store purchase the journal does not
   * hold yet whose binding names another account is another player's: it is
   * reported (stage `match`) and left alone, never journaled or verified for
   * this player (a backend would reject it for good as an account mismatch,
   * and its derived key would then block that player's own recovery). The
   * player's explicit Restore Purchases pass still takes a durable bound to
   * another account (restore sharing). A purchase without a binding, or with
   * a binding of another kind, is not compared. Answer `undefined` (or
   * throw) only transiently, while this player's binding cannot be read
   * yet: a bound purchase reported then is kept and asked about again on
   * the next pass (a resume, an event, an explicit trigger). A runtime for a store or target whose purchases this player's
   * binding never covers must omit the input; omitted, nothing is compared.
   */
  readonly accountBinding?: () =>
    | StorePurchaseAccountBinding
    | undefined
    | Promise<StorePurchaseAccountBinding | undefined>;
}

export const defaultStaleLaunchedAfterMs = 24 * 60 * 60 * 1000;
/** How long one backend capabilities read may take before the last comparison is kept. */
export const defaultServiceCapabilitiesTimeoutMs = 10 * 1000;

/** `compareCommerceServiceCapabilities`'s answer, or `unpublished` for a backend without the read. */
export type CommerceReconcilerServiceAlignment =
  | CommerceServiceAlignment
  | { readonly status: 'unpublished'; readonly store: StoreId };
export const defaultRetryIntervalMs = 60 * 1000;
export const defaultInFlightTimeoutMs = 10 * 60 * 1000;

export interface CommerceReconciler {
  readonly provider: CommerceProvider;
  readonly started: boolean;
  /**
   * The last comparison of the provider's capabilities with the backend's
   * published ones (RFC "Provider capabilities endpoint"); undefined until
   * the first read, or when the backend offers no `getCommerceCapabilities`
   * (`unpublished` once a backend answered that it has no such read). While
   * it is `configuration-required`, the capabilities this reconciler reports
   * carry that availability and `requestPurchase` refuses with
   * `CONFIGURATION_REQUIRED`; a purchase never opens the store before the
   * comparison was attempted.
   */
  readonly serviceAlignment: CommerceReconcilerServiceAlignment | undefined;
  /** The provider's capability block with the backend alignment applied to `availability`. */
  getCapabilities(): Promise<CommerceCapabilities>;
  /** Subscribe to the provider, read its available purchases when declared, then reconcile until idle. */
  start(): Promise<void>;
  /** Unsubscribe and drop in-memory state; the journal keeps every record. */
  stop(): Promise<void>;
  /** One reconcile pass (the app-resume trigger), then any passes that events arriving meanwhile trigger. */
  reconcile(): Promise<void>;
  /** Reconcile while a trigger is pending; a no-op when stopped. */
  runUntilIdle(): Promise<void>;
  /** The manual restore trigger: `provider.restorePurchases` when offered, then a pass over the available purchases. */
  restorePurchases(): Promise<void>;
  /** Journals the attempt, opens the store once per key, and reconciles the result. Never reopens the store UI for a journaled key. */
  requestPurchase(input: RequestPurchaseInput): Promise<RequestPurchaseResult>;
  fetchProducts(input?: FetchProductsInput): Promise<readonly StoreProduct[]>;
  /** The record journaled under a purchase idempotency key. */
  read(idempotencyKey: string): Promise<CommercePurchaseOperationRecord | undefined>;
  /** The player's open records for this provider's store. */
  listRecoverable(): Promise<readonly CommercePurchaseOperationRecord[]>;
  subscribe(listener: (event: CommerceReconcilerEvent) => void): () => void;
}

type OpenState = Extract<CommercePurchaseState, 'launched' | 'pending'>;

function isOpen(state: CommercePurchaseState): state is OpenState {
  return state === 'launched' || state === 'pending';
}

/** The backend's answer for a restore past the restore sharing holder limit (RFC "Restore sharing"). */
const purchaseHolderLimitReason = 'PURCHASE_HOLDER_LIMIT_REACHED';

/**
 * A backend-pending record that only the player's Restore Purchases resends:
 * a restore the backend answered `pending` at the holder limit. Nothing a
 * pass can observe frees a holder, so an automatic resend would repeat the
 * same answer on every launch, resume, and event; an explicit restore may
 * find a holder freed (a deleted player, a reversed grant).
 */
function waitsForRestoreTrigger(record: CommercePurchaseOperationRecord): boolean {
  return record.state === 'pending'
    && record.response !== undefined
    && !record.response.verified
    && record.response.reason === purchaseHolderLimitReason;
}

/** A backend answer that the capabilities read does not exist: HTTP 404 or oRPC NOT_FOUND. */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { status, code } = error as { readonly status?: unknown; readonly code?: unknown };
  return status === 404 || code === 'NOT_FOUND';
}

export function createCommerceReconciler(input: CreateCommerceReconcilerInput): CommerceReconciler {
  const { provider, backend, store: journal, playerId } = input;
  const storeId = provider.store;
  const target = input.target;
  const deploymentTarget = input.deploymentTarget ?? input.target;
  const now = input.now ?? (() => new Date().toISOString());
  const staleLaunchedAfterMs = input.staleLaunchedAfterMs ?? defaultStaleLaunchedAfterMs;
  const retryIntervalMs = input.retryIntervalMs ?? defaultRetryIntervalMs;
  const inFlightTimeoutMs = input.inFlightTimeoutMs ?? defaultInFlightTimeoutMs;
  const serviceCapabilitiesTimeoutMs = input.serviceCapabilitiesTimeoutMs
    ?? defaultServiceCapabilitiesTimeoutMs;
  if (!Number.isFinite(serviceCapabilitiesTimeoutMs) || serviceCapabilitiesTimeoutMs <= 0) {
    throw new RangeError('serviceCapabilitiesTimeoutMs must be a positive finite duration.');
  }
  if (typeof playerId !== 'string' || playerId.trim() === '') {
    throw new TypeError('The commerce reconciler requires an authenticated player id.');
  }
  if (!(staleLaunchedAfterMs > 0)) {
    throw new RangeError('staleLaunchedAfterMs must be a positive duration.');
  }
  if (!(retryIntervalMs >= 0)) {
    throw new RangeError('retryIntervalMs must be a non-negative duration.');
  }
  if (!(inFlightTimeoutMs > 0)) {
    throw new RangeError('inFlightTimeoutMs must be a positive duration.');
  }

  const listeners = new Set<(event: CommerceReconcilerEvent) => void>();
  if (input.onEvent !== undefined) {
    listeners.add(input.onEvent);
  }
  const emit = (event: CommerceReconcilerEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Observers have no authority over the journal.
      }
    }
  };
  const fail = (
    stage: CommerceReconcilerFailureStage,
    error: unknown,
    idempotencyKey?: string,
  ): void => {
    emit({
      type: 'failure',
      stage,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      error,
    });
  };

  /** Records seen this session by purchase idempotency key, terminal ones included for matching. */
  const records = new Map<string, CommercePurchaseOperationRecord>();
  const inbox: CommerceEvent[] = [];
  /** The start-time read of the available purchases failed; the next pass retries it. */
  let initialScanPending = false;
  /**
   * Purchase calls whose store call is still running, by key and product; a
   * `requested` record outside this map is stale, and events for these
   * products wait until the call journals the store answer.
   */
  const inFlightKeys = new Map<string, { readonly logicalId: LogicalProductId; readonly since: number }>();
  const nowMs = (): number => Date.parse(now());
  const isInFlight = (idempotencyKey: string): boolean => {
    const entry = inFlightKeys.get(idempotencyKey);
    return entry !== undefined && nowMs() - entry.since < inFlightTimeoutMs;
  };
  const inFlightProducts = (): Set<LogicalProductId> =>
    new Set(
      [...inFlightKeys.entries()]
        .filter(([key]) => isInFlight(key))
        .map(([, entry]) => entry.logicalId),
    );
  /** Events for an in-flight product, replayed by the pass after the call ends. */
  const deferred: CommerceEvent[] = [];
  const defer = (event: CommerceEvent): void => {
    // A polled provider lists the same purchase on every pass; keep one copy.
    if (
      event.type === 'purchaseUpdated'
      && deferred.some(
        (waiting) =>
          waiting.type === 'purchaseUpdated'
          && waiting.purchase.transactionId === event.purchase.transactionId
          && waiting.purchase.state === event.purchase.state,
      )
    ) {
      return;
    }
    deferred.push(event);
  };
  /** Earliest time (ms) an event-triggered pass may retry a record's backend or store step. */
  const retryAt = new Map<string, number>();
  const retryLater = (idempotencyKey: string): void => {
    retryAt.set(idempotencyKey, nowMs() + retryIntervalMs);
  };
  /**
   * The same store purchase: the transaction id, or the token when the store
   * renames the transaction (Play reports the token key until it assigns an
   * order id). A store whose ids are unique among unfinished purchases only
   * (Microsoft Store reuses the add-on id) relies on the provider deriving a
   * transaction-unique id; until then a repurchase that the store lists under
   * a finished record's id is journaled only when the game started it.
   */
  const samePurchase = (left: StorePurchase, right: StorePurchase): boolean =>
    left.transactionId === right.transactionId
    || (left.token !== undefined && left.token === right.token);
  const productCache = new Map<string, CommerceReconcilerProduct>();
  let capabilities: CommerceCapabilities | undefined;
  let serviceAlignment: CommerceReconcilerServiceAlignment | undefined;
  /** A backend that answered 404 / NOT_FOUND for the ledger status read: not asked again. */
  let ledgerStatusUnpublished = false;
  /** Serializes the backend capabilities read so overlapping triggers share one. */
  let serviceAlignmentRead: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let started = false;
  /** The start in progress, so overlapping calls share one subscription. */
  let starting: Promise<void> | undefined;
  let triggerPending = false;
  let running: Promise<void> | undefined;
  let pendingFailure: { readonly error: unknown } | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  /** Passes and purchase requests never interleave their journal writes. */
  function withLock<T>(job: () => Promise<T>): Promise<T> {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  }

  const trigger = (): void => {
    triggerPending = true;
  };

  /** The session check's refusal, if any; a check that throws refuses too. */
  const sessionRefusal = (): CommerceError | undefined => {
    if (input.sessionCheck === undefined) {
      return undefined;
    }
    try {
      return input.sessionCheck();
    } catch (error) {
      return new CommerceError('ACCOUNT_BINDING_REQUIRED', {
        retryable: true,
        message: `The session check failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  /** True (and reported) when the reconciler must not act for its player now. */
  const sessionBlocked = (idempotencyKey?: string): boolean => {
    const refusal = sessionRefusal();
    if (refusal === undefined) {
      return false;
    }
    fail('session', refusal, idempotencyKey);
    return true;
  };

  const ownsRecord = (record: CommercePurchaseOperationRecord): boolean =>
    record.playerId === playerId
    && record.target === target
    && record.deploymentTarget === deploymentTarget
    && record.store === storeId;

  /**
   * Another player's record of this store under a shared key: on one install
   * the derived key of a store purchase is the same for every player, so the
   * player who journaled it first holds that key.
   */
  const heldByAnotherPlayer = (record: unknown): boolean =>
    isCommercePurchaseOperationRecord(record)
    && record.playerId !== playerId
    && record.target === target
    && record.store === storeId;

  const remember = (record: CommercePurchaseOperationRecord): CommercePurchaseOperationRecord => {
    records.set(record.idempotencyKey, record);
    return record;
  };

  /**
   * The provider's capability block. Event-triggered passes use the last read;
   * an explicit trigger (`start`, `reconcile`, `restorePurchases`, a new purchase) reads it
   * again, since availability can change at runtime. A failed read keeps the
   * last block.
   */
  const withServiceAlignment = (
    block: CommerceCapabilities | undefined,
  ): CommerceCapabilities | undefined =>
    block === undefined || serviceAlignment?.status !== 'configuration-required'
      ? block
      : { ...block, availability: 'configuration-required' };

  const readCapabilities = async (refresh = false): Promise<CommerceCapabilities | undefined> => {
    if (capabilities !== undefined && !refresh) {
      return withServiceAlignment(capabilities);
    }
    try {
      capabilities = await provider.getCapabilities();
    } catch (error) {
      fail('capabilities', error);
    }
    return withServiceAlignment(capabilities);
  };

  /**
   * Compares the provider with the backend's published capabilities when the
   * backend offers them: a store the backend does not accept, or a finish
   * owner that disagrees, sets availability to `configuration-required`
   * before any purchase UI opens. A failed read keeps the last comparison.
   */
  const readServiceAlignment = async (): Promise<void> => {
    const readService = backend.getCommerceCapabilities;
    if (
      readService === undefined
      || capabilities === undefined
      || serviceAlignment?.status === 'unpublished'
    ) {
      return;
    }
    if (serviceAlignmentRead !== undefined) {
      return serviceAlignmentRead;
    }
    const providerBlock = capabilities;
    serviceAlignmentRead = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const service = await Promise.race([
          readService.call(backend),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error('The backend commerce capabilities read timed out.'));
            }, serviceCapabilitiesTimeoutMs);
          }),
        ]);
        serviceAlignment = compareCommerceServiceCapabilities({
          store: storeId,
          provider: providerBlock,
          service,
        });
        if (serviceAlignment.status === 'configuration-required') {
          fail(
            'capabilities',
            new CommerceError('CONFIGURATION_REQUIRED', {
              message: serviceAlignment.message,
              storeCode: serviceAlignment.reason,
            }),
          );
        }
      } catch (error) {
        if (isNotFoundError(error)) {
          // A v1 backend behind a v2 client adapter: it publishes nothing, and
          // that is remembered rather than read again on every refresh.
          serviceAlignment = { status: 'unpublished', store: storeId };
          return;
        }
        // A failed or timed-out read keeps the last comparison.
        fail('capabilities', error);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        serviceAlignmentRead = undefined;
      }
    })();
    return serviceAlignmentRead;
  };

  const resolveProduct = async (
    lookup: { readonly logicalId: string } | { readonly storeSku: string },
  ): Promise<CommerceReconcilerProduct | undefined> => {
    const matches = (product: CommerceReconcilerProduct): boolean =>
      'logicalId' in lookup
        ? product.logicalId === lookup.logicalId
        : product.storeSku === lookup.storeSku;
    const configured = input.products?.find(matches);
    if (configured !== undefined) {
      return configured;
    }
    const cached = [...productCache.values()].find(matches);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const products = await provider.fetchProducts(
        'logicalId' in lookup
          ? { logicalIds: [lookup.logicalId as CommerceLogicalProductId] }
          : { type: 'all' },
      );
      for (const product of products) {
        productCache.set(product.logicalId, {
          logicalId: product.logicalId,
          kind: product.kind,
          storeSku: product.storeSku,
        });
      }
      return [...productCache.values()].find(matches);
    } catch (error) {
      fail('catalog', error);
      return undefined;
    }
  };

  const resolveLogicalId = async (
    purchase: StorePurchase,
  ): Promise<{ readonly logicalId: LogicalProductId; readonly kind?: PurchaseKind } | undefined> => {
    const product = purchase.logicalId === undefined
      ? await resolveProduct({ storeSku: purchase.storeSku })
      : await resolveProduct({ logicalId: purchase.logicalId });
    if (product === undefined) {
      if (purchase.logicalId !== undefined) {
        // The provider mapped the SKU itself. The kind stays unknown until the
        // catalog answers: a client or host finish never guesses consumable.
        return { logicalId: purchase.logicalId };
      }
      return undefined;
    }
    return { logicalId: product.logicalId, kind: product.kind };
  };

  const write = async (
    record: CommercePurchaseOperationRecord,
    state: CommercePurchaseState,
    patch: Partial<CommercePurchaseOperationRecord> = {},
  ): Promise<CommercePurchaseOperationRecord> => {
    assertCommercePurchaseTransition(record.state, state);
    const next: CommercePurchaseOperationRecord = {
      ...record,
      ...patch,
      state,
      revision: record.revision + 1,
      updatedAt: now(),
    };
    await journal.replace(record.revision, next);
    remember(next);
    retryAt.delete(next.idempotencyKey);
    emit({ type: 'transition', record: next, previous: record.state });
    return next;
  };

  /**
   * Reserves the record under `key`: the shared key of its idempotency key
   * unless `resolveSlot` chose this player's player-scoped one.
   */
  const reserve = async (
    record: Omit<CommercePurchaseOperationRecord, 'kind' | 'key' | 'playerId' | 'target' | 'deploymentTarget' | 'revision' | 'updatedAt'>,
    key: string = createCommercePurchaseOperationKey(target, record.idempotencyKey),
  ): Promise<{ readonly created: boolean; readonly record: CommercePurchaseOperationRecord }> => {
    const candidate: CommercePurchaseOperationRecord = {
      ...record,
      kind: commercePurchaseOperationKind,
      key,
      playerId,
      target,
      deploymentTarget,
      revision: 0,
      updatedAt: now(),
    };
    const reserved = await journal.reserve(candidate);
    if (!isCommercePurchaseOperationRecord(reserved.record)) {
      throw new Error('Commerce purchase operation key is bound to another operation kind.');
    }
    if (!ownsRecord(reserved.record)) {
      throw new Error('Commerce purchase operation key is bound to another player or store.');
    }
    remember(reserved.record);
    if (reserved.created) {
      emit({ type: 'transition', record: reserved.record, previous: undefined });
    }
    return { created: reserved.created, record: reserved.record };
  };

  // Revising a refused pre-launch attempt does not change its lifecycle state.
  // Keep the identity durable, and clear the refusal before a deliberate retry.
  const reviseRequestedError = async (
    record: CommercePurchaseOperationRecord,
    error: CommerceErrorInfo | undefined,
  ): Promise<CommercePurchaseOperationRecord> => {
    const { error: _previousError, ...rest } = record;
    const next: CommercePurchaseOperationRecord = {
      ...rest,
      ...(error === undefined ? {} : { error }),
      revision: record.revision + 1,
      updatedAt: now(),
    };
    await journal.replace(record.revision, next);
    remember(next);
    retryAt.delete(record.idempotencyKey);
    return next;
  };

  /**
   * Parks a `verifying` record the backend answered as another account's
   * purchase, or (`marker` undefined) lets this player's Restore Purchases
   * send it again. The state stays `verifying`: the record is not ended for
   * the store transaction, which its account can still recover.
   */
  const reviseAnotherAccount = async (
    record: CommercePurchaseOperationRecord,
    marker: CommercePurchaseOperationRecord['anotherAccount'],
    patch: Partial<CommercePurchaseOperationRecord> = {},
  ): Promise<CommercePurchaseOperationRecord> => {
    const { anotherAccount: _previous, ...rest } = record;
    const next: CommercePurchaseOperationRecord = {
      ...rest,
      ...patch,
      ...(marker === undefined ? {} : { anotherAccount: marker }),
      state: record.state,
      revision: record.revision + 1,
      updatedAt: now(),
    };
    await journal.replace(record.revision, next);
    remember(next);
    retryAt.delete(record.idempotencyKey);
    return next;
  };

  /**
   * Where this player's record of an idempotency key lives, and what that key
   * holds now. A record is under the shared key, or under this player's
   * player-scoped key, which only the player's Restore Purchases takes, for a
   * durable another player journaled first (`ingestPurchase`). The scoped key
   * is read only where such a record can be, so a journal is never asked for
   * one on a game key or a consumable:
   *
   * - `takeHeld`: when another player's record holds the shared key, the
   *   scoped key is the slot. Without it, another player's record is what
   *   the slot holds, and `recordIn` refuses it.
   * - `probeFree`: when the shared key is free, a record under the scoped key
   *   still answers (retention may have dropped the other player's record).
   *
   * Another player's record that was answered as another account's purchase
   * (`releasesSharedKey`) is never this player's to refuse: the scoped key is
   * the slot for any kind, as with `takeHeld`, so the purchase's own account
   * recovers it on the same install.
   */
  const resolveSlot = async (
    idempotencyKey: string,
    options: { readonly takeHeld?: boolean; readonly probeFree?: boolean } = {},
  ): Promise<{ readonly key: string; readonly found: unknown; readonly heldByAnother: boolean }> => {
    const sharedKey = createCommercePurchaseOperationKey(target, idempotencyKey);
    const shared = await journal.read(sharedKey);
    const heldByAnother = shared !== undefined && heldByAnotherPlayer(shared);
    const probeScoped = heldByAnother
      ? options.takeHeld === true
        || (isCommercePurchaseOperationRecord(shared) && releasesSharedKey(shared))
      : shared === undefined && options.probeFree === true;
    if (!probeScoped) {
      return { key: sharedKey, found: shared, heldByAnother };
    }
    const scopedKey = createCommercePurchaseOperationKey(target, idempotencyKey, playerId);
    const scoped = await journal.read(scopedKey);
    return scoped !== undefined || heldByAnother
      ? { key: scopedKey, found: scoped, heldByAnother }
      : { key: sharedKey, found: undefined, heldByAnother };
  };

  /** This player's record in a slot; another player's or another store's is refused. */
  const recordIn = (
    slot: { readonly found: unknown },
    idempotencyKey: string,
  ): CommercePurchaseOperationRecord | undefined => {
    const found = slot.found;
    if (found === undefined) {
      return records.get(idempotencyKey);
    }
    if (!isCommercePurchaseOperationRecord(found) || !ownsRecord(found)) {
      throw new Error('Commerce purchase operation key is bound to another player or store.');
    }
    return remember(found);
  };

  /**
   * This player's record of a purchase idempotency key, under the shared key
   * or its player-scoped key. A key another player's record holds is refused,
   * so another player's consumable, subscription, or game-started attempt is
   * never matched, sent, or replayed for this player.
   */
  const readRecord = async (
    idempotencyKey: string,
  ): Promise<CommercePurchaseOperationRecord | undefined> =>
    recordIn(await resolveSlot(idempotencyKey), idempotencyKey);

  const ownedRecordsOf = (
    listed: readonly unknown[],
  ): CommercePurchaseOperationRecord[] =>
    listed.filter(
      (record): record is CommercePurchaseOperationRecord =>
        isCommercePurchaseOperationRecord(record) && ownsRecord(record),
    );

  /**
   * The player's open records. One parked as another account's purchase is
   * kept in memory, so a store report matches it without the journal's
   * transaction index, but is not the player's to recover.
   */
  const listRecoverable = async (): Promise<CommercePurchaseOperationRecord[]> =>
    ownedRecordsOf(await journal.listRecoverable(playerId))
      .filter((record) => !isTerminalCommercePurchaseState(record.state))
      .map(remember)
      .filter((record) => !isParkedForAnotherAccount(record));

  const listGranted = async (): Promise<CommercePurchaseOperationRecord[]> => {
    const listed = journal.listGranted === undefined
      ? []
      : ownedRecordsOf(await journal.listGranted(playerId)).map(remember);
    const granted = new Map<string, CommercePurchaseOperationRecord>();
    for (const record of [...listed, ...records.values()]) {
      if (
        record.ledgerEntryId !== undefined
        && (record.state === 'granted' || record.state === 'finishing' || record.state === 'finished')
      ) {
        granted.set(record.idempotencyKey, record);
      }
    }
    return [...granted.values()];
  };

  const loadRecords = async (): Promise<void> => {
    await listRecoverable();
    if (journal.listGranted !== undefined) {
      ownedRecordsOf(await journal.listGranted(playerId)).forEach(remember);
    }
  };

  const openRecordsFor = (logicalId: string | undefined): CommercePurchaseOperationRecord[] =>
    [...records.values()].filter(
      (record) =>
        record.store === storeId
        && (logicalId === undefined || record.logicalId === logicalId)
        && isOpen(record.state),
    );

  const listener = (event: CommerceEvent): void => {
    if (event.type === 'subscriptionUpdated') {
      return;
    }
    inbox.push(event);
    trigger();
    scheduleRun();
  };

  /**
   * Reads the store's available purchases into the inbox. `restore` is the
   * player's Restore Purchases read only: the store also lists owned
   * non-consumables its recovery list hides (acknowledged on Play, bound to
   * another guest's token on StoreKit), so a reinstall or a new device can
   * restore them. Startup and resume recovery never set it, so an
   * acknowledged durable is not sent again on every launch.
   */
  const readAvailable = async (
    capabilitiesNow: CommerceCapabilities,
    restore = false,
  ): Promise<boolean> => {
    if (!capabilitiesNow.lifecycle.availablePurchases) {
      return true;
    }
    if (sessionBlocked()) {
      // Another player's store account may be current: nothing is read into
      // this player's journal, and the next permitted pass reads again.
      return false;
    }
    const read = async (withRestore: boolean): Promise<void> => {
      const available = await provider.getAvailablePurchases({
        includePending: capabilitiesNow.lifecycle.pending,
        ...(withRestore ? { restore: true } : {}),
      });
      for (const purchase of available) {
        inbox.push({ type: 'purchaseUpdated', purchase });
      }
    };
    try {
      await read(restore);
      return true;
    } catch (error) {
      if (!restore) {
        fail('available', error);
        return false;
      }
      // A failed restore read still makes the recovery read, so Restore
      // Purchases never finds less than a recovery pass: a bridge host built
      // before `restore` rejects the field, and a store may fail only the
      // wider read. The restore failure is still reported.
      fail('available', error);
      try {
        await read(false);
        return true;
      } catch (fallbackError) {
        fail('available', fallbackError);
        return false;
      }
    }
  };

  const buildRequest = (
    record: CommercePurchaseOperationRecord,
  ): VerifyPurchaseRequest => {
    const purchase = record.purchase;
    if (purchase === undefined) {
      throw new Error(
        `Commerce purchase ${record.idempotencyKey} is purchased without a purchase.`,
      );
    }
    return {
      // The ledger target names the deployment platform; `store` names the
      // store the purchase was made in (RFC "Open store ids"). A v1 server
      // ignores `store` and keeps mapping the target.
      target,
      store: storeId,
      ...(deploymentTarget === target ? {} : { deploymentTarget }),
      playerId,
      productId: record.logicalId,
      platformTransactionId: purchase.transactionId,
      idempotencyKey: record.idempotencyKey,
      purchasedAt: purchase.purchasedAt ?? now(),
      evidence: purchase.evidence,
      // A purchase the store reported without this journal starting it (a
      // reinstall, a new device, Restore Purchases) is a restore: the backend
      // may grant this player a non-consumable bound to another guest (RFC
      // "Restore sharing"). A purchase the game started never asks for it.
      ...(record.origin === 'discovered' ? { intent: 'restore' as const } : {}),
    };
  };

  /** Whether a store purchase is bound to another account than this player's (`accountBinding`). */
  const accountOf = async (purchase: StorePurchase): Promise<'own' | 'another' | 'unknown'> => {
    const bound = purchase.accountBinding;
    if (input.accountBinding === undefined || bound?.value === undefined) {
      return 'own';
    }
    let own: StorePurchaseAccountBinding | undefined;
    try {
      own = await input.accountBinding();
    } catch {
      own = undefined;
    }
    if (own?.value === undefined) {
      // This player's binding cannot be read now: the purchase cannot be shown to be theirs yet.
      return 'unknown';
    }
    if (own.kind !== bound.kind) {
      return 'own';
    }
    const normalize = (value: string): string =>
      bound.kind === 'app-account-token' ? value.toLowerCase() : value;
    return normalize(own.value) === normalize(bound.value) ? 'own' : 'another';
  };

  /** Transactions `finishReportedAgain` already finished again this session. */
  const finishedAgain = new Set<string>();
  /**
   * A client-finish store reports a consumable only while it is unfinished,
   * so one reported again after its record finished was never finished in
   * the store: its finish was reported done without a native call (a lost
   * acknowledgement the store's list could not tell apart from an
   * unverifiable entry or a list read too early), or the store re-delivered
   * it. It is finished again with the ledger entry the grant wrote, once per
   * session (a call that failed in transport is tried again on the next
   * report); it is never verified or granted again (the ledger replays a key
   * and refuses the same evidence under another one). Durables, which a
   * store keeps listing after their finish, and other finish owners are left
   * alone. It needs the finished record: past the journal's retention the
   * transaction takes the derived-key path, where the reference backend
   * answers a `client`-finish consumable with this player's recorded grant
   * (never a second one), and the record finishes it like any grant.
   */
  const finishReportedAgain = async (
    record: CommercePurchaseOperationRecord,
    kind: PurchaseKind | undefined,
  ): Promise<void> => {
    const ledgerEntryId = record.ledgerEntryId;
    const transactionId = record.purchase?.transactionId;
    if (
      (record.productKind ?? kind) !== 'consumable'
      || capabilities?.lifecycle.finish !== 'client'
      || provider.finishTransaction === undefined
      || ledgerEntryId === undefined
      || ledgerEntryId.trim() === ''
      || transactionId === undefined
      || transactionId.trim() === ''
      || finishedAgain.has(transactionId)
    ) {
      return;
    }
    if (sessionBlocked(record.idempotencyKey)) {
      // The session changed while the report was matched: the next report asks again.
      return;
    }
    finishedAgain.add(transactionId);
    try {
      const { finished } = await provider.finishTransaction({
        transactionId,
        ledgerEntryId,
        isConsumable: true,
      });
      if (!finished) {
        // The store refused it (for StoreKit: revoked or another token); the
        // next session asks again. The record stays finished.
        fail(
          'finish',
          new Error(`The store did not finish ${transactionId} it reported again.`),
          record.idempotencyKey,
        );
      }
    } catch (error) {
      // Transport-class failure: the next report of the transaction tries again.
      finishedAgain.delete(transactionId);
      fail('finish', error, record.idempotencyKey);
    }
  };

  /**
   * A store report of a record the backend answered as another account's
   * purchase. Only this player's Restore Purchases asks again (a restore
   * sharing policy or a binding may have changed since), with the evidence
   * the store reports now, so a stale saved request (an expired signed
   * transaction) is not resent, and as a restore, which the player asked
   * for (restore sharing may cover a durable the game started, too); other
   * reports leave it parked. It stays parked until the backend answers
   * something else: a transport failure (an offline Restore) changes
   * nothing, so the record never becomes an open attempt that serializes the
   * player's purchases or holds the shared key against the purchase's
   * account. Another answer unparks it and settles it as a verify does; a
   * grant is finished by the pass's recoverable records.
   */
  const reportParked = async (
    record: CommercePurchaseOperationRecord,
    purchase: StorePurchase,
    restoring: boolean,
  ): Promise<void> => {
    if (!restoring || purchase.state !== 'purchased') {
      return;
    }
    const request: VerifyPurchaseRequest = {
      ...buildRequest({ ...record, purchase }),
      intent: 'restore',
    };
    const refreshed = await reviseAnotherAccount(record, record.anotherAccount, {
      purchase,
      request,
    });
    const answer = await sendVerify(refreshed, request);
    if (answer === undefined) {
      return;
    }
    if (answer.kind === 'another-account') {
      await parkForAnotherAccount(refreshed, request, answer);
      return;
    }
    await settleVerify(await reviseAnotherAccount(refreshed, undefined), request, answer.response);
  };

  /**
   * The journal's current record of a parked record this session holds, or
   * undefined (and forgotten) when the journal no longer holds it for this
   * player.
   */
  const rereadParked = async (
    record: CommercePurchaseOperationRecord,
  ): Promise<CommercePurchaseOperationRecord | undefined> => {
    const current = await journal.read(record.key);
    if (current !== undefined && isCommercePurchaseOperationRecord(current) && ownsRecord(current)) {
      return remember(current);
    }
    records.delete(record.idempotencyKey);
    return undefined;
  };

  // Reconciler step 2: match a reported purchase to a journal record.
  const ingestPurchase = async (purchase: StorePurchase, restoring: boolean): Promise<void> => {
    if (purchase.store !== storeId) {
      fail(
        'match',
        new Error(
          `Purchase ${purchase.transactionId} belongs to store ${purchase.store}, not ${storeId}.`,
        ),
      );
      return;
    }
    const product = await resolveLogicalId(purchase);
    if (product === undefined) {
      fail(
        'catalog',
        new Error(
          `Purchase ${purchase.transactionId} names SKU ${purchase.storeSku}, which no catalog entry declares.`,
        ),
      );
      return;
    }
    let record = [...records.values()].find(
      (candidate) =>
        candidate.store === storeId
        && candidate.purchase !== undefined
        && samePurchase(candidate.purchase, purchase),
    );
    if (record === undefined && journal.findByTransaction !== undefined) {
      // A terminal record of this transaction (finished, rejected) is not in
      // memory after a restart; the journal index keeps it from being
      // verified again under a derived key.
      const stored = await journal.findByTransaction({
        playerId,
        target,
        deploymentTarget,
        store: storeId,
        transactionId: purchase.transactionId,
      });
      if (stored !== undefined && isCommercePurchaseOperationRecord(stored) && ownsRecord(stored)) {
        record = remember(stored);
      }
    }
    if (record !== undefined && isParkedForAnotherAccount(record) && restoring) {
      // Restore Purchases writes the record, so it must still be the journal's:
      // a journal's retention may have dropped a parked record this session
      // still holds (RFC "Another account's purchase"). Then the report is a
      // purchase the journal does not know, and is matched as one.
      record = await rereadParked(record);
    }
    if (record !== undefined && isParkedForAnotherAccount(record)) {
      await reportParked(record, purchase, restoring);
      return;
    }
    const account = record !== undefined || (restoring && product.kind === 'durable')
      ? 'own'
      : await accountOf(purchase);
    if (account === 'unknown') {
      // Not decided yet: the report waits for the next pass, which asks again.
      defer({ type: 'purchaseUpdated', purchase });
      fail(
        'match',
        new Error(
          `Purchase ${purchase.transactionId} waits: this player's store account binding could not be read.`,
        ),
      );
      return;
    }
    if (account === 'another') {
      // Another player's purchase (Play lists unacknowledged purchases of
      // every app account on the device): neither attached to this player's
      // open attempt nor journaled under a derived key.
      fail(
        'match',
        new Error(
          `Purchase ${purchase.transactionId} is bound to another store account; it is left for that player.`,
        ),
      );
      return;
    }
    if (record === undefined) {
      const open = openRecordsFor(product.logicalId);
      if (open.length > 1) {
        fail(
          'match',
          new Error(
            `Purchase ${purchase.transactionId} matches ${open.length} open records for ${product.logicalId}.`,
          ),
          open[0]?.idempotencyKey,
        );
        return;
      }
      record = open[0];
      if (record?.purchase !== undefined && !samePurchase(record.purchase, purchase)) {
        // The open attempt already holds another transaction (store-side or
        // backend-side pending): this is a second purchase of the product.
        record = undefined;
      }
    }
    if (record === undefined) {
      if (purchase.state === 'revoked') {
        // Revoked store states never revoke on their own: only the ledger does (step 5).
        return;
      }
      const idempotencyKey = await createDerivedPurchaseIdempotencyKey({
        store: purchase.store,
        transactionId: purchase.transactionId,
        token: purchase.token,
      });
      // The derived key is the same for every player of the install. On the
      // player's Restore Purchases pass, a durable another player journaled
      // first (a logout, then this player's restore) is this player's own
      // restore, journaled under its player-scoped key; the backend keys the
      // grant by player and key. Automatic passes, and any other kind held by
      // another player, stay refused: a purchase a normal read lists for the
      // earlier player (Play lists an unacknowledged one whoever is signed in)
      // is never shared without the player asking, and one player's
      // consumable is never sent for another.
      const durable = product.kind === 'durable';
      const slot = await resolveSlot(idempotencyKey, {
        takeHeld: restoring && durable,
        probeFree: durable,
      });
      record = recordIn(slot, idempotencyKey);
      if (
        record !== undefined
        && isParkedForAnotherAccount(record)
        && record.logicalId === product.logicalId
        && record.purchase !== undefined
        && samePurchase(record.purchase, purchase)
      ) {
        // Found under its derived key only (a journal without the
        // transaction index): the same rule as a transaction match.
        await reportParked(record, purchase, restoring);
        return;
      }
      if (
        record !== undefined
        && (record.logicalId !== product.logicalId
          || (record.purchase !== undefined && !samePurchase(record.purchase, purchase)))
      ) {
        // A game key that happens to equal the derived key names another
        // attempt; the purchase is never attached to it.
        fail(
          'match',
          new Error(
            `Purchase ${purchase.transactionId} derives key ${idempotencyKey}, which journals another attempt.`,
          ),
          idempotencyKey,
        );
        return;
      }
      if (record === undefined) {
        await reserve(
          {
            idempotencyKey,
            store: purchase.store,
            logicalId: product.logicalId,
            ...(product.kind === undefined ? {} : { productKind: product.kind }),
            origin: 'discovered',
            state: purchase.state,
            purchase,
          },
          slot.key,
        );
        return;
      }
    }
    if (record.state === 'finished' && purchase.state === 'purchased') {
      await finishReportedAgain(record, product.kind);
      return;
    }
    if (purchase.state === 'pending' && record.state === 'launched') {
      await write(record, 'pending', { purchase });
      return;
    }
    if (
      purchase.state === 'purchased'
      && (record.state === 'launched' || (record.state === 'pending' && record.request === undefined))
    ) {
      await write(record, 'purchased', { purchase });
    }
  };

  const ingestError = async (
    logicalId: CommerceLogicalProductId | undefined,
    error: CommerceErrorInfo,
  ): Promise<void> => {
    if (error.code === 'OUTCOME_UNKNOWN' || error.code === 'ALREADY_OWNED') {
      // Not terminal for an attempt: an unfinished purchase may exist, so the
      // record stays open and the available purchases resolve it.
      return;
    }
    if (logicalId === undefined) {
      // An unattributed error cannot be bound to one attempt; the available
      // purchases or the launched-attempt expiry decide it.
      return;
    }
    // Only an attempt the store never answered can end on an error event: a
    // record holding a store purchase or a saved verify request is decided by
    // the available purchases and the backend, never by a later error.
    const open = openRecordsFor(logicalId).filter(
      (record) => record.purchase === undefined && record.request === undefined,
    );
    if (open.length > 1) {
      fail(
        'match',
        new Error(
          `purchaseError${logicalId === undefined ? '' : ` for ${logicalId}`} matches ${open.length} open records.`,
        ),
      );
      return;
    }
    const record = open[0];
    if (record !== undefined) {
      await write(record, error.code === 'USER_CANCELLED' ? 'cancelled' : 'failed', { error });
    }
  };

  const staleAttemptError = (message: string): CommerceErrorInfo => ({
    code: 'OUTCOME_UNKNOWN',
    retryable: false,
    message,
  });

  /**
   * The backend's answer: a response, another account's purchase (the
   * `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT` error, or a `rejected` receipt with a
   * store binding mismatch reason from a backend before it), or undefined
   * for a transport failure.
   */
  const sendVerify = async (
    record: CommercePurchaseOperationRecord,
    request: VerifyPurchaseRequest,
  ): Promise<
    | { readonly kind: 'response'; readonly response: VerifyPurchaseResponse }
    | {
        readonly kind: 'another-account';
        readonly reason: string;
        readonly response?: VerifyPurchaseResponse;
      }
    | undefined
  > => {
    emit({ type: 'verify-requested', record });
    let response: VerifyPurchaseResponse;
    try {
      response = await backend.verifyPurchase(request);
    } catch (error) {
      const anotherAccount = readPurchaseBoundToAnotherAccount(error);
      if (anotherAccount !== undefined) {
        // An answer, not a failure: the caller parks the record and reports it.
        return { kind: 'another-account', reason: anotherAccount.reason };
      }
      // Transport failure: the state is kept and the next pass resends the saved request.
      fail('verify', error, record.idempotencyKey);
      return undefined;
    }
    emit({ type: 'verify-result', record, response });
    if (
      !response.verified
      && response.disposition !== 'pending'
      && isStoreAccountMismatchReason(response.reason)
    ) {
      return { kind: 'another-account', reason: response.reason, response };
    }
    return { kind: 'response', response };
  };

  /**
   * Parks a `verifying` record the backend answered as another account's
   * purchase and reports it with an `another-account` event (not a failure).
   */
  const parkForAnotherAccount = async (
    record: CommercePurchaseOperationRecord,
    request: VerifyPurchaseRequest,
    answer: { readonly reason: string; readonly response?: VerifyPurchaseResponse },
  ): Promise<void> => {
    const parked = await reviseAnotherAccount(
      record,
      { reason: answer.reason, reportedAt: now() },
      { request, ...(answer.response === undefined ? {} : { response: answer.response }) },
    );
    emit({
      type: 'another-account',
      record: parked,
      reason: answer.reason,
      ...(answer.response === undefined ? {} : { response: answer.response }),
    });
  };

  /**
   * Journals the backend's answer to a `verifying` record: `pending` or
   * `rejected`, or `granted` (returned) for a grant that carries its ledger
   * entry; a malformed grant is reported and the record kept.
   */
  const settleVerify = async (
    record: CommercePurchaseOperationRecord,
    request: VerifyPurchaseRequest,
    response: VerifyPurchaseResponse,
  ): Promise<CommercePurchaseOperationRecord | undefined> => {
    if (!response.verified) {
      if (response.disposition === 'pending') {
        await write(record, 'pending', { request, response });
        retryLater(record.idempotencyKey);
      } else {
        await write(record, 'rejected', { request, response });
      }
      return undefined;
    }
    const ledgerEntryId = response.ledgerEntryId;
    if (typeof ledgerEntryId !== 'string' || ledgerEntryId.trim() === '') {
      fail(
        'verify',
        new Error(`A verified response for ${record.idempotencyKey} must carry a ledgerEntryId.`),
        record.idempotencyKey,
      );
      return undefined;
    }
    return write(record, 'granted', { request, response, ledgerEntryId });
  };

  // Reconciler steps 3 and 4: drive one record as far as the backend and the store allow.
  const drive = async (
    initial: CommercePurchaseOperationRecord,
    capabilitiesNow: CommerceCapabilities | undefined,
    explicit: boolean,
  ): Promise<void> => {
    let record = initial;
    /** Finalization the grant of this drive reported; a later pass re-reads it from the backend. */
    let finalization: 'pending' | 'completed' | undefined;
    const waitUntil = retryAt.get(record.idempotencyKey);
    if (!explicit && waitUntil !== undefined && nowMs() < waitUntil) {
      // An unrelated store event does not retry a backend or store step
      // inside the interval; an explicit trigger always does.
      return;
    }
    try {
      for (;;) {
        if (sessionBlocked(record.idempotencyKey)) {
          // The record stays as journaled for this player's next permitted pass.
          return;
        }
        switch (record.state) {
          case 'requested':
            if (isRetryableBeforeLaunch(record)) {
              // Only an explicit same-key purchase retries a proven unopened
              // checkout; recovery must never open a payment surface itself.
              return;
            }
            if (isInFlight(record.idempotencyKey)) {
              return;
            }
            // The store answer was never journaled (a crash or a lost write
            // after the reservation): the attempt ends so the product is not
            // serialized behind it; a purchase the store reports later is
            // journaled under its derived key.
            await write(record, 'failed', {
              error: staleAttemptError(
                `The store answer for ${record.idempotencyKey} was never journaled.`,
              ),
            });
            return;
          case 'launched': {
            if (record.purchase !== undefined || isInFlight(record.idempotencyKey)) {
              return;
            }
            const age = Date.parse(now()) - Date.parse(record.updatedAt);
            if (Number.isFinite(age) && age > staleLaunchedAfterMs) {
              await write(record, 'failed', {
                error: staleAttemptError(
                  `No store purchase was reported for ${record.idempotencyKey} within ${String(staleLaunchedAfterMs)} ms.`,
                ),
              });
            }
            return;
          }
          case 'purchased':
            record = await write(record, 'verifying', {
              request: record.request ?? buildRequest(record),
            });
            continue;
          case 'pending':
            if (record.request === undefined) {
              // Store-side pending: waiting on the store, never sent.
              return;
            }
            record = await write(record, 'verifying');
            continue;
          case 'verifying': {
            if (isParkedForAnotherAccount(record)) {
              // Another account's purchase: only this player's Restore
              // Purchases sends it again (`ingestPurchase`).
              return;
            }
            const request = record.request ?? buildRequest(record);
            const answer = await sendVerify(record, request);
            if (answer === undefined) {
              retryLater(record.idempotencyKey);
              return;
            }
            if (answer.kind === 'another-account') {
              // Not this player's, and not ended for the store transaction:
              // never sent again on its own, and the shared key is left to
              // the purchase's account (RFC "Another account's purchase").
              await parkForAnotherAccount(record, request, answer);
              return;
            }
            const granted = await settleVerify(record, request, answer.response);
            if (granted === undefined) {
              return;
            }
            finalization = answer.response.finalization?.status;
            record = granted;
            continue;
          }
          case 'granted':
            if (capabilitiesNow === undefined) {
              return;
            }
            if (capabilitiesNow.lifecycle.finish === 'none') {
              await write(record, 'finished');
              return;
            }
            record = await write(record, 'finishing');
            continue;
          case 'finishing': {
            if (capabilitiesNow === undefined) {
              return;
            }
            const owner = capabilitiesNow.lifecycle.finish;
            if (owner === 'none') {
              await write(record, 'finished');
              return;
            }
            if (owner === 'server') {
              let reread: VerifyPurchaseResponse | undefined;
              if (finalization === undefined) {
                // A pass that did not grant resends the saved request to read
                // finalization; the backend replays the grant, never a second one.
                const answer = await sendVerify(record, record.request ?? buildRequest(record));
                reread = answer?.kind === 'response' ? answer.response : undefined;
                finalization = reread?.verified === true
                  ? reread.finalization?.status
                  : undefined;
              }
              if (finalization === 'completed') {
                // The re-read is the last backend answer the record reports.
                await write(record, 'finished', reread === undefined ? {} : { response: reread });
              } else {
                retryLater(record.idempotencyKey);
              }
              return;
            }
            const finish = assertCommerceFinishAllowed(record);
            if (provider.finishTransaction === undefined) {
              fail(
                'finish',
                new Error(`The provider declares finish '${owner}' but has no finishTransaction.`),
                record.idempotencyKey,
              );
              return;
            }
            // A consume and an acknowledge are not interchangeable: the finish
            // waits until the catalog says which kind the product is.
            const kind = record.productKind
              ?? (await resolveProduct({ logicalId: record.logicalId }))?.kind;
            if (kind === undefined) {
              fail(
                'catalog',
                new Error(
                  `The kind of ${record.logicalId} is unknown; the finish waits for the catalog.`,
                ),
                record.idempotencyKey,
              );
              retryLater(record.idempotencyKey);
              return;
            }
            if (sessionBlocked(record.idempotencyKey)) {
              return;
            }
            let finished = false;
            try {
              finished = (await provider.finishTransaction({
                transactionId: finish.transactionId,
                ledgerEntryId: finish.ledgerEntryId,
                isConsumable: kind === 'consumable',
                // A record already `finishing` when this drive began was asked
                // to finish before (an earlier attempt or session): a `client`
                // store may read a consumable gone from its unfinished list as
                // that finish's lost acknowledgement. A first finish never is,
                // and a provider that does not declare the field never gets it.
                ...(owner === 'client'
                    && initial.state === 'finishing'
                    && provider.acceptsFinishRetry === true
                  ? { retry: true }
                  : {}),
              })).finished;
            } catch (error) {
              // Transport-class failure: keep `finishing` for the next pass.
              fail('finish', error, record.idempotencyKey);
              retryLater(record.idempotencyKey);
              return;
            }
            if (finished) {
              await write(record, 'finished');
            } else {
              retryLater(record.idempotencyKey);
            }
            return;
          }
          default:
            return;
        }
      }
    } catch (error) {
      // A journal write that lost its compare-and-swap, or a malformed record:
      // the next pass reads the stored revision again.
      fail('journal', error, record.idempotencyKey);
    }
  };

  // Reconciler step 5: reversed grants move to revoked. Needs the backend's
  // ledger status read (C2); without it the hook is inert.
  const revokeReversed = async (): Promise<void> => {
    const ledgerStatus = backend.getPurchaseLedgerStatus;
    if (ledgerStatus === undefined || ledgerStatusUnpublished) {
      return;
    }
    const granted = await listGranted();
    if (granted.length === 0) {
      return;
    }
    const ledgerEntryIds = [...new Set(granted.flatMap((record) =>
      (record.ledgerEntryId === undefined ? [] : [record.ledgerEntryId])))];
    const statuses: { readonly ledgerEntryId: string; readonly status: string; readonly reversedBy?: string }[] = [];
    try {
      // Reads are chunked to what a backend store accepts in one query.
      for (const chunk of chunkLedgerEntryIds(ledgerEntryIds)) {
        const response = await ledgerStatus.call(backend, { ledgerEntryIds: chunk, playerId });
        statuses.push(...response.statuses);
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        // A pre-C2 backend behind a transport adapter that always exposes the
        // read: the hook stays inert, as it is for a backend without it.
        ledgerStatusUnpublished = true;
        return;
      }
      fail('ledger-status', error);
      return;
    }
    for (const record of granted) {
      const status = statuses.find((candidate) => candidate.ledgerEntryId === record.ledgerEntryId);
      if (status?.status !== 'reversed') {
        continue;
      }
      try {
        await write(record, 'revoked', {
          ...(status.reversedBy === undefined ? {} : { revokedBy: status.reversedBy }),
        });
      } catch (error) {
        fail('journal', error, record.idempotencyKey);
      }
    }
  };

  interface PassOptions {
    /** A start, reconcile, or restore trigger, as opposed to a store event. */
    readonly explicit: boolean;
    readonly refreshCapabilities: boolean;
    /**
     * The Restore Purchases trigger: a polled provider's read in this pass is
     * a restore read (`GetAvailablePurchasesInput.restore`).
     */
    readonly restore?: boolean;
    /**
     * The pass the player's Restore Purchases runs, whichever read it made:
     * the only pass that resends a restore pending at the holder limit.
     */
    readonly restoreTrigger?: boolean;
  }

  const eventPass: PassOptions = { explicit: false, refreshCapabilities: false };

  const pass = async (options: PassOptions): Promise<void> => {
    if (sessionBlocked()) {
      // Queued events wait for a pass the session permits.
      return;
    }
    let capabilitiesNow = await readCapabilities(options.refreshCapabilities);
    if (options.refreshCapabilities) {
      await readServiceAlignment();
      capabilitiesNow = withServiceAlignment(capabilities);
    }
    // A provider without lifecycle.events is polled: every pass reads its
    // available purchases. An event provider whose start-time read failed is
    // read again until it succeeds, so a purchase that predates the
    // subscription is not missed for the session.
    if (capabilitiesNow !== undefined && (!capabilitiesNow.lifecycle.events || initialScanPending)) {
      initialScanPending = !(await readAvailable(capabilitiesNow, options.restore === true))
        && capabilitiesNow.lifecycle.events;
    }
    // An event for a product whose store call is still running waits for that
    // call to journal the store answer: matched then, it is never journaled
    // twice, and a cancel event ends the attempt the call launched.
    const busy = inFlightProducts();
    const queued = [...deferred.splice(0, deferred.length), ...inbox.splice(0, inbox.length)];
    for (const [index, event] of queued.entries()) {
      if (sessionBlocked()) {
        // A purchase reported now may be another player's: it is not
        // journaled under this one; the rest wait, in order.
        inbox.unshift(...queued.slice(index));
        return;
      }
      try {
        if (event.type === 'purchaseUpdated') {
          const product = busy.size === 0 ? undefined : await resolveLogicalId(event.purchase);
          if (product !== undefined && busy.has(product.logicalId)) {
            defer(event);
            continue;
          }
          await ingestPurchase(event.purchase, options.restoreTrigger === true);
        } else if (event.type === 'purchaseError') {
          if (event.logicalId !== undefined && busy.has(event.logicalId)) {
            defer(event);
            continue;
          }
          await ingestError(event.logicalId, event.error);
        }
      } catch (error) {
        fail('journal', error);
      }
    }
    for (const listed of await listRecoverable()) {
      if (sessionBlocked()) {
        return;
      }
      const record = records.get(listed.idempotencyKey) ?? listed;
      if (options.restoreTrigger !== true && waitsForRestoreTrigger(record)) {
        // At the holder limit only the player's Restore Purchases asks again;
        // other passes skip the record before driving it.
        continue;
      }
      await drive(record, capabilitiesNow, options.explicit);
    }
    if (sessionBlocked()) {
      return;
    }
    await revokeReversed();
  };

  const runUntilIdle = async (): Promise<void> => {
    if (running !== undefined) {
      try {
        await running;
      } catch (error) {
        pendingFailure = undefined;
        throw error;
      }
      // An event that landed between the loop's last check and its teardown.
      if (started && triggerPending && running === undefined) {
        await runUntilIdle();
      }
      return;
    }
    if (pendingFailure !== undefined) {
      const failure = pendingFailure;
      pendingFailure = undefined;
      throw failure.error;
    }
    if (!started || !triggerPending) {
      return;
    }
    const loop = (async () => {
      while (started && triggerPending) {
        triggerPending = false;
        await withLock(() => pass(eventPass));
      }
    })();
    running = loop.finally(() => {
      running = undefined;
    });
    await running;
  };
  function scheduleRun(): void {
    runUntilIdle().catch((error: unknown) => {
      pendingFailure = { error };
    });
  }

  const journaled = (record: CommercePurchaseOperationRecord): RequestPurchaseResult => {
    if (isRetryableBeforeLaunch(record) && record.error !== undefined) {
      return { outcome: 'failed', error: record.error };
    }
    if ((record.state === 'cancelled' || record.state === 'failed') && record.error !== undefined) {
      return { outcome: record.state, error: record.error };
    }
    if (record.purchase !== undefined && record.state !== 'requested') {
      return { outcome: 'purchased', purchase: record.purchase };
    }
    return { outcome: 'launched' };
  };

  const failedOutcome = (error: unknown): RequestPurchaseResult => ({
    outcome: 'failed',
    error: commerceErrorInfoOf(error),
  });

  type PreparedRequest =
    | { readonly kind: 'answered'; readonly result: RequestPurchaseResult }
    | {
        readonly kind: 'launch';
        readonly record: CommercePurchaseOperationRecord;
        readonly product: CommerceReconcilerProduct;
      };

  /**
   * Journal work before the store call, under the lock: a journaled key is
   * answered, a product the store does not sell or a provider that is not
   * ready is refused without a record (the key stays usable), an open attempt
   * for the product refuses with IN_PROGRESS without a record, and only a call
   * that will open the store reserves its record.
   */
  const prepareRequest = async (request: RequestPurchaseInput): Promise<PreparedRequest> => {
    if (!started) {
      await loadRecords();
    }
    // A key is never regenerated on retry: the journaled attempt is the answer,
    // and the store UI opens once per key however many calls overlap.
    const existing = await readRecord(request.idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.logicalId !== request.logicalId
        || (existing.input !== undefined && existing.input.source !== request.source)
        || (existing.checkoutInput !== undefined
          && (existing.checkoutInput.offerId !== request.offerId
            || existing.checkoutInput.quantity !== request.quantity))
      ) {
        throw new Error('Purchase idempotency key is bound to another product or source.');
      }
      if (!isRetryableBeforeLaunch(existing) || isInFlight(request.idempotencyKey)) {
        return { kind: 'answered', result: journaled(existing) };
      }
    }
    const capabilitiesNow = await readCapabilities(true);
    if (capabilitiesNow === undefined) {
      return {
        kind: 'answered',
        result: failedOutcome(
          new CommerceError('NOT_PREPARED', {
            message: `The ${storeId} provider capabilities could not be read.`,
          }),
        ),
      };
    }
    if (capabilitiesNow.availability !== 'available') {
      const code = capabilitiesNow.availability === 'configuration-required'
        ? 'CONFIGURATION_REQUIRED'
        : capabilitiesNow.availability === 'action-required'
          ? 'ACTION_REQUIRED'
          : 'STORE_UNAVAILABLE';
      return {
        kind: 'answered',
        result: failedOutcome(
          new CommerceError(code, {
            message: `Store ${storeId} is ${capabilitiesNow.availability}.`,
            retryable: capabilitiesNow.availability === 'temporarily-unavailable',
          }),
        ),
      };
    }
    const product = await resolveProduct({ logicalId: request.logicalId });
    if (product === undefined) {
      return {
        kind: 'answered',
        result: failedOutcome(
          new CommerceError('ITEM_UNAVAILABLE', {
            message: `Store ${storeId} does not sell ${request.logicalId}.`,
          }),
        ),
      };
    }
    if (serviceAlignment === undefined) {
      // A purchase before `start()` finished, or whose start could not read
      // the backend: the comparison is attempted before any store UI opens.
      await readServiceAlignment();
    }
    if (serviceAlignment?.status === 'configuration-required') {
      // The backend does not serve this store as the provider declares it:
      // no store UI opens until the deployment is corrected.
      return {
        kind: 'answered',
        result: failedOutcome(
          new CommerceError('CONFIGURATION_REQUIRED', {
            message: serviceAlignment.message,
            storeCode: serviceAlignment.reason,
          }),
        ),
      };
    }
    // Purchases are serialized per player, store, and logical product: an
    // open attempt for the same product, or one whose store call is still
    // running, refuses this one with IN_PROGRESS, so a reported purchase
    // matches at most one open record.
    const open = (await listRecoverable()).filter(
      (candidate) =>
        candidate.logicalId === product.logicalId
        && (isOpen(candidate.state)
          || (candidate.state === 'requested' && isInFlight(candidate.idempotencyKey))),
    );
    if (open.length > 0) {
      return {
        kind: 'answered',
        result: failedOutcome(new CommerceError('IN_PROGRESS', {
          message: `A purchase of ${product.logicalId} is already in progress (${open[0]?.idempotencyKey}).`,
        })),
      };
    }
    const lateRefusal = sessionRefusal();
    if (lateRefusal !== undefined) {
      // The session changed while the purchase was prepared: nothing is journaled.
      fail('session', lateRefusal, request.idempotencyKey);
      return { kind: 'answered', result: failedOutcome(lateRefusal) };
    }
    const { created, record } = existing === undefined ? await reserve({
      idempotencyKey: request.idempotencyKey,
      store: storeId,
      logicalId: product.logicalId,
      productKind: product.kind,
      origin: 'game',
      state: 'requested',
      checkoutInput: { ...request },
      input: {
        productId: product.logicalId,
        source: request.source,
        idempotencyKey: request.idempotencyKey,
      },
    }) : { created: true, record: await reviseRequestedError(existing, undefined) };
    if (!created) {
      return { kind: 'answered', result: journaled(record) };
    }
    try {
      assertRequestPurchaseSupported(capabilitiesNow, request, product.kind);
    } catch (error) {
      // The store does not sell this kind: a definitive answer the journal keeps.
      const info = commerceErrorInfoOf(error);
      await write(record, 'failed', { error: info });
      return { kind: 'answered', result: { outcome: 'failed', error: info } };
    }
    // Only a call that opens the store is in flight; the entry is released by
    // that call's `finally`, so no refused path can leave a product deferred.
    inFlightKeys.set(request.idempotencyKey, { logicalId: product.logicalId, since: nowMs() });
    return { kind: 'launch', record, product };
  };

  /**
   * Journals what the store answered, under the lock. A journal write that
   * fails here (a stale attempt another pass ended after a very long sheet)
   * is reported; the store answer is still returned to the caller.
   */
  const recordAnswer = async (
    request: RequestPurchaseInput,
    record: CommercePurchaseOperationRecord,
    product: CommerceReconcilerProduct,
    result: RequestPurchaseResult,
    notStarted: boolean,
  ): Promise<RequestPurchaseResult> => {
    try {
      return await journalAnswer(request, record, product, result, notStarted);
    } catch (error) {
      fail('journal', error, record.idempotencyKey);
      return result;
    }
  };

  const journalAnswer = async (
    request: RequestPurchaseInput,
    reserved: CommercePurchaseOperationRecord,
    product: CommerceReconcilerProduct,
    result: RequestPurchaseResult,
    notStarted: boolean,
  ): Promise<RequestPurchaseResult> => {
    // A sheet open past inFlightTimeoutMs may have been ended by a pass as a
    // stale attempt; the journal's answer stands, and a purchase the store
    // reported meanwhile is journaled under its own record.
    const record = (await readRecord(reserved.idempotencyKey)) ?? reserved;
    if (record.state !== 'requested') {
      return journaled(record);
    }
    if (result.outcome === 'launched') {
      await write(record, 'launched');
    } else if (result.outcome === 'purchased') {
      const purchase = result.purchase;
      const launched = await write(record, 'launched');
      const reported = await resolveLogicalId(purchase);
      // A record that journals this transaction and is still open, or that
      // ended after this attempt was reserved, holds the purchase the store
      // just answered with (an event that arrived first). A record that ended
      // before the attempt started is an earlier purchase whose id the store
      // reused (Microsoft Store add-on ids), so this answer is a new purchase.
      const reservedAt = Date.parse(record.updatedAt);
      const holder = [...records.values()].find(
        (candidate) =>
          candidate.idempotencyKey !== record.idempotencyKey
          && candidate.store === storeId
          && candidate.purchase !== undefined
          && samePurchase(candidate.purchase, purchase)
          && (!isTerminalCommercePurchaseState(candidate.state)
            || Date.parse(candidate.updatedAt) > reservedAt),
      );
      if (holder !== undefined) {
        // The transaction is verified once, under the holder's key. This
        // attempt is superseded so the product is not serialized behind it.
        const error = staleAttemptError(
          `Purchase ${purchase.transactionId} is journaled as ${holder.idempotencyKey}; this attempt is superseded.`,
        );
        await write(launched, 'failed', { error });
        return { outcome: 'failed', error };
      }
      if (purchase.store !== storeId || reported?.logicalId !== product.logicalId) {
        // A synchronous answer for another product is not this attempt's
        // purchase; the attempt stays open and the available purchases decide.
        fail(
          'match',
          new Error(
            `The provider answered ${request.idempotencyKey} with purchase ${purchase.transactionId} for ${purchase.store}/${purchase.storeSku}.`,
          ),
          record.idempotencyKey,
        );
        return { outcome: 'launched' };
      }
      if (purchase.state === 'pending') {
        await write(launched, 'pending', { purchase });
      } else if (purchase.state === 'purchased') {
        await write(launched, 'purchased', { purchase });
      }
    } else if (result.outcome === 'failed' && result.error.retryable && notStarted) {
      await reviseRequestedError(record, result.error);
    } else {
      await write(record, result.outcome, { error: result.error });
    }
    return result;
  };

  const requestPurchase = async (request: RequestPurchaseInput): Promise<RequestPurchaseResult> => {
    let result: RequestPurchaseResult;
    // Only the call that reserved the record owns its in-flight entry: a
    // same-key replay must not release it while the store sheet is open.
    let owned = false;
    const refusal = sessionRefusal();
    if (refusal !== undefined) {
      // Nothing is journaled and no store UI opens; the key stays usable.
      fail('session', refusal, request.idempotencyKey);
      return failedOutcome(refusal);
    }
    try {
      const prepared = await withLock(() => prepareRequest(request));
      if (prepared.kind === 'answered') {
        result = prepared.result;
      } else {
        owned = true;
        // The store call runs outside the lock: the sheet may stay open for
        // minutes, and events arriving meanwhile are reconciled right away.
        let answer: RequestPurchaseResult;
        let notStarted = false;
        let presentationSequence = 0;
        const unsubscribePresentation = provider.presentation?.subscribe((event) => {
          if (event.idempotencyKey === request.idempotencyKey && event.sequence > presentationSequence) {
            presentationSequence = event.sequence;
            notStarted = event.state === 'not-started';
          }
        });
        // Checked again with nothing awaited before the store call: the
        // provider binds the purchase to the account current now, which must
        // still be the player this attempt is journaled under.
        const lateRefusal = sessionRefusal();
        if (lateRefusal !== undefined) {
          fail('session', lateRefusal, request.idempotencyKey);
          unsubscribePresentation?.();
          // The store never opened: the reserved attempt stays retryable.
          answer = failedOutcome(lateRefusal);
          notStarted = true;
        } else {
          try {
            answer = await provider.requestPurchase(request);
          } catch (error) {
            answer = failedOutcome(error);
          } finally {
            unsubscribePresentation?.();
          }
          // The provider refuses a missing or foreign account binding before
          // its store UI opens. Refused because the session changed meanwhile,
          // the attempt stays retryable instead of ending.
          const bindingRefusal = answer.outcome === 'failed'
              && answer.error.code === 'ACCOUNT_BINDING_REQUIRED'
            ? sessionRefusal()
            : undefined;
          if (bindingRefusal !== undefined) {
            fail('session', bindingRefusal, request.idempotencyKey);
            answer = failedOutcome(bindingRefusal);
            notStarted = true;
          }
        }
        result = await withLock(() => recordAnswer(request, prepared.record, prepared.product, answer, notStarted));
      }
    } finally {
      if (owned) {
        inFlightKeys.delete(request.idempotencyKey);
      }
    }
    trigger();
    try {
      await runUntilIdle();
    } catch (error) {
      // The store answer is journaled; a pass that failed meanwhile is
      // reported, not thrown at the caller of a purchase already made.
      fail('journal', error, request.idempotencyKey);
    }
    return result;
  };

  return {
    provider,
    get started() {
      return started;
    },
    get serviceAlignment() {
      return serviceAlignment;
    },
    async getCapabilities() {
      const block = await readCapabilities();
      if (block === undefined) {
        throw new CommerceError('NOT_PREPARED', {
          message: `The ${storeId} provider capabilities could not be read.`,
        });
      }
      return block;
    },
    async start() {
      if (started) {
        return;
      }
      if (input.closed?.() === true) {
        // Closed for good: nothing subscribes, and nothing awaits before this
        // check, so a start under way already set `starting` for `stop()`.
        return;
      }
      if (starting !== undefined) {
        return starting;
      }
      starting = (async () => {
        try {
          const subscribed = await withLock(async () => {
            await loadRecords();
            // The owner closed while this start waited for the lock or the
            // journal (its `stop()` may have stopped waiting already): leave
            // as a refused start does, with nothing subscribed or started and
            // no error. The records read stay cached, as after a `reconcile()`
            // before any start. Nothing awaits between this check and the
            // subscription.
            if (input.closed?.() === true) {
              return false;
            }
            // Subscribe first, then read: an event delivered before the listener is found either way.
            unsubscribe = provider.subscribe(listener);
            started = true;
            const capabilitiesNow = await readCapabilities(true);
            await readServiceAlignment();
            // An event-less provider is polled by the first pass instead, so it
            // is read once; a failed read is retried by the next pass.
            initialScanPending = capabilitiesNow === undefined
              || (capabilitiesNow.lifecycle.events && !(await readAvailable(capabilitiesNow)));
            await pass({ explicit: true, refreshCapabilities: false });
            return true;
          });
          if (subscribed) {
            await runUntilIdle();
          }
        } catch (error) {
          // A failed start is retryable: nothing stays subscribed or started.
          started = false;
          unsubscribe?.();
          unsubscribe = undefined;
          triggerPending = false;
          pendingFailure = undefined;
          inbox.length = 0;
          deferred.length = 0;
          records.clear();
          retryAt.clear();
          throw error;
        } finally {
          starting = undefined;
        }
      })();
      return starting;
    },
    async stop() {
      // A start still waiting for the lock subscribes later; let it finish so
      // the teardown below sees its subscription.
      if (starting !== undefined) {
        try {
          await starting;
        } catch {
          // The start cleaned up after itself.
        }
      }
      started = false;
      unsubscribe?.();
      unsubscribe = undefined;
      // Quiesce: a pass awaiting the backend or the store finishes before state is dropped.
      if (running !== undefined) {
        try {
          await running;
        } catch (error) {
          pendingFailure = { error };
        }
      }
      await tail;
      triggerPending = false;
      inbox.length = 0;
      deferred.length = 0;
      records.clear();
      retryAt.clear();
    },
    async reconcile() {
      await withLock(async () => {
        if (!started) {
          await loadRecords();
        }
        await pass({ explicit: true, refreshCapabilities: true });
      });
      await runUntilIdle();
    },
    runUntilIdle,
    async restorePurchases() {
      const refusal = sessionRefusal();
      if (refusal !== undefined) {
        // A store restore (StoreKit's sync, an account sign-in) would run for
        // the account current now, not this reconciler's player.
        fail('session', refusal);
        throw refusal;
      }
      if (provider.restorePurchases !== undefined) {
        try {
          await provider.restorePurchases();
        } catch (error) {
          fail('restore', error);
        }
      }
      await withLock(async () => {
        if (!started) {
          await loadRecords();
        }
        const capabilitiesNow = await readCapabilities(true);
        // A polled provider is read by the pass itself. Either read is a
        // restore read: owned non-consumables the store's recovery list
        // hides (a reinstall, a new device) reach the backend as restores.
        let restoreRead = false;
        if (capabilitiesNow !== undefined && capabilitiesNow.lifecycle.events) {
          restoreRead = await readAvailable(capabilitiesNow, true);
          if (restoreRead) {
            // This read covers a start-time read that failed.
            initialScanPending = false;
          }
        }
        await pass({
          explicit: true,
          refreshCapabilities: false,
          restore: !restoreRead,
          restoreTrigger: true,
        });
      });
      await runUntilIdle();
      const lateRefusal = sessionRefusal();
      if (lateRefusal !== undefined) {
        // The session changed during the restore: the passes stopped early,
        // so it did not finish for this player.
        throw lateRefusal;
      }
    },
    requestPurchase,
    async fetchProducts(request = {}) {
      return provider.fetchProducts(request);
    },
    // A restored durable under this player's player-scoped key answers; any
    // other key another player's record holds is refused as before.
    read: async (idempotencyKey) => {
      const slot = await resolveSlot(idempotencyKey, { takeHeld: true });
      return slot.heldByAnother && slot.found === undefined
        ? readRecord(idempotencyKey)
        : recordIn(slot, idempotencyKey);
    },
    listRecoverable,
    subscribe(listenerToAdd) {
      listeners.add(listenerToAdd);
      return () => {
        listeners.delete(listenerToAdd);
      };
    },
  };
}
