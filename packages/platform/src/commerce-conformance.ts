import {
  assertCommercePurchaseTransition,
  assertRequestPurchaseSupported,
  CommerceError,
  commerceErrorInfoOf,
  createCommerceEventBuffer,
  createDerivedPurchaseIdempotencyKey,
  isTerminalCommercePurchaseState,
  type ActiveSubscription,
  type CommerceBillingAuthority,
  type CommerceCapabilities,
  type CommerceErrorCode,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceEvidenceAuthority,
  type CommerceFinishOwner,
  type CommerceLogicalProductId,
  type CommerceProvider,
  type CommercePurchaseState,
  type CreditBalance,
  type CreditEntitlement,
  type CreditLot,
  type CreditLotSpendScope,
  type CreditOffer,
  type CreditSpendInput,
  type CreditSpendResult,
  type CreditWalletClient,
  type CreditWalletSubscribeInput,
  type FetchProductsInput,
  type FinishTransactionInput,
  type FinishTransactionResult,
  type GetAvailablePurchasesInput,
  type PurchaseKind,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
  type StorePurchaseAccountBinding,
} from './commerce.js';
import type {
  CommerceConformanceCatalogEntry,
  CommerceConformanceErrorFixture,
  CommerceConformanceExpectation,
  CommerceConformanceFinishResultFixture,
  CommerceConformanceLotFixture,
  CommerceConformanceProfile,
  CommerceConformancePurchaseFixture,
  CommerceConformanceRequestResultFixture,
  CommerceConformanceStep,
  CommerceConformanceVector,
  CommerceConformanceVerifyDecision,
} from './commerce-vectors.js';
import {
  addIsoDuration,
  createCreditCommerceProvider,
  createInMemoryCreditWallet,
  normalizeIsoTimestamp,
  type CreditMembershipStartInput,
  type CreditMembershipStartResult,
  type CreditScheduledDebit,
  type CreditSubscriptionEvent,
} from './commerce-wallet.js';
import type { PlatformEvidenceEnvelope } from './index.js';

// The wallet rules moved to `./commerce-wallet` with B7; they stay importable here.
export {
  addIsoDuration,
  compareCreditLotSpendOrder,
  deriveCreditLotSpendScope,
  normalizeIsoTimestamp,
} from './commerce-wallet.js';

/**
 * Commerce v2 conformance runner (RFC "Conformance vectors") with the in-memory
 * reference pieces every vector needs: a fake clock, a fake store with its
 * provider, a fake backend and ledger, an in-memory journal, the reference
 * reconciler runtime, and a reference credit wallet with its provider. Pure
 * in-process code: no Phaser, DOM, network, or SDK imports. Nothing here
 * grants outside the fake ledger, and the fake ledger only writes what a
 * vector scripts through `queueVerify`, `push`, or `revoke`.
 *
 * Store (B-phase) providers run the same vectors by supplying
 * `createProvider` and translating the store actor steps into their own fake
 * SDK; the reconciler, journal, backend, and matcher stay shared. A vector
 * flagged `profile.adaptive` then matches expectations derived from the
 * provider's declared capabilities rather than its fixture profile; see
 * `deriveAdaptiveCommerceConformanceExpectation` and
 * `commerceConformanceAdaptiveSkipReason`.
 */

export const commerceConformanceDefaultPlayerId = 'player-1';
export const commerceConformanceDefaultTitleId = 'title-a';
export const commerceConformanceDefaultClockStart = '2026-10-01T00:00:00Z';

/** An operation the vector did not script; it fails the vector with its message. */
export class CommerceConformanceScriptError extends Error {
  override readonly name = 'CommerceConformanceScriptError';
}

// Clock.

export interface CommerceConformanceClock {
  /** ISO-8601 timestamp of the fake "now". */
  now(): string;
  set(at: string): void;
}

export function createCommerceConformanceClock(
  initial: string = commerceConformanceDefaultClockStart,
): CommerceConformanceClock {
  let current = normalizeIsoTimestamp(initial);
  return {
    now: () => current,
    set(at) {
      current = normalizeIsoTimestamp(at);
    },
  };
}

// Capabilities and fixture filling.

/** Capabilities of a vector profile: omitted blocks default to all supported and `available`. */
export function createCommerceConformanceCapabilities(
  profile: CommerceConformanceProfile,
): CommerceCapabilities {
  return {
    purchase: profile.purchase === undefined
      ? { consumable: true, durable: true, subscription: true, quantity: true }
      : { ...profile.purchase },
    catalog: { products: true, offers: true, localizedPrice: true },
    lifecycle: profile.lifecycle === undefined
      ? { availablePurchases: true, pending: true, restore: true, events: true, finish: 'client' }
      : { ...profile.lifecycle },
    authority: profile.authority === undefined
      ? { evidence: 'client-token', accountBinding: 'optional' }
      : { ...profile.authority },
    availability: 'available',
  };
}

export interface CommerceConformanceFixtureContext {
  readonly profile: CommerceConformanceProfile;
  readonly catalog: readonly CommerceConformanceCatalogEntry[];
  readonly playerId: string;
}

/** Fake evidence for a fixture purchase: `fixture.<store>.v1` carrying the token. */
export function createCommerceConformanceEvidence(
  store: StoreId,
  token: string,
): PlatformEvidenceEnvelope {
  return { schema: `fixture.${store}.v1`, payload: { token } };
}

function createFixtureAccountBinding(
  context: CommerceConformanceFixtureContext,
): StorePurchaseAccountBinding | undefined {
  switch (context.profile.authority?.accountBinding ?? 'optional') {
    case 'required':
      return { kind: 'obfuscated-account-id', value: context.playerId };
    case 'host':
      return { kind: 'host-identity' };
    case 'optional':
      return undefined;
  }
}

/**
 * Fills vector purchase shorthand into a typed `StorePurchase`: the profile's
 * store, quantity 1, the catalog logical id of the SKU, fake evidence, and the
 * account binding the profile's authority block implies.
 */
export function fillCommerceConformancePurchase(
  fixture: CommerceConformancePurchaseFixture,
  context: CommerceConformanceFixtureContext,
): StorePurchase {
  const store = context.profile.store;
  const entry = context.catalog.find((candidate) => candidate.storeSku === fixture.storeSku);
  const accountBinding = createFixtureAccountBinding(context);
  return {
    store,
    transactionId: fixture.transactionId,
    ...(fixture.originalTransactionId === undefined
      ? {}
      : { originalTransactionId: fixture.originalTransactionId }),
    storeSku: fixture.storeSku,
    ...(entry === undefined ? {} : { logicalId: entry.logicalId }),
    quantity: 1,
    state: fixture.state,
    ...(fixture.purchasedAt === undefined ? {} : { purchasedAt: fixture.purchasedAt }),
    token: fixture.token,
    evidence: createCommerceConformanceEvidence(store, fixture.token),
    ...(accountBinding === undefined ? {} : { accountBinding }),
    ...(fixture.settlement === undefined ? {} : { settlement: { ...fixture.settlement } }),
  };
}

export function commerceErrorInfoOfFixture(
  fixture: CommerceConformanceErrorFixture,
): CommerceErrorInfo {
  return {
    code: fixture.code,
    retryable: fixture.retryable,
    ...(fixture.storeCode === undefined ? {} : { storeCode: fixture.storeCode }),
    message: `Commerce operation failed: ${fixture.code}.`,
  };
}

// Fake store.

export interface CommerceConformanceFinishCall {
  readonly by: 'client' | 'host';
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly isConsumable: boolean;
  readonly result: 'finished' | 'unfinished' | CommerceErrorCode;
}

/** The store actor of a vector: scripted answers, store-side events, and store observations. */
export interface CommerceConformanceStoreActor {
  /** Calls that reached the store's purchase UI. */
  readonly purchaseUiOpened: number;
  readonly finishCalls: readonly CommerceConformanceFinishCall[];
  complete(purchase: CommerceConformancePurchaseFixture): void;
  update(purchase: CommerceConformancePurchaseFixture): void;
  error(input: {
    readonly logicalId?: CommerceLogicalProductId;
    readonly error: CommerceConformanceErrorFixture;
  }): void;
  queueRequest(result: CommerceConformanceRequestResultFixture): void;
  queueFinish(result: CommerceConformanceFinishResultFixture): void;
  /** The backend's finalizer consumed the purchase (`lifecycle.finish: 'server'`). */
  finalize?(input: {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
  }): void | Promise<void>;
  /**
   * The `token` this store reports for a fixture purchase when it is not the
   * fixture's own: a host-order store reports the transaction id (RFC "Client
   * contract"). An adaptive run replays the fixture purchases with this token
   * into the reference store, so the derived verify requests carry the token
   * the provider under test reports. Absent, the fixture token is used.
   */
  tokenOf?(purchase: CommerceConformancePurchaseFixture): string;
}

export interface CommerceConformanceStore extends CommerceConformanceStoreActor {
  /** The `CommerceProvider` over this fake store. */
  readonly provider: CommerceProvider;
  /** Purchases the store still reports as unfinished. */
  readonly purchases: readonly StorePurchase[];
  readonly restoreCalls: number;
  /** Removes a purchase from the unfinished list. */
  markFinished(transactionId: string): void;
}

export type CreateCommerceConformanceStoreInput = CommerceConformanceFixtureContext;

/**
 * Fake store: answers `launched` unless a `queueRequest` entry is queued,
 * `{ finished: true }` unless a `queueFinish` entry is queued, lists reported
 * purchases until they are finished, and buffers events emitted before the
 * first listener with `createCommerceEventBuffer`.
 */
export function createCommerceConformanceStore(
  input: CreateCommerceConformanceStoreInput,
): CommerceConformanceStore {
  const capabilities = createCommerceConformanceCapabilities(input.profile);
  const store = input.profile.store;
  const finishOwner = capabilities.lifecycle.finish;
  const purchases: StorePurchase[] = [];
  const requestQueue: CommerceConformanceRequestResultFixture[] = [];
  const finishQueue: CommerceConformanceFinishResultFixture[] = [];
  const finishCalls: CommerceConformanceFinishCall[] = [];
  const buffer = createCommerceEventBuffer();
  let listener: ((event: CommerceEvent) => void) | undefined;
  let purchaseUiOpened = 0;
  let restoreCalls = 0;

  const emit = (event: CommerceEvent): void => {
    // An event-less store reports nothing; the reconciler polls its available list instead.
    if (!capabilities.lifecycle.events) {
      return;
    }
    if (listener === undefined) {
      buffer.push(event);
      return;
    }
    listener(event);
  };
  const upsert = (purchase: StorePurchase): void => {
    const index = purchases.findIndex(
      (candidate) => candidate.transactionId === purchase.transactionId,
    );
    if (index === -1) {
      purchases.push(purchase);
    } else {
      purchases[index] = purchase;
    }
  };
  const remove = (transactionId: string): void => {
    const index = purchases.findIndex((candidate) => candidate.transactionId === transactionId);
    if (index !== -1) {
      purchases.splice(index, 1);
    }
  };
  const report = (fixture: CommerceConformancePurchaseFixture): void => {
    const purchase = fillCommerceConformancePurchase(fixture, input);
    upsert(purchase);
    emit({ type: 'purchaseUpdated', purchase });
  };

  const provider: CommerceProvider = {
    store,
    async getCapabilities() {
      return createCommerceConformanceCapabilities(input.profile);
    },
    async fetchProducts(request) {
      return input.catalog
        .filter((entry) => matchesFetchProducts(entry, request))
        .map((entry): StoreProduct => ({
          logicalId: entry.logicalId,
          store,
          storeSku: entry.storeSku,
          kind: entry.kind,
          title: entry.logicalId,
          description: `Fixture product ${entry.storeSku}`,
          price: { formatted: '$0.99', currencyCode: 'USD', amountMicros: 990_000 },
        }));
    },
    async requestPurchase() {
      purchaseUiOpened += 1;
      const queued = requestQueue.shift();
      if (queued === undefined) {
        return { outcome: 'launched' };
      }
      if (queued.outcome === 'launched') {
        return { outcome: 'launched' };
      }
      if (queued.outcome === 'purchased') {
        const purchase = fillCommerceConformancePurchase(queued.purchase, input);
        upsert(purchase);
        return { outcome: 'purchased', purchase };
      }
      return { outcome: queued.outcome, error: commerceErrorInfoOfFixture(queued.error) };
    },
    async getAvailablePurchases(request: GetAvailablePurchasesInput = {}) {
      if (!capabilities.lifecycle.availablePurchases) {
        return [];
      }
      const includePending = request.includePending ?? false;
      // A revoked purchase is not recoverable; it reaches the runtime through the event path only.
      return purchases.filter(
        (purchase) =>
          purchase.state !== 'revoked' && (includePending || purchase.state !== 'pending'),
      );
    },
    async finishTransaction(request: FinishTransactionInput): Promise<FinishTransactionResult> {
      const by = finishOwner === 'host' ? 'host' : 'client';
      // The vectors record what the store is asked to finish; the `retry`
      // hint is not part of it.
      const call = {
        by,
        transactionId: request.transactionId,
        ledgerEntryId: request.ledgerEntryId,
        isConsumable: request.isConsumable,
      } as const;
      const queued = finishQueue.shift() ?? { finished: true };
      if ('error' in queued) {
        finishCalls.push({ ...call, result: queued.error });
        throw new CommerceError(queued.error, { message: 'Fixture finish failure.' });
      }
      finishCalls.push({ ...call, result: queued.finished ? 'finished' : 'unfinished' });
      if (queued.finished) {
        remove(request.transactionId);
      }
      return { finished: queued.finished };
    },
    async restorePurchases() {
      restoreCalls += 1;
    },
    subscribe(next) {
      if (listener !== undefined) {
        throw new CommerceConformanceScriptError('The fixture store supports one listener at a time.');
      }
      listener = next;
      buffer.drain(next);
      return () => {
        if (listener === next) {
          listener = undefined;
        }
      };
    },
  };

  return {
    provider,
    get purchases() {
      return [...purchases];
    },
    get purchaseUiOpened() {
      return purchaseUiOpened;
    },
    get restoreCalls() {
      return restoreCalls;
    },
    get finishCalls() {
      return [...finishCalls];
    },
    complete: report,
    update: report,
    error(event) {
      emit({
        type: 'purchaseError',
        ...(event.logicalId === undefined ? {} : { logicalId: event.logicalId }),
        error: commerceErrorInfoOfFixture(event.error),
      });
    },
    queueRequest(result) {
      requestQueue.push(result);
    },
    queueFinish(result) {
      finishQueue.push(result);
    },
    finalize(request) {
      remove(request.transactionId);
    },
    markFinished: remove,
  };
}

function matchesFetchProducts(
  entry: { readonly logicalId: CommerceLogicalProductId; readonly kind: PurchaseKind },
  request: FetchProductsInput,
): boolean {
  const type = request.type ?? 'all';
  if (type === 'in-app' && entry.kind === 'subscription') {
    return false;
  }
  if (type === 'subscription' && entry.kind !== 'subscription') {
    return false;
  }
  return request.logicalIds === undefined || request.logicalIds.includes(entry.logicalId);
}

// Fake backend and ledger.

export interface CommerceVerifyRequest {
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly store: StoreId;
  readonly transactionId: string;
  readonly token: string;
  readonly logicalId: CommerceLogicalProductId;
  readonly quantity: number;
  readonly evidence: PlatformEvidenceEnvelope;
  /** `restore` when the player's Restore Purchases sends it; absent means `purchase`. */
  readonly intent?: 'purchase' | 'restore';
}

export interface CommerceVerifyResponse {
  readonly status: 'granted' | 'pending' | 'rejected';
  readonly ledgerEntryId?: string;
  /** Reported for `lifecycle.finish: 'server'` stores. */
  readonly finalization?: 'pending' | 'completed';
  readonly alreadyProcessed?: boolean;
  /** Why a `rejected` receipt refused the purchase. */
  readonly reason?: string;
}

/** The error code of another account's purchase (RFC "Another account's purchase"). */
export const commerceConformanceAnotherAccountCode = 'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT';

/**
 * The store binding mismatch reasons (RFC "Another account's purchase"). A
 * `rejected` receipt with one of them comes from a backend that predates the
 * another-account answer, and a reconciler parks it as that answer.
 */
export const commerceConformanceStoreAccountMismatchReasons: readonly string[] = Object.freeze([
  'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  'GOOGLE_PLAY_PROFILE_MISMATCH',
  'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
]);

/**
 * Thrown by the fake backend for an `another-account` decision: the purchase
 * is bound to another account, nothing is granted or recorded, and the answer
 * is a retryable error rather than a receipt. `transport` is the wire shape the
 * vector names for a runtime under test; the reference reconciler reads the
 * error itself.
 */
export class CommerceConformanceAnotherAccountError extends Error {
  readonly code = commerceConformanceAnotherAccountCode;
  readonly reason: string;
  readonly transport: 'http' | 'orpc' | undefined;

  constructor(reason: string, transport?: 'http' | 'orpc') {
    super(`${commerceConformanceAnotherAccountCode}: ${reason}`);
    this.name = 'CommerceConformanceAnotherAccountError';
    this.reason = reason;
    this.transport = transport;
  }
}

export type CommerceLedgerEntry =
  | {
      readonly entryId: string;
      readonly type: 'grant';
      readonly logicalId: CommerceLogicalProductId;
      readonly store: StoreId;
      readonly transactionId: string;
      readonly idempotencyKey?: string;
      /** Written by the host's fulfillment path rather than a verify call. */
      readonly pushed?: boolean;
    }
  | {
      readonly entryId: string;
      readonly type: 'revoke';
      readonly logicalId: CommerceLogicalProductId;
      readonly reverses: string;
      readonly reason: string;
    };

export interface CommerceLedgerStatus {
  readonly ledgerEntryId: string;
  readonly status: 'active' | 'reversed' | 'unknown';
  readonly reversedBy?: string;
}

/** What the reference runtime needs from a backend. */
export interface CommerceConformanceBackendClient {
  verifyPurchase(request: CommerceVerifyRequest): Promise<CommerceVerifyResponse>;
  getLedgerStatus(ledgerEntryIds: readonly string[]): Promise<readonly CommerceLedgerStatus[]>;
}

export interface CommerceConformanceBackend extends CommerceConformanceBackendClient {
  readonly verifyRequests: readonly CommerceVerifyRequest[];
  readonly ledger: readonly CommerceLedgerEntry[];
  queueVerify(decision: CommerceConformanceVerifyDecision): void;
  /** Writes a server-push grant keyed by transaction id; a retry for the same transaction replays the original entry. */
  push(input: {
    readonly transactionId: string;
    readonly entryId: string;
    readonly logicalId: CommerceLogicalProductId;
    readonly store?: StoreId;
  }): void;
  revoke(input: {
    readonly ledgerEntryId: string;
    readonly entryId: string;
    readonly reason: string;
  }): void;
  /** Grants the ledger still holds active. */
  entitlements(): readonly { readonly id: string; readonly logicalId: CommerceLogicalProductId }[];
}

export interface CreateCommerceConformanceBackendInput {
  /** The server-side finalizer, invoked when a decision reports `finalization: 'completed'`. */
  readonly finalize?: (input: {
    readonly store: StoreId;
    readonly transactionId: string;
    readonly ledgerEntryId: string;
    readonly logicalId: CommerceLogicalProductId;
  }) => void | Promise<void>;
  /**
   * When it returns true, a verify request that replays a key this backend
   * already granted is a finalization re-read (the reference reconciler under a
   * server-owned finish): it is answered `{ granted, ledgerEntryId,
   * finalization: 'completed', alreadyProcessed: true }` from the backend's own
   * grant state and runs the finalizer, consuming no queued decision. Read on
   * every call, so the runner can decide it once the provider's capabilities
   * are known.
   */
  readonly finalizeOnReread?: () => boolean;
}

/**
 * Fake backend: every verify call consumes the next `queueVerify` decision in
 * order and is logged; an unqueued verify is an unscripted operation. A
 * `granted` decision makes sure the ledger holds the entry, so a replayed
 * grant and a host-pushed grant never create a second entry. With
 * `finalizeOnReread`, a replayed granted key is answered as finalized from
 * the backend's own state.
 */
export function createCommerceConformanceBackend(
  input: CreateCommerceConformanceBackendInput = {},
): CommerceConformanceBackend {
  const decisions: CommerceConformanceVerifyDecision[] = [];
  const verifyRequests: CommerceVerifyRequest[] = [];
  const ledger: CommerceLedgerEntry[] = [];
  /** Ledger entry id per granted idempotency key. */
  const grants = new Map<string, string>();

  const findEntry = (entryId: string): CommerceLedgerEntry | undefined =>
    ledger.find((entry) => entry.entryId === entryId);
  const reversalOf = (ledgerEntryId: string): CommerceLedgerEntry | undefined =>
    ledger.find((entry) => entry.type === 'revoke' && entry.reverses === ledgerEntryId);

  return {
    get verifyRequests() {
      return [...verifyRequests];
    },
    get ledger() {
      return [...ledger];
    },
    queueVerify(decision) {
      decisions.push(decision);
    },
    async verifyPurchase(request) {
      verifyRequests.push(request);
      const granted = grants.get(request.idempotencyKey);
      if (
        granted !== undefined
        && reversalOf(granted) === undefined
        && input.finalizeOnReread?.() === true
      ) {
        // The key's own grant answers the re-read: no queued decision is
        // consumed, so a decision scripted for another record stays in place.
        // A reversed grant is not finalized; the re-read falls through to the script.
        await input.finalize?.({
          store: request.store,
          transactionId: request.transactionId,
          ledgerEntryId: granted,
          logicalId: request.logicalId,
        });
        return {
          status: 'granted',
          ledgerEntryId: granted,
          finalization: 'completed',
          alreadyProcessed: true,
        };
      }
      const decision = decisions.shift();
      if (decision === undefined) {
        throw new CommerceConformanceScriptError(
          `Unscripted verify for ${request.idempotencyKey} (${request.store}/${request.transactionId}); `
            + 'queue a backend.queueVerify decision.',
        );
      }
      if (decision.status === 'another-account') {
        throw new CommerceConformanceAnotherAccountError(
          decision.reason ?? commerceConformanceAnotherAccountCode,
          decision.transport,
        );
      }
      if (decision.status !== 'granted') {
        return {
          status: decision.status,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        };
      }
      const ledgerEntryId = decision.ledgerEntryId;
      if (ledgerEntryId === undefined) {
        throw new CommerceConformanceScriptError(
          `A granted decision for ${request.idempotencyKey} must name a ledgerEntryId.`,
        );
      }
      if (findEntry(ledgerEntryId) === undefined) {
        ledger.push({
          entryId: ledgerEntryId,
          type: 'grant',
          logicalId: request.logicalId,
          store: request.store,
          transactionId: request.transactionId,
          idempotencyKey: request.idempotencyKey,
        });
      }
      grants.set(request.idempotencyKey, ledgerEntryId);
      if (decision.finalization === 'completed') {
        await input.finalize?.({
          store: request.store,
          transactionId: request.transactionId,
          ledgerEntryId,
          logicalId: request.logicalId,
        });
      }
      return {
        status: 'granted',
        ledgerEntryId,
        ...(decision.finalization === undefined ? {} : { finalization: decision.finalization }),
        ...(decision.alreadyProcessed === undefined
          ? {}
          : { alreadyProcessed: decision.alreadyProcessed }),
      };
    },
    async getLedgerStatus(ledgerEntryIds) {
      return ledgerEntryIds.map((ledgerEntryId): CommerceLedgerStatus => {
        const entry = findEntry(ledgerEntryId);
        if (entry === undefined || entry.type !== 'grant') {
          return { ledgerEntryId, status: 'unknown' };
        }
        const reversal = reversalOf(ledgerEntryId);
        return reversal === undefined
          ? { ledgerEntryId, status: 'active' }
          : { ledgerEntryId, status: 'reversed', reversedBy: reversal.entryId };
      });
    },
    push(grant) {
      // Keyed by store transaction id: a retried fulfillment replays the
      // original grant, even when the retry names a different entry id.
      const replayed = ledger.find(
        (entry) =>
          entry.type === 'grant'
          && (entry.entryId === grant.entryId || entry.transactionId === grant.transactionId),
      );
      if (replayed !== undefined) {
        return;
      }
      ledger.push({
        entryId: grant.entryId,
        type: 'grant',
        logicalId: grant.logicalId,
        store: grant.store ?? 'server-push',
        transactionId: grant.transactionId,
        pushed: true,
      });
    },
    revoke(revocation) {
      const grant = findEntry(revocation.ledgerEntryId);
      if (grant === undefined || grant.type !== 'grant') {
        throw new CommerceConformanceScriptError(
          `Cannot revoke ${revocation.ledgerEntryId}: the ledger holds no such grant.`,
        );
      }
      if (findEntry(revocation.entryId) !== undefined) {
        return;
      }
      ledger.push({
        entryId: revocation.entryId,
        type: 'revoke',
        logicalId: grant.logicalId,
        reverses: revocation.ledgerEntryId,
        reason: revocation.reason,
      });
    },
    entitlements() {
      return ledger.flatMap((entry) =>
        entry.type === 'grant' && reversalOf(entry.entryId) === undefined
          ? [{ id: entry.entryId, logicalId: entry.logicalId }]
          : [],
      );
    },
  };
}

// Journal.

export interface CommerceJournalRecord {
  /**
   * The journal key: the purchase idempotency key (the game's key or a
   * derived key), or for a record a player journaled under its player-scoped
   * key, `<idempotencyKey>@<playerId>` (`commerceConformanceJournalKey`).
   */
  readonly key: string;
  /** The purchase idempotency key when `key` is player-scoped; absent, it is `key`. */
  readonly idempotencyKey?: string;
  readonly revision: number;
  readonly playerId: string;
  readonly store: StoreId;
  readonly logicalId: CommerceLogicalProductId;
  readonly kind: PurchaseKind;
  readonly origin: 'game' | 'discovered';
  readonly state: CommercePurchaseState;
  readonly updatedAt: string;
  readonly purchase?: StorePurchase;
  /** Saved before the first send and resent unchanged on later passes. */
  readonly request?: CommerceVerifyRequest;
  readonly ledgerEntryId?: string;
  readonly error?: CommerceErrorInfo;
  readonly revokedBy?: string;
  /**
   * Parked as another account's purchase (RFC "Another account's purchase"):
   * the record stays `verifying`, is never sent again except by the player's
   * Restore Purchases, and leaves its key to every other player.
   */
  readonly anotherAccount?: { readonly reason: string; readonly reportedAt: string };
}

/** The journal key of a purchase idempotency key, player-scoped when `playerId` is given. */
export function commerceConformanceJournalKey(idempotencyKey: string, playerId?: string): string {
  return playerId === undefined ? idempotencyKey : `${idempotencyKey}@${playerId}`;
}

/** A `verifying` record parked as another account's purchase. */
export function isCommerceJournalRecordParked(record: CommerceJournalRecord): boolean {
  return record.state === 'verifying' && record.anotherAccount !== undefined;
}

/**
 * Purchase journal with the compare-and-replace semantics of
 * `MonetizationOperationStore`. A game supplies a durable, atomic
 * implementation; the in-memory one below exists for conformance runs.
 */
export interface CommerceJournalStore {
  /** Atomically insert or return the existing record for this key. */
  reserve(record: CommerceJournalRecord): Promise<{
    readonly created: boolean;
    readonly record: CommerceJournalRecord;
  }>;
  read(key: string): Promise<CommerceJournalRecord | undefined>;
  /** Compare-and-swap on `expectedRevision`; the stored record carries the next revision. */
  replace(expectedRevision: number, record: CommerceJournalRecord): Promise<CommerceJournalRecord>;
  /** Non-terminal records; terminal records stay addressable by `read`. */
  listRecoverable(playerId: string): Promise<readonly CommerceJournalRecord[]>;
  /** Records in `granted`, `finishing`, or `finished` kept for revocation reporting. */
  listGranted(playerId: string): Promise<readonly CommerceJournalRecord[]>;
}

export interface CommerceConformanceJournal extends CommerceJournalStore {
  readonly keys: readonly string[];
  /**
   * The states a key went through, in write order. A revision that keeps the
   * state (parking another account's purchase, a Restore resend of a parked
   * record) is not repeated.
   */
  history(key: string): readonly CommercePurchaseState[];
  /** `history` for every key, in creation order. */
  snapshot(): Readonly<Record<string, readonly CommercePurchaseState[]>>;
}

/**
 * In-memory journal that keeps every revision so `expect.journal` can read the
 * full sequence. Every revision changes the state, except a `verifying`
 * revision that parks, refreshes, or unparks another account's purchase.
 */
export function createCommerceConformanceJournal(): CommerceConformanceJournal {
  const revisions = new Map<string, CommerceJournalRecord[]>();
  const current = (key: string): CommerceJournalRecord | undefined => revisions.get(key)?.at(-1);
  const statesOf = (history: readonly CommerceJournalRecord[]): CommercePurchaseState[] =>
    history.flatMap((record, index) =>
      index > 0 && history[index - 1]?.state === record.state ? [] : [record.state],
    );
  const list = (
    playerId: string,
    accept: (record: CommerceJournalRecord) => boolean,
  ): readonly CommerceJournalRecord[] => {
    const records: CommerceJournalRecord[] = [];
    for (const key of revisions.keys()) {
      const record = current(key);
      if (record !== undefined && record.playerId === playerId && accept(record)) {
        records.push(record);
      }
    }
    return records;
  };

  return {
    get keys() {
      return [...revisions.keys()];
    },
    async reserve(record) {
      const existing = current(record.key);
      if (existing !== undefined) {
        return { created: false, record: existing };
      }
      const stored = { ...record, revision: 0 };
      revisions.set(record.key, [stored]);
      return { created: true, record: stored };
    },
    async read(key) {
      return current(key);
    },
    async replace(expectedRevision, record) {
      const history = revisions.get(record.key);
      const existing = history?.at(-1);
      if (history === undefined || existing === undefined) {
        throw new Error(`Journal record ${record.key} does not exist.`);
      }
      if (existing.revision !== expectedRevision) {
        throw new Error(
          `Journal record ${record.key} is at revision ${existing.revision}, not ${expectedRevision}.`,
        );
      }
      if (
        existing.playerId !== record.playerId
        || existing.store !== record.store
        || existing.logicalId !== record.logicalId
      ) {
        throw new Error(`Journal record ${record.key} identity cannot change.`);
      }
      if (existing.state === record.state) {
        const parking = existing.state === 'verifying'
          && (existing.anotherAccount !== undefined || record.anotherAccount !== undefined);
        if (!parking) {
          throw new Error(
            `Journal record ${record.key} revision ${expectedRevision + 1} must change its state.`,
          );
        }
      } else {
        assertCommercePurchaseTransition(existing.state, record.state);
      }
      const stored = { ...record, revision: expectedRevision + 1 };
      history.push(stored);
      return stored;
    },
    async listRecoverable(playerId) {
      return list(playerId, (record) => !isTerminalCommercePurchaseState(record.state));
    },
    async listGranted(playerId) {
      return list(
        playerId,
        (record) =>
          record.ledgerEntryId !== undefined
          && (record.state === 'granted'
            || record.state === 'finishing'
            || record.state === 'finished'),
      );
    },
    history(key) {
      return statesOf(revisions.get(key) ?? []);
    },
    snapshot() {
      const snapshot: Record<string, readonly CommercePurchaseState[]> = {};
      for (const [key, history] of revisions) {
        snapshot[key] = statesOf(history);
      }
      return snapshot;
    },
  };
}

// Reference runtime (RFC "Reconciler").

export interface CommerceConformanceRuntime {
  readonly started: boolean;
  /** Subscribe, read available purchases when declared, then reconcile until idle. */
  start(): Promise<void>;
  /** Drop in-memory state; the journal, store, ledger, and wallet are kept. */
  stop(): Promise<void>;
  /** One reconcile pass, then any passes that events arriving meanwhile trigger. */
  reconcile(): Promise<void>;
  /** Reconcile while a trigger is pending; a no-op when stopped. */
  runUntilIdle(): Promise<void>;
  requestPurchase(input: RequestPurchaseInput): Promise<RequestPurchaseResult>;
  fetchProducts(input?: FetchProductsInput): Promise<readonly StoreProduct[]>;
  /**
   * The player's manual Restore Purchases: `provider.restorePurchases`, then
   * the available purchases as a restore, then a pass. Required by vectors
   * with a `runtime.restore` step.
   */
  restorePurchases?(): Promise<void>;
}

export interface CreateCommerceConformanceRuntimeInput {
  readonly provider: CommerceProvider;
  readonly backend: CommerceConformanceBackendClient;
  readonly journal: CommerceJournalStore;
  readonly clock: CommerceConformanceClock;
  readonly catalog: readonly CommerceConformanceCatalogEntry[];
  readonly playerId: string;
}

/**
 * Reference reconciler. Every transition is its own journal revision written
 * through compare-and-replace; the backend is in-process, so there is no
 * transport, but a thrown finish or verify keeps the state for the next pass
 * as a transport failure would. Only a ledger entry moves a record to
 * `granted`, and only a ledger revocation moves it to `revoked`.
 *
 * Another account's purchase (RFC "Another account's purchase") is parked:
 * the backend's `CommerceConformanceAnotherAccountError`, or a `rejected`
 * receipt with a store binding mismatch reason, keeps the record `verifying`
 * with an `anotherAccount` marker. No pass sends it again; only the player's
 * `restorePurchases`, when the store reports the purchase again, resends it
 * with the evidence reported then, and another answer unparks it. Its key no
 * longer refuses another player, who journals the purchase under its
 * player-scoped key (`commerceConformanceJournalKey`).
 */
export function createCommerceConformanceRuntime(
  input: CreateCommerceConformanceRuntimeInput,
): CommerceConformanceRuntime {
  const { provider, backend, journal, clock, catalog, playerId } = input;
  const store = provider.store;
  const records = new Map<string, CommerceJournalRecord>();
  const inbox: CommerceEvent[] = [];
  let unsubscribe: (() => void) | undefined;
  let started = false;
  let triggerPending = false;
  let running: Promise<void> | undefined;
  /** A failure from a pass nobody awaited; the next `runUntilIdle` rethrows it. */
  let pendingFailure: { readonly error: unknown } | undefined;

  const catalogEntry = (logicalId: string): CommerceConformanceCatalogEntry => {
    const entry = catalog.find((candidate) => candidate.logicalId === logicalId);
    if (entry === undefined) {
      throw new CommerceConformanceScriptError(
        `Unknown logical id ${logicalId}; declare it in the vector catalog.`,
      );
    }
    return entry;
  };
  const resolveLogicalId = (purchase: StorePurchase): CommerceLogicalProductId => {
    if (purchase.logicalId !== undefined) {
      return catalogEntry(purchase.logicalId).logicalId;
    }
    const entry = catalog.find((candidate) => candidate.storeSku === purchase.storeSku);
    if (entry === undefined) {
      throw new CommerceConformanceScriptError(
        `Purchase ${purchase.transactionId} names SKU ${purchase.storeSku}, which no catalog entry declares.`,
      );
    }
    return entry.logicalId;
  };

  const remember = (record: CommerceJournalRecord): CommerceJournalRecord => {
    records.set(record.key, record);
    return record;
  };
  const write = async (
    record: CommerceJournalRecord,
    state: CommercePurchaseState,
    patch: Partial<CommerceJournalRecord> = {},
  ): Promise<CommerceJournalRecord> =>
    remember(
      await journal.replace(record.revision, {
        ...record,
        ...patch,
        state,
        updatedAt: clock.now(),
      }),
    );
  /** A revision that keeps the state: parks, refreshes, or unparks another account's purchase. */
  const revise = async (record: CommerceJournalRecord): Promise<CommerceJournalRecord> =>
    remember(await journal.replace(record.revision, { ...record, updatedAt: clock.now() }));
  const park = async (
    record: CommerceJournalRecord,
    request: CommerceVerifyRequest,
    reason: string,
  ): Promise<void> => {
    await revise({ ...record, request, anotherAccount: { reason, reportedAt: clock.now() } });
  };
  /** The binding mismatch of another account's answer: the thrown error, or a pre-answer receipt. */
  const anotherAccountOf = (
    answer: { readonly error: unknown } | { readonly response: CommerceVerifyResponse },
  ): string | undefined => {
    if ('error' in answer) {
      return answer.error instanceof CommerceConformanceAnotherAccountError
        ? answer.error.reason
        : undefined;
    }
    const { response } = answer;
    return response.status === 'rejected'
      && response.reason !== undefined
      && commerceConformanceStoreAccountMismatchReasons.includes(response.reason)
      ? response.reason
      : undefined;
  };
  /**
   * Sends a verify request; `undefined` when the record was parked (or stays
   * parked) as another account's purchase. Any other thrown error propagates.
   */
  const verify = async (
    record: CommerceJournalRecord,
    request: CommerceVerifyRequest,
  ): Promise<CommerceVerifyResponse | undefined> => {
    let response: CommerceVerifyResponse;
    try {
      response = await backend.verifyPurchase(request);
    } catch (error) {
      const reason = anotherAccountOf({ error });
      if (reason === undefined) {
        throw error;
      }
      await park(record, request, reason);
      return undefined;
    }
    const reason = anotherAccountOf({ response });
    if (reason !== undefined) {
      await park(record, request, reason);
      return undefined;
    }
    return response;
  };
  /** Journals a `pending` or `rejected` answer; returns the `granted` record of a grant. */
  const settle = async (
    record: CommerceJournalRecord,
    request: CommerceVerifyRequest,
    response: CommerceVerifyResponse,
  ): Promise<CommerceJournalRecord | undefined> => {
    if (response.status === 'pending') {
      await write(record, 'pending', { request });
      return undefined;
    }
    if (response.status === 'rejected') {
      await write(record, 'rejected', { request });
      return undefined;
    }
    if (response.ledgerEntryId === undefined) {
      throw new CommerceConformanceScriptError(
        `A granted verify response for ${record.key} must carry a ledgerEntryId.`,
      );
    }
    return write(record, 'granted', { request, ledgerEntryId: response.ledgerEntryId });
  };
  const create = async (
    record: Omit<CommerceJournalRecord, 'revision' | 'updatedAt'>,
  ): Promise<{ readonly created: boolean; readonly record: CommerceJournalRecord }> => {
    const reserved = await journal.reserve({ ...record, revision: 0, updatedAt: clock.now() });
    remember(reserved.record);
    return reserved;
  };
  const loadRecords = async (): Promise<void> => {
    for (const record of await journal.listRecoverable(playerId)) {
      remember(record);
    }
    for (const record of await journal.listGranted(playerId)) {
      remember(record);
    }
  };
  const openRecordsFor = (logicalId: string): CommerceJournalRecord[] =>
    [...records.values()].filter(
      (record) =>
        record.store === store
        && record.logicalId === logicalId
        && (record.state === 'launched' || record.state === 'pending'),
    );

  const trigger = (): void => {
    triggerPending = true;
  };
  const listener = (event: CommerceEvent): void => {
    inbox.push(event);
    trigger();
    // Every event starts a pass on its own; a pass already in flight picks the trigger up.
    scheduleRun();
  };

  /**
   * A store report of a parked record: only the player's Restore Purchases
   * sends it again, as a restore and with the evidence the store reports now.
   * It stays parked until the backend answers something else; a granted
   * answer is finished by the pass that follows.
   */
  const reportParked = async (
    record: CommerceJournalRecord,
    purchase: StorePurchase,
    restoring: boolean,
  ): Promise<void> => {
    if (!restoring || purchase.state !== 'purchased') {
      return;
    }
    const request: CommerceVerifyRequest = {
      ...buildRequest({ ...record, purchase }),
      intent: 'restore',
    };
    const refreshed = await revise({ ...record, purchase, request });
    const response = await verify(refreshed, request);
    if (response === undefined) {
      return;
    }
    const { anotherAccount: _parked, ...unparked } = refreshed;
    await settle(await revise(unparked), request, response);
  };

  // Reconciler step 2: match a reported purchase to a journal record.
  const ingestPurchase = async (purchase: StorePurchase, restoring = false): Promise<void> => {
    if (purchase.store !== store) {
      throw new CommerceConformanceScriptError(
        `Purchase ${purchase.transactionId} belongs to store ${purchase.store}, not ${store}.`,
      );
    }
    const logicalId = resolveLogicalId(purchase);
    let record = [...records.values()].find(
      (candidate) =>
        candidate.store === purchase.store
        && candidate.purchase?.transactionId === purchase.transactionId,
    );
    if (record === undefined) {
      const open = openRecordsFor(logicalId);
      if (open.length > 1) {
        throw new CommerceConformanceScriptError(
          `Purchase ${purchase.transactionId} matches ${open.length} open records for ${logicalId}.`,
        );
      }
      record = open[0];
    }
    if (record !== undefined && isCommerceJournalRecordParked(record)) {
      await reportParked(record, purchase, restoring);
      return;
    }
    if (record === undefined) {
      if (purchase.state === 'revoked') {
        return;
      }
      const idempotencyKey = await createDerivedPurchaseIdempotencyKey({
        store: purchase.store,
        transactionId: purchase.transactionId,
        token: purchase.token,
      });
      let key = idempotencyKey;
      const existing = await journal.read(key);
      if (existing !== undefined && existing.playerId === playerId) {
        remember(existing);
        return;
      }
      if (existing !== undefined) {
        // Another player's key is refused, unless that player's record is
        // another account's purchase: then this player journals the purchase
        // under its own player-scoped key (RFC "Idempotency keys").
        if (!isCommerceJournalRecordParked(existing)) {
          return;
        }
        key = commerceConformanceJournalKey(idempotencyKey, playerId);
        const scoped = await journal.read(key);
        if (scoped !== undefined) {
          remember(scoped);
          return;
        }
      }
      await create({
        key,
        ...(key === idempotencyKey ? {} : { idempotencyKey }),
        playerId,
        store: purchase.store,
        logicalId,
        kind: catalogEntry(logicalId).kind,
        origin: 'discovered',
        state: purchase.state,
        purchase,
      });
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
    // Revoked store states never revoke on their own: only the ledger does (step 5).
  };

  const ingestError = async (
    logicalId: CommerceLogicalProductId | undefined,
    error: CommerceErrorInfo,
  ): Promise<void> => {
    const open = logicalId === undefined
      ? [...records.values()].filter(
          (record) =>
            record.store === store && (record.state === 'launched' || record.state === 'pending'),
        )
      : openRecordsFor(logicalId);
    if (open.length > 1) {
      throw new CommerceConformanceScriptError(
        `purchaseError${logicalId === undefined ? '' : ` for ${logicalId}`} matches ${open.length} open records.`,
      );
    }
    // An error for an attempt the journal never opened has nothing to transition.
    const record = open[0];
    if (record !== undefined) {
      await write(record, error.code === 'USER_CANCELLED' ? 'cancelled' : 'failed', { error });
    }
  };

  const buildRequest = (record: CommerceJournalRecord): CommerceVerifyRequest => {
    const purchase = record.purchase;
    if (purchase === undefined) {
      throw new Error(`Journal record ${record.key} is purchased without a purchase.`);
    }
    return {
      idempotencyKey: record.idempotencyKey ?? record.key,
      playerId,
      store: purchase.store,
      transactionId: purchase.transactionId,
      token: purchase.token,
      logicalId: record.logicalId,
      quantity: purchase.quantity,
      evidence: purchase.evidence,
    };
  };

  // Reconciler steps 3 and 4: drive one record as far as the backend and store allow.
  const drive = async (
    initial: CommerceJournalRecord,
    capabilities: CommerceCapabilities,
  ): Promise<void> => {
    let record = initial;
    let finalization: 'pending' | 'completed' | undefined;
    for (;;) {
      switch (record.state) {
        case 'purchased':
          record = await write(record, 'verifying', { request: buildRequest(record) });
          continue;
        case 'pending':
          if (record.request === undefined) {
            return;
          }
          record = await write(record, 'verifying');
          continue;
        case 'verifying': {
          if (isCommerceJournalRecordParked(record)) {
            // Another account's purchase: only Restore Purchases sends it again.
            return;
          }
          const request = record.request ?? buildRequest(record);
          const response = await verify(record, request);
          const granted = response === undefined
            ? undefined
            : await settle(record, request, response);
          if (response === undefined || granted === undefined) {
            return;
          }
          finalization = response.finalization;
          record = granted;
          continue;
        }
        case 'granted':
          if (capabilities.lifecycle.finish === 'none') {
            await write(record, 'finished');
            return;
          }
          record = await write(record, 'finishing');
          continue;
        case 'finishing': {
          const owner = capabilities.lifecycle.finish;
          if (owner === 'none') {
            await write(record, 'finished');
            return;
          }
          if (owner === 'server') {
            if (finalization === undefined) {
              const response = await backend.verifyPurchase(record.request ?? buildRequest(record));
              finalization = response.status === 'granted' ? response.finalization : undefined;
            }
            if (finalization === 'completed') {
              await write(record, 'finished');
            }
            return;
          }
          const ledgerEntryId = record.ledgerEntryId;
          const transactionId = record.purchase?.transactionId;
          if (ledgerEntryId === undefined || transactionId === undefined) {
            throw new Error(`Journal record ${record.key} is finishing without a grant.`);
          }
          if (provider.finishTransaction === undefined) {
            throw new CommerceConformanceScriptError(
              `The provider declares finish: '${owner}' but has no finishTransaction.`,
            );
          }
          let finished = false;
          try {
            finished = (await provider.finishTransaction({
              transactionId,
              ledgerEntryId,
              isConsumable: record.kind === 'consumable',
            })).finished;
          } catch (error) {
            if (error instanceof CommerceConformanceScriptError) {
              throw error;
            }
            // Transport-class failure: keep `finishing` for the next pass.
            finished = false;
          }
          if (finished) {
            await write(record, 'finished');
          }
          return;
        }
        default:
          return;
      }
    }
  };

  // Reconciler step 5: reversed grants move to revoked.
  const revokeReversed = async (): Promise<void> => {
    const granted = (await journal.listGranted(playerId)).map(remember);
    if (granted.length === 0) {
      return;
    }
    const statuses = await backend.getLedgerStatus(
      granted.flatMap((record) => (record.ledgerEntryId === undefined
        ? []
        : [record.ledgerEntryId])),
    );
    for (const record of granted) {
      const status = statuses.find((candidate) => candidate.ledgerEntryId === record.ledgerEntryId);
      if (status?.status === 'reversed') {
        await write(record, 'revoked', {
          ...(status.reversedBy === undefined ? {} : { revokedBy: status.reversedBy }),
        });
      }
    }
  };

  const pass = async (): Promise<void> => {
    const capabilities = await provider.getCapabilities();
    // A provider without lifecycle.events is polled: every pass reads its available purchases.
    if (!capabilities.lifecycle.events && capabilities.lifecycle.availablePurchases) {
      for (const purchase of await provider.getAvailablePurchases({
        includePending: capabilities.lifecycle.pending,
      })) {
        inbox.push({ type: 'purchaseUpdated', purchase });
      }
    }
    for (const event of inbox.splice(0, inbox.length)) {
      if (event.type === 'purchaseUpdated') {
        await ingestPurchase(event.purchase);
      } else if (event.type === 'purchaseError') {
        await ingestError(event.logicalId, event.error);
      }
    }
    for (const record of (await journal.listRecoverable(playerId)).map(remember)) {
      await drive(record, capabilities);
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
        await pass();
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

  return {
    get started() {
      return started;
    },
    async start() {
      if (started) {
        return;
      }
      started = true;
      await loadRecords();
      // Subscribe first, then read: an event delivered before the listener is found either way.
      unsubscribe = provider.subscribe(listener);
      const capabilities = await provider.getCapabilities();
      // An event-less provider is polled by the first pass instead, so it is read once.
      if (capabilities.lifecycle.availablePurchases && capabilities.lifecycle.events) {
        for (const purchase of await provider.getAvailablePurchases({
          includePending: capabilities.lifecycle.pending,
        })) {
          inbox.push({ type: 'purchaseUpdated', purchase });
        }
      }
      trigger();
      await runUntilIdle();
    },
    async stop() {
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
      triggerPending = false;
      inbox.length = 0;
      records.clear();
    },
    async reconcile() {
      if (!started) {
        await loadRecords();
      }
      await pass();
      await runUntilIdle();
    },
    async restorePurchases() {
      if (!started) {
        await loadRecords();
      }
      await provider.restorePurchases?.();
      const capabilities = await provider.getCapabilities();
      if (capabilities.lifecycle.availablePurchases) {
        for (const purchase of await provider.getAvailablePurchases({
          includePending: capabilities.lifecycle.pending,
        })) {
          await ingestPurchase(purchase, true);
        }
      }
      await pass();
      await runUntilIdle();
    },
    runUntilIdle,
    async requestPurchase(request) {
      const entry = catalogEntry(request.logicalId);
      // A key is never regenerated on retry: the journaled attempt is the answer,
      // and the store UI opens once per key however many calls overlap.
      const journaled = (existing: CommerceJournalRecord): RequestPurchaseResult => {
        if (
          (existing.state === 'cancelled' || existing.state === 'failed')
          && existing.error !== undefined
        ) {
          return { outcome: existing.state, error: existing.error };
        }
        return {
          outcome: 'failed',
          error: new CommerceError('IN_PROGRESS', {
            message: `Idempotency key ${request.idempotencyKey} is already journaled.`,
          }).toCommerceErrorInfo(),
        };
      };
      const existing = await journal.read(request.idempotencyKey);
      if (existing !== undefined) {
        return journaled(existing);
      }
      const { created, record } = await create({
        key: request.idempotencyKey,
        playerId,
        store,
        logicalId: entry.logicalId,
        kind: entry.kind,
        origin: 'game',
        state: 'requested',
      });
      if (!created) {
        return journaled(record);
      }
      const failWith = async (error: unknown): Promise<RequestPurchaseResult> => {
        const info = commerceErrorInfoOf(error);
        await write(record, 'failed', { error: info });
        return { outcome: 'failed', error: info };
      };
      try {
        assertRequestPurchaseSupported(await provider.getCapabilities(), request, entry.kind);
      } catch (error) {
        return failWith(error);
      }
      if (!started) {
        await loadRecords();
      }
      // An overlapping request for the same product that reserved its record
      // earlier counts too: the earlier reservation reaches the store, the
      // later one fails, so two overlapping calls never both open the UI.
      let reservedEarlier = true;
      const open = (await journal.listRecoverable(playerId)).filter((candidate) => {
        if (candidate.key === record.key) {
          reservedEarlier = false;
          return false;
        }
        return (
          candidate.store === store
          && candidate.logicalId === entry.logicalId
          && (candidate.state === 'launched'
            || candidate.state === 'pending'
            || (candidate.state === 'requested' && reservedEarlier))
        );
      });
      if (open.length > 0) {
        return failWith(new CommerceError('IN_PROGRESS', {
          message: `A purchase of ${entry.logicalId} is already in progress (${open[0]?.key}).`,
        }));
      }
      let result: RequestPurchaseResult;
      try {
        result = await provider.requestPurchase(request);
      } catch (error) {
        if (error instanceof CommerceConformanceScriptError) {
          throw error;
        }
        return failWith(error);
      }
      if (result.outcome === 'launched') {
        await write(record, 'launched');
      } else if (result.outcome === 'purchased') {
        // A synchronous answer passes the same store and product checks as a reported purchase.
        const purchase = result.purchase;
        if (
          purchase.store !== store
          || purchase.storeSku !== entry.storeSku
          || resolveLogicalId(purchase) !== entry.logicalId
        ) {
          throw new CommerceConformanceScriptError(
            `The provider answered ${request.idempotencyKey} (${store}/${entry.logicalId}) with `
              + `purchase ${purchase.transactionId} for ${purchase.store}/${purchase.storeSku}.`,
          );
        }
        // Both states are written, in order, when the store answered synchronously.
        const launched = await write(record, 'launched');
        if (purchase.state === 'pending') {
          await write(launched, 'pending', { purchase });
        } else if (purchase.state === 'purchased') {
          await write(launched, 'purchased', { purchase });
        }
      } else {
        await write(record, result.outcome, { error: result.error });
      }
      trigger();
      await runUntilIdle();
      return result;
    },
    async fetchProducts(request = {}) {
      return provider.fetchProducts(request);
    },
  };
}

// Reference credit wallet. The lot and membership rules and the in-memory
// wallet live in `./commerce-wallet` (B7); the conformance wallet wraps that
// wallet with the vector actor surface and the backend finalizer hook.

export type CommerceScheduledDebit = CreditScheduledDebit;

/** Stable id `<subscriptionId>:<periodIndex>:<type>`, so redelivery is idempotent. */
export type CommerceConformanceSubscriptionEvent = CreditSubscriptionEvent;

export type CommerceConformanceMembershipStart = CreditMembershipStartInput;

export type CommerceConformanceMembershipResult = CreditMembershipStartResult;

/** The wallet actor of a vector: wallet steps plus wallet observations. */
export interface CommerceConformanceWalletActor {
  readonly lots: readonly CreditLot[];
  /** Every debit of every processed spend, in order; replays add nothing. */
  readonly debits: readonly CommerceScheduledDebit[];
  readonly subscriptionEvents: readonly CommerceConformanceSubscriptionEvent[];
  creditFromGrant(
    lot: CommerceConformanceLotFixture,
    options?: { readonly spendScope?: CreditLotSpendScope },
  ): CreditLot;
  spend(input: CreditSpendInput): Promise<CreditSpendResult>;
  /** Runs the renewal scheduler for memberships whose paid period has ended. */
  renewDue(): Promise<void>;
  getBalance(input: { readonly titleId: string }): Promise<CreditBalance>;
  getActiveSubscriptions(): Promise<readonly ActiveSubscription[]>;
  /** The backend's finalizer redeemed the entitlement (`lifecycle.finish: 'server'`). */
  finalize?(input: {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
  }): void | Promise<void>;
}

export interface CommerceConformanceWallet
  extends CreditWalletClient, CommerceConformanceWalletActor {
  readonly entitlements: readonly CreditEntitlement[];
  /** Offers the wallet prices spends against; the provider registers the vector catalog when empty. */
  readonly offers: readonly CreditOffer[];
  addOffers(offers: readonly CreditOffer[]): void;
  startMembership(input: CommerceConformanceMembershipStart): Promise<CommerceConformanceMembershipResult>;
  getActiveSubscriptions(input?: { readonly titleId?: string }): Promise<readonly ActiveSubscription[]>;
  subscribe(
    listener: (event: CommerceEvent) => void,
    input?: CreditWalletSubscribeInput,
  ): () => void;
}

export interface CreateCommerceConformanceWalletInput {
  readonly store: StoreId;
  readonly clock: CommerceConformanceClock;
  readonly currencies: readonly string[];
  /** Offers served by `listOffers`; defaults to none. */
  readonly offers?: readonly CreditOffer[];
}

/**
 * The reference wallet (`createInMemoryCreditWallet`) on the vector clock,
 * with the actor surface: fixture lots credit through `creditFromGrant`, the
 * backend finalizer redeems through `finalize`, and owner-side mistakes in a
 * vector surface as script errors.
 */
export function createCommerceConformanceWallet(
  input: CreateCommerceConformanceWalletInput,
): CommerceConformanceWallet {
  const { clock } = input;
  const wallet = createInMemoryCreditWallet({
    store: input.store,
    currencies: input.currencies,
    now: () => clock.now(),
    ...(input.offers === undefined ? {} : { offers: input.offers }),
  });
  return {
    store: wallet.store,
    get lots() {
      return wallet.lots;
    },
    get debits() {
      return wallet.debits;
    },
    get entitlements() {
      return wallet.entitlements;
    },
    get subscriptionEvents() {
      return wallet.subscriptionEvents;
    },
    get offers() {
      return wallet.offers;
    },
    addOffers: (offers) => wallet.addOffers(offers),
    creditFromGrant(fixture, options = {}) {
      try {
        return wallet.creditFromGrant(
          fixture,
          options.spendScope === undefined ? {} : { explicit: options.spendScope },
        );
      } catch (error) {
        throw new CommerceConformanceScriptError(describeError(error));
      }
    },
    spend: (request) => wallet.spend(request),
    startMembership: (request) => wallet.startMembership(request),
    renewDue: () => wallet.renewDue(),
    listOffers: (request) => wallet.listOffers(request),
    listUnredeemed: (request) => wallet.listUnredeemed(request),
    redeem: (request) => wallet.redeem(request),
    async finalize(request) {
      await wallet.redeem({
        entitlementId: request.transactionId,
        ledgerEntryId: request.ledgerEntryId,
      });
    },
    getBalance: (request) => wallet.getBalance(request),
    getActiveSubscriptions: (request) => wallet.getActiveSubscriptions(request),
    subscribe: (listener, request) => wallet.subscribe(listener, request),
  };
}

// Wallet-backed provider.

export interface CreateCommerceConformanceWalletProviderInput {
  readonly wallet: CommerceConformanceWallet;
  readonly profile: CommerceConformanceProfile;
  readonly catalog: readonly CommerceConformanceCatalogEntry[];
  readonly currencies: readonly string[];
  readonly billingAuthority: CommerceBillingAuthority;
  readonly titleId: string;
  readonly clock: CommerceConformanceClock;
}

/**
 * `createCreditCommerceProvider` over the reference wallet with the vector
 * profile as its capability block. A wallet that lists no offers has the
 * vector catalog registered as its offers first (a fixture price of one unit
 * of the first wallet currency for entries without membership terms), so the
 * wallet prices every spend and starts memberships itself. Memberships exist
 * only where the billing authority is `host`.
 */
export function createCommerceConformanceWalletProvider(
  input: CreateCommerceConformanceWalletProviderInput,
): CommerceProvider {
  const { wallet, catalog, titleId, clock } = input;
  const defaultCurrency = input.currencies[0];
  if (defaultCurrency === undefined) {
    throw new CommerceConformanceScriptError('The wallet profile declares no currencies.');
  }
  const toOffer = (entry: CommerceConformanceCatalogEntry): CreditOffer => ({
    logicalId: entry.logicalId,
    storeSku: entry.storeSku,
    kind: entry.kind,
    title: entry.logicalId,
    description: `Wallet offer ${entry.storeSku}`,
    // Fixture price for catalog entries without terms: one unit of the first wallet currency.
    price: entry.membership?.price ?? { currency: defaultCurrency, amount: 1 },
    ...(entry.membership === undefined ? {} : { membership: entry.membership }),
  });
  if (wallet.offers.length === 0) {
    wallet.addOffers(catalog.map(toOffer));
  }
  const capabilities = createCommerceConformanceCapabilities(input.profile);
  return createCreditCommerceProvider(wallet, {
    titleId,
    billingAuthority: input.billingAuthority,
    currencies: input.currencies,
    capabilities: {
      purchase: capabilities.purchase,
      catalog: capabilities.catalog,
      lifecycle: capabilities.lifecycle,
      authority: capabilities.authority,
      availability: capabilities.availability,
    },
    now: () => clock.now(),
  });
}

// Runner.

export interface CommerceConformanceHarness {
  readonly provider: CommerceProvider;
  /** Handles `store` steps; required by store vectors. */
  readonly store?: CommerceConformanceStoreActor;
  /** Handles `wallet` steps; required by wallet vectors. */
  readonly wallet?: CommerceConformanceWalletActor;
}

export interface CommerceConformanceContext extends CommerceConformanceFixtureContext {
  readonly vector: CommerceConformanceVector;
  readonly titleId: string;
  readonly clock: CommerceConformanceClock;
  readonly backend: CommerceConformanceBackend;
  readonly journal: CommerceConformanceJournal;
}

export interface CommerceConformanceRunOptions {
  /** Supplies a provider over the caller's fake SDK; defaults to the fake store or the reference wallet. */
  readonly createProvider?: (
    context: CommerceConformanceContext,
  ) => CommerceConformanceHarness | Promise<CommerceConformanceHarness>;
  /**
   * Supplies the runtime under test over the harness provider, backend, and
   * journal; defaults to the reference reconciler
   * (`createCommerceConformanceRuntime`). The reference run an adaptive
   * vector is derived from always uses the reference reconciler, so the
   * derived expectations stay the RFC's regardless of the runtime under test.
   */
  readonly createRuntime?: (
    input: CreateCommerceConformanceRuntimeInput,
    context: CommerceConformanceContext,
  ) => CommerceConformanceRuntime | Promise<CommerceConformanceRuntime>;
  readonly playerId?: string;
  readonly titleId?: string;
}

export interface CommerceConformanceFailure {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export type CommerceConformanceVectorStatus = 'passed' | 'failed' | 'skipped';

/**
 * `CommerceConformanceExpectation` as the matcher consumes it: a derived
 * `finishCalls` list carries the store actor's own records, whose `result` may
 * also be `unfinished`.
 */
export interface CommerceConformanceResolvedExpectation extends Omit<
  CommerceConformanceExpectation,
  'finishCalls'
> {
  readonly finishCalls?: readonly CommerceConformanceFinishCall[];
}

/** How an adaptive vector's expectations were derived for the provider under test. */
export interface CommerceConformanceAdaptation {
  /** The provider's store id; it replaces the fixture store id in derived keys and verify requests. */
  readonly store: StoreId;
  readonly finish: CommerceFinishOwner;
  readonly evidence: CommerceEvidenceAuthority;
  /** The expectation the vector was matched against. */
  readonly expect: CommerceConformanceResolvedExpectation;
}

export interface CommerceConformanceVectorResult {
  readonly vector: string;
  /** `skipped` vectors did not run; `passed` is false and `reason` says why. */
  readonly status: CommerceConformanceVectorStatus;
  readonly passed: boolean;
  readonly failures: readonly CommerceConformanceFailure[];
  readonly reason?: string;
  /** Present when the vector ran with adaptive expectations. */
  readonly adaptive?: CommerceConformanceAdaptation;
}

export function createCommerceConformanceHarness(
  context: CommerceConformanceContext,
): CommerceConformanceHarness {
  if (context.vector.wallet === undefined) {
    const store = createCommerceConformanceStore(context);
    return { provider: store.provider, store };
  }
  const wallet = createCommerceConformanceWallet({
    store: context.profile.store,
    clock: context.clock,
    currencies: context.vector.wallet.currencies,
  });
  const provider = createCommerceConformanceWalletProvider({
    wallet,
    profile: context.profile,
    catalog: context.catalog,
    currencies: context.vector.wallet.currencies,
    billingAuthority: context.vector.wallet.billingAuthority,
    titleId: context.titleId,
    clock: context.clock,
  });
  return { provider, wallet };
}

/**
 * Runs one vector: executes every step, lets the runtime run until idle after
 * each, then matches `expect`. Matching compares only the listed fields; arrays
 * compare in order and by length; a listed `journal` is the whole journal.
 * Any unscripted operation fails the vector at the step that needed it.
 *
 * With `options.createProvider`, a vector flagged `profile.adaptive` is first
 * checked against the provider's declared capabilities
 * (`commerceConformanceAdaptiveSkipReason`) and then matched against
 * expectations derived from a reference run under those capabilities
 * (`deriveAdaptiveCommerceConformanceExpectation`). Duplicate detection needs
 * the whole run set, so it applies through `runCommerceConformanceVectors`.
 */
export async function runCommerceConformanceVector(
  vector: CommerceConformanceVector,
  options: CommerceConformanceRunOptions = {},
): Promise<CommerceConformanceVectorResult> {
  return runVectorIn(vector, options, purchaseFinishFamilyOf([vector]));
}

export async function runCommerceConformanceVectors(
  vectors: readonly CommerceConformanceVector[],
  options: CommerceConformanceRunOptions = {},
): Promise<readonly CommerceConformanceVectorResult[]> {
  // The `purchase-<owner>-finish` family of this run is fixed up front; the
  // canonical member per owner is then one lookup per vector.
  const family = purchaseFinishFamilyOf(vectors);
  const results: CommerceConformanceVectorResult[] = [];
  for (const vector of vectors) {
    results.push(await runVectorIn(vector, options, family));
  }
  return results;
}

async function runVectorIn(
  vector: CommerceConformanceVector,
  options: CommerceConformanceRunOptions,
  family: readonly CommerceConformanceVector[],
): Promise<CommerceConformanceVectorResult> {
  const ids = {
    playerId: options.playerId ?? commerceConformanceDefaultPlayerId,
    titleId: options.titleId ?? commerceConformanceDefaultTitleId,
  };
  const failed = (failures: readonly CommerceConformanceFailure[]): CommerceConformanceVectorResult =>
    ({ vector: vector.vector, status: 'failed', passed: false, failures });
  const skipped = (reason: string): CommerceConformanceVectorResult =>
    ({ vector: vector.vector, status: 'skipped', passed: false, failures: [], reason });

  // A harness that cannot be built is a failed run, never a rejected promise.
  let execution: Execution;
  try {
    execution = await prepareExecution(
      vector,
      options.createProvider ?? createCommerceConformanceHarness,
      ids,
      options.createRuntime,
    );
  } catch (error) {
    return failed([
      { path: 'harness', expected: 'createProvider resolves', actual: describeError(error) },
    ]);
  }

  let expectation: CommerceConformanceResolvedExpectation = vector.expect;
  let adaptive: CommerceConformanceAdaptation | undefined;
  let adaptation: StepAdaptation | undefined;
  if (options.createProvider !== undefined && vector.profile.adaptive === true) {
    let capabilities: CommerceCapabilities;
    try {
      capabilities = await execution.harness.provider.getCapabilities();
    } catch (error) {
      return failed([
        {
          path: 'capabilities',
          expected: 'provider.getCapabilities() resolves',
          actual: describeError(error),
        },
      ]);
    }
    const reason = adaptiveSkipReasonWith(vector, capabilities, family);
    if (reason !== undefined) {
      return skipped(reason);
    }
    const store = execution.harness.provider.store;
    adaptation = adaptationFor(vector, capabilities);
    // The reference run reports the tokens the provider under test reports.
    const tokenOf = execution.harness.store?.tokenOf;
    const tokenAdaptedVector = tokenOf === undefined
      ? vector
      : withStoreTokens(vector, (purchase) => tokenOf.call(execution.harness.store, purchase));
    let reference: Execution;
    try {
      reference = await prepareExecution(
        referenceVectorFor(tokenAdaptedVector, store, capabilities),
        createCommerceConformanceHarness,
        ids,
      );
    } catch (error) {
      return failed([
        {
          path: 'reference.harness',
          expected: 'reference harness builds',
          actual: describeError(error),
        },
      ]);
    }
    const referenceFailures = await executeSteps(reference, adaptation);
    const referenceFailure = referenceFailures[0];
    if (referenceFailure !== undefined) {
      // The reference pieces cannot play the scenario under these capabilities,
      // which is a property of the vector and the capability set, not of the
      // provider under test; the step and its error are kept in the reason.
      return skipped(
        `the reference run under the provider capabilities failed at ${referenceFailure.path}: `
          + `expected ${String(referenceFailure.expected)}, got ${String(referenceFailure.actual)}`,
      );
    }
    const derived = await deriveAdaptiveExpectation(tokenAdaptedVector, reference, store);
    if (derived.reason !== undefined) {
      return skipped(derived.reason);
    }
    expectation = derived.expect;
    adaptive = {
      store,
      finish: capabilities.lifecycle.finish,
      evidence: capabilities.authority.evidence,
      expect: expectation,
    };
  }

  const failures = await executeSteps(execution, adaptation);
  if (failures.length > 0) {
    return { ...failed(failures), ...(adaptive === undefined ? {} : { adaptive }) };
  }
  try {
    await matchExpectations(expectation, { ...execution, failures });
  } catch (error) {
    // A provider read that throws while expectations are evaluated is a failed
    // run, never a rejected promise.
    failures.push({
      path: 'expect',
      expected: 'expectations evaluate',
      actual: describeError(error),
    });
  }
  return {
    vector: vector.vector,
    status: failures.length === 0 ? 'passed' : 'failed',
    passed: failures.length === 0,
    failures,
    ...(adaptive === undefined ? {} : { adaptive }),
  };
}

interface Execution {
  readonly vector: CommerceConformanceVector;
  readonly harness: CommerceConformanceHarness;
  /** The runtime of the current player; a `runtime.switchPlayer` step replaces it. */
  runtime: CommerceConformanceRuntime;
  /** A stopped runtime for another player over the same harness, backend, journal, and clock. */
  readonly createRuntimeFor: (playerId: string) => Promise<CommerceConformanceRuntime>;
  readonly backend: CommerceConformanceBackend;
  readonly journal: CommerceConformanceJournal;
  readonly clock: CommerceConformanceClock;
  /** Set by `executeSteps`; the backend reads it on every verify. */
  readonly adaptation: { current: StepAdaptation | undefined };
}

async function prepareExecution(
  vector: CommerceConformanceVector,
  createHarness: NonNullable<CommerceConformanceRunOptions['createProvider']>,
  ids: { readonly playerId: string; readonly titleId: string },
  createRuntime?: CommerceConformanceRunOptions['createRuntime'],
): Promise<Execution> {
  const clock = createCommerceConformanceClock();
  const journal = createCommerceConformanceJournal();
  const harnessRef: { current?: CommerceConformanceHarness } = {};
  const adaptation: { current: StepAdaptation | undefined } = { current: undefined };
  const backend = createCommerceConformanceBackend({
    finalize: async (request) => {
      await harnessRef.current?.store?.finalize?.(request);
      await harnessRef.current?.wallet?.finalize?.(request);
    },
    finalizeOnReread: () => adaptation.current?.serverFinalization === true,
  });
  const context: CommerceConformanceContext = {
    vector,
    profile: vector.profile,
    catalog: vector.catalog ?? [],
    playerId: ids.playerId,
    titleId: ids.titleId,
    clock,
    backend,
    journal,
  };
  const harness = await createHarness(context);
  harnessRef.current = harness;
  const createRuntimeFor = async (playerId: string): Promise<CommerceConformanceRuntime> => {
    const runtimeInput: CreateCommerceConformanceRuntimeInput = {
      provider: harness.provider,
      backend,
      journal,
      clock,
      catalog: context.catalog,
      playerId,
    };
    return createRuntime === undefined
      ? createCommerceConformanceRuntime(runtimeInput)
      : createRuntime(runtimeInput, { ...context, playerId });
  };
  const runtime = await createRuntimeFor(ids.playerId);
  return { vector, harness, runtime, createRuntimeFor, backend, journal, clock, adaptation };
}

/** Runs every step; a thrown step ends the run with a failure at that step. */
async function executeSteps(
  execution: Execution,
  adaptation: StepAdaptation | undefined,
): Promise<CommerceConformanceFailure[]> {
  const failures: CommerceConformanceFailure[] = [];
  execution.adaptation.current = adaptation;
  const context: StepContext = {
    harness: execution.harness,
    backend: execution.backend,
    clock: execution.clock,
    failures,
    get runtime() {
      return execution.runtime;
    },
    async switchPlayer(playerId) {
      await execution.runtime.stop();
      execution.runtime = await execution.createRuntimeFor(playerId);
    },
  };
  for (const [index, step] of execution.vector.steps.entries()) {
    const path = `steps[${index}]`;
    try {
      await runStep(step, path, context);
      await execution.runtime.runUntilIdle();
    } catch (error) {
      failures.push({
        path,
        expected: `${step.actor}.${step.action} completes`,
        actual: describeError(error),
      });
      break;
    }
  }
  return failures;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// Adaptive vectors (RFC "Conformance vectors", adaptive vectors).

/**
 * Members of the `purchase-<owner>-finish` family describe the same purchase
 * under different fixture finish owners; a provider runs the one named after
 * its own owner, or the first by name when none is (`finish: 'none'`).
 */
const purchaseFinishFamily = /^purchase-(?:client|server|host|none)-finish$/u;

export function isAdaptiveCommerceConformanceVector(vector: CommerceConformanceVector): boolean {
  return vector.profile.adaptive === true;
}

/**
 * Why an adaptive vector does not apply to a provider with `capabilities`, or
 * `undefined` when it runs. `set` is the whole run (for duplicate detection).
 * The rules:
 *
 * - a `game.requestPurchase` of a product kind the provider does not sell
 *   (`purchase.<kind>` false, by the vector catalog), or with a quantity above
 *   one without `purchase.quantity`, cannot open the store UI;
 * - a store-side `pending` purchase needs `lifecycle.pending`;
 * - a store `error` event needs `lifecycle.events`;
 * - without `lifecycle.events`, a store `complete` or `update` reaches the
 *   reconciler only by polling, so the next `runtime` step after it must be
 *   `reconcile` or `start`;
 * - a `queueFinish` script needs a `client` or `host` finish owner, since the
 *   provider never calls `finishTransaction` under `server` or `none`;
 * - within the `purchase-<owner>-finish` family only one member runs: the
 *   one named after the provider's owner, else the first by name.
 */
export function commerceConformanceAdaptiveSkipReason(
  vector: CommerceConformanceVector,
  capabilities: CommerceCapabilities,
  set: readonly CommerceConformanceVector[] = [vector],
): string | undefined {
  return adaptiveSkipReasonWith(vector, capabilities, purchaseFinishFamilyOf(set));
}

function adaptiveSkipReasonWith(
  vector: CommerceConformanceVector,
  capabilities: CommerceCapabilities,
  family: readonly CommerceConformanceVector[],
): string | undefined {
  const stepReason = stepSkipReason(vector, capabilities);
  if (stepReason !== undefined) {
    return stepReason;
  }
  if (purchaseFinishFamily.test(vector.vector)) {
    const owner = capabilities.lifecycle.finish;
    // The canonical member must itself be runnable here, so a provider whose
    // capabilities rule out the member named after its owner still runs one.
    const runnable = family.filter((member) => stepSkipReason(member, capabilities) === undefined);
    const named = runnable.find((member) => member.vector === `purchase-${owner}-finish`);
    const canonical = (named ?? runnable[0])?.vector;
    if (canonical !== undefined && canonical !== vector.vector) {
      return `duplicate of ${canonical} for finish='${owner}'`;
    }
  }
  return undefined;
}

/** The step-level rules of `commerceConformanceAdaptiveSkipReason`, without the family rule. */
function stepSkipReason(
  vector: CommerceConformanceVector,
  capabilities: CommerceCapabilities,
): string | undefined {
  const { lifecycle, purchase } = capabilities;
  const owner = lifecycle.finish;
  const catalog = vector.catalog ?? [];
  const steps = vector.steps;
  for (const [index, step] of steps.entries()) {
    if (step.actor === 'game' && step.action === 'requestPurchase') {
      const kind = catalog.find((entry) => entry.logicalId === step.input.logicalId)?.kind;
      if (kind !== undefined && !purchase[kind]) {
        return `requestPurchase of ${step.input.logicalId} needs purchase.${kind}; `
          + `the provider declares ${kind}: false`;
      }
      const quantity = step.input.quantity ?? 1;
      if (quantity > 1 && !purchase.quantity) {
        return `requestPurchase of ${step.input.logicalId} with quantity ${String(quantity)} needs `
          + 'purchase.quantity; the provider declares quantity: false';
      }
      continue;
    }
    if (step.actor !== 'store') {
      continue;
    }
    if (
      !lifecycle.pending
      && ((step.action === 'complete' || step.action === 'update') && step.purchase.state === 'pending'
        || (step.action === 'queueRequest'
          && step.result.outcome === 'purchased'
          && step.result.purchase.state === 'pending'))
    ) {
      return 'store-side pending purchase needs lifecycle.pending; the provider declares pending: false';
    }
    if (step.action === 'error' && !lifecycle.events) {
      return 'purchaseError event needs lifecycle.events; the provider declares events: false';
    }
    if ((step.action === 'complete' || step.action === 'update') && !lifecycle.events) {
      // Polling ingests the purchase at the next reconcile or start; a step in
      // between that would have observed the event-driven grant or finish
      // (another store script, a ledger write) makes the scenario timing-bound.
      const prefix = `store.${step.action} at steps[${String(index)}] needs lifecycle.events; `
        + 'the provider declares events: false';
      if (!lifecycle.availablePurchases) {
        return `${prefix} and lifecycle.availablePurchases: false, so nothing can poll the purchase`;
      }
      let polled = false;
      for (const [offset, later] of steps.slice(index + 1).entries()) {
        if (later.actor === 'runtime') {
          if (later.action === 'stop') {
            break;
          }
          polled = true;
          break;
        }
        if (later.actor === 'clock' || (later.actor === 'backend' && later.action === 'queueVerify')) {
          continue;
        }
        return `${prefix} and ${later.actor}.${later.action} at steps[${String(index + 1 + offset)}] `
          + 'runs before the reconcile or start that would poll the purchase';
      }
      if (!polled) {
        return `${prefix} and no reconcile or start follows it to poll the purchase`;
      }
    }
    if (step.action === 'queueFinish' && owner !== 'client' && owner !== 'host') {
      return `queueFinish scripts a client finish; the provider declares finish: '${owner}'`;
    }
  }
  return undefined;
}

/** The adaptive `purchase-<owner>-finish` members of a run, sorted by name. */
function purchaseFinishFamilyOf(
  set: readonly CommerceConformanceVector[],
): readonly CommerceConformanceVector[] {
  return set
    .filter((candidate) => candidate.profile.adaptive === true && purchaseFinishFamily.test(candidate.vector))
    .sort((left, right) => (left.vector < right.vector ? -1 : left.vector > right.vector ? 1 : 0));
}

interface StepAdaptation {
  /**
   * The provider finishes on the server but the vector was written for another
   * owner: the fake backend answers the reconciler's finalization re-read of a
   * granted key as completed from its own grant state (`finalizeOnReread`).
   */
  readonly serverFinalization: boolean;
}

function adaptationFor(
  vector: CommerceConformanceVector,
  capabilities: CommerceCapabilities,
): StepAdaptation {
  const fixtureOwner = createCommerceConformanceCapabilities(vector.profile).lifecycle.finish;
  return {
    serverFinalization: capabilities.lifecycle.finish === 'server' && fixtureOwner !== 'server',
  };
}

/**
 * The vector with every scripted store purchase (`complete`, `update`, and a
 * `queueRequest` answering `purchased`) carrying the token the store actor
 * reports for it (`CommerceConformanceStoreActor.tokenOf`).
 */
export function withStoreTokens(
  vector: CommerceConformanceVector,
  tokenOf: (purchase: CommerceConformancePurchaseFixture) => string,
): CommerceConformanceVector {
  const withToken = (
    purchase: CommerceConformancePurchaseFixture,
  ): CommerceConformancePurchaseFixture => ({ ...purchase, token: tokenOf(purchase) });
  return {
    ...vector,
    steps: vector.steps.map((step) => {
      if (step.actor !== 'store') {
        return step;
      }
      if (step.action === 'complete' || step.action === 'update') {
        return { ...step, purchase: withToken(step.purchase) };
      }
      if (step.action === 'queueRequest' && step.result.outcome === 'purchased') {
        return { ...step, result: { ...step.result, purchase: withToken(step.result.purchase) } };
      }
      return step;
    }),
  };
}

/** The vector with the provider's store id and declared capabilities as its profile. */
function referenceVectorFor(
  vector: CommerceConformanceVector,
  store: StoreId,
  capabilities: CommerceCapabilities,
): CommerceConformanceVector {
  return {
    ...vector,
    profile: {
      store,
      purchase: capabilities.purchase,
      lifecycle: capabilities.lifecycle,
      authority: capabilities.authority,
      adaptive: true,
    },
  };
}

/**
 * Derives the adaptive expectation for `vector` from the observable state of a
 * finished reference run under the provider's capabilities, applying the
 * rules the RFC table states:
 *
 * - `journal`: the reference journal, so the tail after `granted` is
 *   `finishing, finished` for `client`, `host`, and `server` owners and
 *   `finished` for `none`; derived keys carry the provider's store id;
 * - `finishCalls`: the reference store's calls, `by` the owner for `client`
 *   and `host`, none for `server` and `none`;
 * - `verifyRequests`: the reference backend's log, with the finalization
 *   re-read a `server` owner adds unless the grant already reported
 *   `finalization: 'completed'`;
 * - `available`: what the reference store still lists once idle, so empty
 *   after a completed finish for `client`, `host`, and `server` owners.
 *
 * Fields the fixture does not assert stay unasserted. The derivation is
 * refused (a skip reason) when the reference run does not end every journal
 * key in the fixture's terminal state, since the scenario then depends on a
 * capability the provider lacks.
 */
export async function deriveAdaptiveCommerceConformanceExpectation(
  vector: CommerceConformanceVector,
  reference: {
    readonly store: StoreId;
    readonly journal: Readonly<Record<string, readonly CommercePurchaseState[]>>;
    readonly verifyRequests: readonly CommerceVerifyRequest[];
    readonly finishCalls: readonly CommerceConformanceFinishCall[];
    /** What the reference store still lists (pending included) once the run is idle. */
    readonly available: readonly StorePurchase[];
  },
): Promise<
  | { readonly expect: CommerceConformanceResolvedExpectation; readonly reason?: undefined }
  | { readonly expect?: undefined; readonly reason: string }
> {
  const { expect } = vector;
  if (expect.journal !== undefined) {
    const adapted = new Map<string, string>();
    for (const fixtureKey of Object.keys(expect.journal)) {
      adapted.set(fixtureKey, await adaptDerivedPurchaseKey(vector, fixtureKey, reference.store));
    }
    for (const [fixtureKey, states] of Object.entries(expect.journal)) {
      const key = adapted.get(fixtureKey) ?? fixtureKey;
      const terminal = states.at(-1);
      const actual = reference.journal[key]?.at(-1);
      if (actual !== terminal) {
        return {
          reason: `the reference run under the provider capabilities ends ${key} in `
            + `'${String(actual)}', not '${String(terminal)}'`,
        };
      }
    }
    const expectedKeys = new Set(adapted.values());
    const extra = Object.keys(reference.journal).filter((key) => !expectedKeys.has(key));
    if (extra.length > 0) {
      return {
        reason: `the reference run under the provider capabilities journals ${extra.join(', ')}, `
          + 'which the vector does not expect',
      };
    }
  }
  return {
    expect: {
      ...expect,
      ...(expect.journal === undefined ? {} : { journal: reference.journal }),
      ...(expect.verifyRequests === undefined
        ? {}
        : {
            verifyRequests: reference.verifyRequests.map((request) => ({
              idempotencyKey: request.idempotencyKey,
              store: request.store,
              transactionId: request.transactionId,
              token: request.token,
            })),
          }),
      ...(expect.finishCalls === undefined ? {} : { finishCalls: reference.finishCalls }),
      ...(expect.available === undefined
        ? {}
        : {
            available: reference.available.map((purchase) => ({
              transactionId: purchase.transactionId,
              storeSku: purchase.storeSku,
              state: purchase.state,
            })),
          }),
    },
  };
}

/**
 * A fixture journal key as the provider's store id derives it: only the
 * encoded store segment of a `store:<store>:<transactionId>` key
 * (`createDerivedPurchaseIdempotencyKey`) is replaced, so a transaction id
 * that happens to contain the fixture store id is left alone. Game-chosen
 * keys and store-specific key forms carry no such prefix and pass through.
 */
export function adaptDerivedPurchaseKeyStore(
  key: string,
  fixtureStore: string,
  providerStore: string,
): string {
  const fixturePrefix = `store:${encodeURIComponent(fixtureStore)}:`;
  return key.startsWith(fixturePrefix)
    ? `store:${encodeURIComponent(providerStore)}:${key.slice(fixturePrefix.length)}`
    : key;
}

/**
 * A fixture journal key as the provider's store id derives it. When the key is
 * the derived key of a purchase the vector scripts under the fixture store, it
 * is re-derived with `createDerivedPurchaseIdempotencyKey` for the provider
 * store, which also covers the store-specific key forms (`google-play` token
 * keys, `apps-in-toss:purchase:<id>`); otherwise only the generic
 * `store:<store>:` prefix is swapped (`adaptDerivedPurchaseKeyStore`).
 */
export async function adaptDerivedPurchaseKey(
  vector: CommerceConformanceVector,
  key: string,
  providerStore: string,
): Promise<string> {
  const fixtureStore = vector.profile.store;
  for (const purchase of scriptedPurchasesOf(vector)) {
    const derive = (store: string): Promise<string> =>
      createDerivedPurchaseIdempotencyKey({
        store,
        transactionId: purchase.transactionId,
        token: purchase.token,
      });
    if (await derive(fixtureStore) === key) {
      return derive(providerStore);
    }
  }
  return adaptDerivedPurchaseKeyStore(key, fixtureStore, providerStore);
}

function scriptedPurchasesOf(
  vector: CommerceConformanceVector,
): readonly CommerceConformancePurchaseFixture[] {
  return vector.steps.flatMap((step) => {
    if (step.actor !== 'store') {
      return [];
    }
    if (step.action === 'complete' || step.action === 'update') {
      return [step.purchase];
    }
    return step.action === 'queueRequest' && step.result.outcome === 'purchased'
      ? [step.result.purchase]
      : [];
  });
}

async function deriveAdaptiveExpectation(
  vector: CommerceConformanceVector,
  reference: Execution,
  store: StoreId,
): Promise<Awaited<ReturnType<typeof deriveAdaptiveCommerceConformanceExpectation>>> {
  return deriveAdaptiveCommerceConformanceExpectation(vector, {
    store,
    journal: reference.journal.snapshot(),
    verifyRequests: reference.backend.verifyRequests,
    finishCalls: reference.harness.store?.finishCalls ?? [],
    available: await reference.harness.provider.getAvailablePurchases({ includePending: true }),
  });
}

interface StepContext {
  readonly harness: CommerceConformanceHarness;
  readonly runtime: CommerceConformanceRuntime;
  readonly backend: CommerceConformanceBackend;
  readonly clock: CommerceConformanceClock;
  readonly failures: CommerceConformanceFailure[];
  switchPlayer(playerId: string): Promise<void>;
}

function storeActorOf(context: StepContext, step: CommerceConformanceStep): CommerceConformanceStoreActor {
  if (context.harness.store === undefined) {
    throw new CommerceConformanceScriptError(
      `The harness has no store actor for ${step.actor}.${step.action}.`,
    );
  }
  return context.harness.store;
}

function walletActorOf(
  context: StepContext,
  step: CommerceConformanceStep,
): CommerceConformanceWalletActor {
  if (context.harness.wallet === undefined) {
    throw new CommerceConformanceScriptError(
      `The harness has no wallet actor for ${step.actor}.${step.action}.`,
    );
  }
  return context.harness.wallet;
}

async function runStep(
  step: CommerceConformanceStep,
  path: string,
  context: StepContext,
): Promise<void> {
  switch (step.actor) {
    case 'runtime':
      switch (step.action) {
        case 'start':
          await context.runtime.start();
          return;
        case 'stop':
          await context.runtime.stop();
          return;
        case 'reconcile':
          await context.runtime.reconcile();
          return;
        case 'restore': {
          const runtime = context.runtime;
          if (runtime.restorePurchases === undefined) {
            throw new CommerceConformanceScriptError(
              'The runtime under test has no restorePurchases for runtime.restore.',
            );
          }
          await runtime.restorePurchases();
          return;
        }
        case 'switchPlayer':
          await context.switchPlayer(step.playerId);
          return;
      }
      return;
    case 'game':
      if (step.action === 'requestPurchase') {
        const result = await context.runtime.requestPurchase({
          logicalId: step.input.logicalId,
          idempotencyKey: step.input.idempotencyKey,
          source: step.input.source ?? 'shop',
          ...(step.input.offerId === undefined ? {} : { offerId: step.input.offerId }),
          ...(step.input.quantity === undefined ? {} : { quantity: step.input.quantity }),
        });
        if (step.returns !== undefined) {
          matchPartial(step.returns, result, `${path}.returns`, context.failures);
        }
        return;
      }
      if (step.action === 'fetchProducts') {
        const products = await context.runtime.fetchProducts(step.input ?? {});
        if (step.returns !== undefined) {
          matchPartial(
            step.returns,
            { logicalIds: products.map((product) => product.logicalId) },
            `${path}.returns`,
            context.failures,
          );
        }
      }
      return;
    case 'store': {
      const store = storeActorOf(context, step);
      switch (step.action) {
        case 'complete':
          store.complete(step.purchase);
          return;
        case 'update':
          store.update(step.purchase);
          return;
        case 'error':
          store.error({
            ...(step.logicalId === undefined ? {} : { logicalId: step.logicalId }),
            error: step.error,
          });
          return;
        case 'queueRequest':
          store.queueRequest(step.result);
          return;
        case 'queueFinish':
          store.queueFinish(step.result);
          return;
      }
      return;
    }
    case 'backend':
      switch (step.action) {
        case 'queueVerify':
          context.backend.queueVerify(step.decision);
          return;
        case 'push':
          context.backend.push({
            transactionId: step.transactionId,
            entryId: step.entryId,
            logicalId: step.logicalId,
          });
          return;
        case 'revoke':
          context.backend.revoke({
            ledgerEntryId: step.ledgerEntryId,
            entryId: step.entryId,
            reason: step.reason,
          });
          return;
      }
      return;
    case 'wallet': {
      const wallet = walletActorOf(context, step);
      switch (step.action) {
        case 'creditFromGrant':
          wallet.creditFromGrant(step.lot);
          return;
        case 'spend': {
          const result = await wallet.spend(step.input);
          if (step.returns !== undefined) {
            matchPartial(step.returns, result, `${path}.returns`, context.failures);
          }
          return;
        }
        case 'renewDue':
          await wallet.renewDue();
          return;
      }
      return;
    }
    case 'clock':
      context.clock.set(step.at);
      return;
  }
}

interface ExpectationContext {
  readonly harness: CommerceConformanceHarness;
  readonly runtime: CommerceConformanceRuntime;
  readonly backend: CommerceConformanceBackend;
  readonly journal: CommerceConformanceJournal;
  readonly failures: CommerceConformanceFailure[];
}

async function matchExpectations(
  expect: CommerceConformanceResolvedExpectation,
  context: ExpectationContext,
): Promise<void> {
  const { failures, harness } = context;
  if (expect.journal !== undefined) {
    const actual = context.journal.snapshot();
    const expectedKeys = Object.keys(expect.journal);
    const actualKeys = Object.keys(actual);
    if (!sameStrings(expectedKeys, actualKeys)) {
      failures.push({ path: 'journal', expected: expectedKeys, actual: actualKeys });
    }
    for (const key of expectedKeys) {
      matchPartial(expect.journal[key], actual[key], `journal.${key}`, failures);
    }
  }
  if (expect.parked !== undefined) {
    const parked: Record<string, string> = {};
    for (const key of context.journal.keys) {
      const record = await context.journal.read(key);
      if (record?.anotherAccount !== undefined && isCommerceJournalRecordParked(record)) {
        parked[key] = record.anotherAccount.reason;
      }
    }
    const expectedKeys = Object.keys(expect.parked);
    if (!sameStrings(expectedKeys, Object.keys(parked))) {
      failures.push({ path: 'parked', expected: expectedKeys, actual: Object.keys(parked) });
    }
    for (const key of expectedKeys) {
      matchPartial(expect.parked[key], parked[key], `parked.${key}`, failures);
    }
  }
  if (expect.verifyRequests !== undefined) {
    matchPartial(expect.verifyRequests, context.backend.verifyRequests, 'verifyRequests', failures);
  }
  if (expect.ledger !== undefined) {
    matchPartial(expect.ledger, context.backend.ledger, 'ledger', failures);
  }
  if (expect.finishCalls !== undefined) {
    matchPartial(expect.finishCalls, harness.store?.finishCalls ?? [], 'finishCalls', failures);
  }
  if (expect.purchaseUiOpened !== undefined) {
    matchPartial(
      expect.purchaseUiOpened,
      harness.store?.purchaseUiOpened ?? 0,
      'purchaseUiOpened',
      failures,
    );
  }
  if (expect.available !== undefined) {
    const available = await harness.provider.getAvailablePurchases({ includePending: true });
    matchPartial(expect.available, available, 'available', failures);
  }
  if (expect.entitlements !== undefined) {
    matchPartial(expect.entitlements, context.backend.entitlements(), 'entitlements', failures);
  }
  if (expect.lots !== undefined) {
    matchPartial(expect.lots, harness.wallet?.lots ?? [], 'lots', failures);
  }
  if (expect.balances !== undefined) {
    for (const [titleId, expected] of Object.entries(expect.balances)) {
      const balance = harness.wallet === undefined
        ? {}
        : (await harness.wallet.getBalance({ titleId })).balances;
      matchPartial(expected, balance, `balances.${titleId}`, failures);
    }
  }
  if (expect.debits !== undefined) {
    matchPartial(expect.debits, harness.wallet?.debits ?? [], 'debits', failures);
  }
  if (expect.events !== undefined) {
    matchPartial(expect.events, harness.wallet?.subscriptionEvents ?? [], 'events', failures);
  }
  if (expect.activeSubscriptions !== undefined) {
    const active = harness.provider.getActiveSubscriptions === undefined
      ? await (harness.wallet?.getActiveSubscriptions() ?? Promise.resolve([]))
      : await harness.provider.getActiveSubscriptions();
    matchPartial(expect.activeSubscriptions, active, 'activeSubscriptions', failures);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/**
 * Partial match: an expected object asserts only its listed keys, an expected
 * array asserts its length and each element in order, and primitives compare
 * strictly. Failures name the deepest differing path.
 */
export function matchPartial(
  expected: unknown,
  actual: unknown,
  path: string,
  failures: CommerceConformanceFailure[],
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      failures.push({ path, expected, actual });
      return;
    }
    if (expected.length !== actual.length) {
      failures.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
      return;
    }
    expected.forEach((item, index) => {
      matchPartial(item, actual[index], `${path}[${index}]`, failures);
    });
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      failures.push({ path, expected, actual });
      return;
    }
    const record = actual as Readonly<Record<string, unknown>>;
    for (const [key, value] of Object.entries(expected)) {
      matchPartial(value, record[key], `${path}.${key}`, failures);
    }
    return;
  }
  if (expected !== actual) {
    failures.push({ path, expected, actual });
  }
}
