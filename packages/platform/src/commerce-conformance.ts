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
  type CommerceLogicalProductId,
  type CommerceProvider,
  type CommercePurchaseState,
  type CreditBalance,
  type CreditDebit,
  type CreditEntitlement,
  type CreditLot,
  type CreditLotSpendScope,
  type CreditMembershipTerms,
  type CreditOffer,
  type CreditSpendInput,
  type CreditSpendResult,
  type CreditWalletClient,
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
  CommerceConformanceFinishResultFixture,
  CommerceConformanceLotFixture,
  CommerceConformanceProfile,
  CommerceConformancePurchaseFixture,
  CommerceConformanceRequestResultFixture,
  CommerceConformanceStep,
  CommerceConformanceSubscriptionEventType,
  CommerceConformanceVector,
  CommerceConformanceVerifyDecision,
} from './commerce-vectors.js';
import type { PlatformEvidenceEnvelope } from './index.js';

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
 * SDK; the reconciler, journal, backend, and matcher stay shared.
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

/** Canonical `YYYY-MM-DDTHH:mm:ssZ`; milliseconds are kept only when non-zero. */
export function normalizeIsoTimestamp(input: string): string {
  const millis = Date.parse(input);
  if (Number.isNaN(millis)) {
    throw new TypeError(`Invalid ISO-8601 timestamp: ${input}`);
  }
  return formatIsoTimestamp(millis);
}

function formatIsoTimestamp(millis: number): string {
  const iso = new Date(millis).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

/** Adds an ISO-8601 duration (`P30D`, `P1M`, `PT12H`, ...) to a timestamp, in UTC calendar units. */
export function addIsoDuration(at: string, duration: string): string {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u
    .exec(duration);
  if (match === null || duration === 'P' || duration === 'PT') {
    throw new TypeError(`Invalid ISO-8601 duration: ${duration}`);
  }
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const date = new Date(normalizeIsoTimestamp(at));
  date.setUTCFullYear(
    date.getUTCFullYear() + Number(years ?? 0),
    date.getUTCMonth() + Number(months ?? 0),
    date.getUTCDate() + Number(weeks ?? 0) * 7 + Number(days ?? 0),
  );
  date.setUTCHours(
    date.getUTCHours() + Number(hours ?? 0),
    date.getUTCMinutes() + Number(minutes ?? 0),
    date.getUTCSeconds() + Number(seconds ?? 0),
  );
  return formatIsoTimestamp(date.getTime());
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
      return purchases.filter((purchase) => includePending || purchase.state !== 'pending');
    },
    async finishTransaction(request: FinishTransactionInput): Promise<FinishTransactionResult> {
      const by = finishOwner === 'host' ? 'host' : 'client';
      const queued = finishQueue.shift() ?? { finished: true };
      if ('error' in queued) {
        finishCalls.push({ by, ...request, result: queued.error });
        throw new CommerceError(queued.error, { message: 'Fixture finish failure.' });
      }
      finishCalls.push({ by, ...request, result: queued.finished ? 'finished' : 'unfinished' });
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
  entry: CommerceConformanceCatalogEntry,
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
}

export interface CommerceVerifyResponse {
  readonly status: 'granted' | 'pending' | 'rejected';
  readonly ledgerEntryId?: string;
  /** Reported for `lifecycle.finish: 'server'` stores. */
  readonly finalization?: 'pending' | 'completed';
  readonly alreadyProcessed?: boolean;
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
  /** Writes a server-push grant keyed by transaction id. */
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
}

/**
 * Fake backend: every verify call consumes the next `queueVerify` decision in
 * order and is logged; an unqueued verify is an unscripted operation. A
 * `granted` decision makes sure the ledger holds the entry, so a replayed
 * grant and a host-pushed grant never create a second entry.
 */
export function createCommerceConformanceBackend(
  input: CreateCommerceConformanceBackendInput = {},
): CommerceConformanceBackend {
  const decisions: CommerceConformanceVerifyDecision[] = [];
  const verifyRequests: CommerceVerifyRequest[] = [];
  const ledger: CommerceLedgerEntry[] = [];

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
      const decision = decisions.shift();
      if (decision === undefined) {
        throw new CommerceConformanceScriptError(
          `Unscripted verify for ${request.idempotencyKey} (${request.store}/${request.transactionId}); `
            + 'queue a backend.queueVerify decision.',
        );
      }
      if (decision.status !== 'granted') {
        return { status: decision.status };
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
      if (findEntry(grant.entryId) !== undefined) {
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
  /** The purchase idempotency key: the game's key or a derived key. */
  readonly key: string;
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
  /** Every state revision of a key, in write order. */
  history(key: string): readonly CommercePurchaseState[];
  /** `history` for every key, in creation order. */
  snapshot(): Readonly<Record<string, readonly CommercePurchaseState[]>>;
}

/** In-memory journal that keeps every revision so `expect.journal` can read the full sequence. */
export function createCommerceConformanceJournal(): CommerceConformanceJournal {
  const revisions = new Map<string, CommerceJournalRecord[]>();
  const current = (key: string): CommerceJournalRecord | undefined => revisions.get(key)?.at(-1);
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
        throw new Error(
          `Journal record ${record.key} revision ${expectedRevision + 1} must change its state.`,
        );
      }
      assertCommercePurchaseTransition(existing.state, record.state);
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
      return (revisions.get(key) ?? []).map((record) => record.state);
    },
    snapshot() {
      const snapshot: Record<string, readonly CommercePurchaseState[]> = {};
      for (const [key, history] of revisions) {
        snapshot[key] = history.map((record) => record.state);
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
  };

  // Reconciler step 2: match a reported purchase to a journal record.
  const ingestPurchase = async (purchase: StorePurchase): Promise<void> => {
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
    if (record === undefined) {
      if (purchase.state === 'revoked') {
        return;
      }
      const key = await createDerivedPurchaseIdempotencyKey({
        store: purchase.store,
        transactionId: purchase.transactionId,
        token: purchase.token,
      });
      const existing = await journal.read(key);
      if (existing !== undefined) {
        remember(existing);
        return;
      }
      await create({
        key,
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
      idempotencyKey: record.key,
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
          const request = record.request ?? buildRequest(record);
          const response = await backend.verifyPurchase(request);
          if (response.status === 'pending') {
            await write(record, 'pending', { request });
            return;
          }
          if (response.status === 'rejected') {
            await write(record, 'rejected', { request });
            return;
          }
          if (response.ledgerEntryId === undefined) {
            throw new CommerceConformanceScriptError(
              `A granted verify response for ${record.key} must carry a ledgerEntryId.`,
            );
          }
          finalization = response.finalization;
          record = await write(record, 'granted', { request, ledgerEntryId: response.ledgerEntryId });
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
      await running;
      return;
    }
    running = (async () => {
      while (started && triggerPending) {
        triggerPending = false;
        await pass();
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  };

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
      if (capabilities.lifecycle.availablePurchases) {
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
      unsubscribe?.();
      unsubscribe = undefined;
      started = false;
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
    runUntilIdle,
    async requestPurchase(request) {
      const entry = catalogEntry(request.logicalId);
      const existing = await journal.read(request.idempotencyKey);
      if (existing !== undefined) {
        // A key is never regenerated on retry; the journaled attempt is the answer.
        return {
          outcome: 'failed',
          error: new CommerceError('IN_PROGRESS', {
            message: `Idempotency key ${request.idempotencyKey} is already journaled.`,
          }).toCommerceErrorInfo(),
        };
      }
      const { record } = await create({
        key: request.idempotencyKey,
        playerId,
        store,
        logicalId: entry.logicalId,
        kind: entry.kind,
        origin: 'game',
        state: 'requested',
      });
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
      const open = (await journal.listRecoverable(playerId)).filter(
        (candidate) =>
          candidate.key !== record.key
          && candidate.store === store
          && candidate.logicalId === entry.logicalId
          && (candidate.state === 'launched' || candidate.state === 'pending'),
      );
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
        // Both states are written, in order, when the store answered synchronously.
        const launched = await write(record, 'launched');
        const purchase = result.purchase;
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

// Reference credit wallet.

export interface CommerceScheduledDebit extends CreditDebit {
  readonly idempotencyKey: string;
}

export interface CommerceConformanceSubscriptionEvent {
  /** Stable id `<subscriptionId>:<periodIndex>:<type>`, so redelivery is idempotent. */
  readonly eventId: string;
  readonly type: CommerceConformanceSubscriptionEventType;
  readonly subscriptionId: string;
  readonly logicalId: CommerceLogicalProductId;
  readonly periodIndex: number;
  readonly expiresAt: string;
  readonly reason?: CommerceErrorCode;
}

export interface CommerceConformanceMembershipStart {
  readonly subscriptionId: string;
  readonly titleId: string;
  readonly logicalId: CommerceLogicalProductId;
  readonly terms: CreditMembershipTerms;
}

export type CommerceConformanceMembershipResult =
  | { readonly status: 'started'; readonly subscription: ActiveSubscription; readonly entitlementId: string }
  | { readonly status: 'rejected'; readonly error: CommerceErrorInfo };

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
  startMembership(input: CommerceConformanceMembershipStart): Promise<CommerceConformanceMembershipResult>;
  subscribe(listener: (event: CommerceEvent) => void): () => void;
}

export interface CreateCommerceConformanceWalletInput {
  readonly store: StoreId;
  readonly clock: CommerceConformanceClock;
  readonly currencies: readonly string[];
  /** Offers served by `listOffers`; defaults to none. */
  readonly offers?: readonly CreditOffer[];
}

interface WalletLot extends CreditLot {
  remaining: number;
}

interface WalletSpend {
  readonly entitlementId: string;
  readonly debits: readonly CreditDebit[];
}

interface WalletEntitlement extends CreditEntitlement {
  redeemed: boolean;
}

interface WalletSubscription {
  readonly subscriptionId: string;
  readonly titleId: string;
  readonly logicalId: CommerceLogicalProductId;
  readonly terms: CreditMembershipTerms;
  periodIndex: number;
  readonly startedAt: string;
  expiresAt: string;
  state: ActiveSubscription['state'];
}

/**
 * Reference in-memory wallet implementing the RFC "Credit lots" and "Billing
 * authority and memberships" rules: lot ids equal ledger entry ids, spend
 * scope derives from the lot origin, spends consume eligible lots in the
 * fixed order, are idempotent by key, and debit nothing on
 * `INSUFFICIENT_BALANCE`; memberships debit `membership:<id>:<period>` per
 * paid period and lapse at period end when the eligible balance runs out.
 */
export function createCommerceConformanceWallet(
  input: CreateCommerceConformanceWalletInput,
): CommerceConformanceWallet {
  const { clock, store } = input;
  const currencies = new Set(input.currencies);
  const lots: WalletLot[] = [];
  const spends = new Map<string, WalletSpend>();
  const debits: CommerceScheduledDebit[] = [];
  const entitlements: WalletEntitlement[] = [];
  const subscriptions = new Map<string, WalletSubscription>();
  const subscriptionEvents: CommerceConformanceSubscriptionEvent[] = [];
  const listeners = new Set<(event: CommerceEvent) => void>();

  const snapshotLot = (lot: WalletLot): CreditLot => ({ ...lot });
  const toEntitlement = (entitlement: WalletEntitlement): CreditEntitlement => ({
    entitlementId: entitlement.entitlementId,
    titleId: entitlement.titleId,
    logicalId: entitlement.logicalId,
    idempotencyKey: entitlement.idempotencyKey,
    createdAt: entitlement.createdAt,
    debits: [...entitlement.debits],
  });
  const toActiveSubscription = (subscription: WalletSubscription): ActiveSubscription => ({
    store,
    logicalId: subscription.logicalId,
    subscriptionId: subscription.subscriptionId,
    periodIndex: subscription.periodIndex,
    state: subscription.state,
    startedAt: subscription.startedAt,
    expiresAt: subscription.expiresAt,
    autoRenew: subscription.state === 'active',
  });
  const emitSubscription = (
    subscription: WalletSubscription,
    type: CommerceConformanceSubscriptionEventType,
    periodIndex: number,
    reason?: CommerceErrorCode,
  ): void => {
    const eventId = `${subscription.subscriptionId}:${periodIndex}:${type}`;
    if (subscriptionEvents.some((event) => event.eventId === eventId)) {
      return;
    }
    subscriptionEvents.push({
      eventId,
      type,
      subscriptionId: subscription.subscriptionId,
      logicalId: subscription.logicalId,
      periodIndex,
      expiresAt: subscription.expiresAt,
      ...(reason === undefined ? {} : { reason }),
    });
    const event: CommerceEvent = {
      type: 'subscriptionUpdated',
      subscription: toActiveSubscription(subscription),
    };
    for (const listener of listeners) {
      listener(event);
    }
  };

  const eligibleLots = (
    titleId: string,
    currency: string,
    scope: 'title' | 'platform',
  ): WalletLot[] => {
    const now = Date.parse(clock.now());
    return lots
      .filter(
        (lot) =>
          lot.currency === currency
          && lot.remaining > 0
          && (lot.expiresAt === undefined || Date.parse(lot.expiresAt) > now)
          && (lot.spendScope.kind === 'cross-title'
            || (scope === 'title' && lot.spendScope.titleId === titleId)),
      )
      .sort(compareCreditLotSpendOrder);
  };

  const spendScoped = async (
    request: CreditSpendInput,
    scope: 'title' | 'platform',
  ): Promise<CreditSpendResult> => {
    const replay = spends.get(request.idempotencyKey);
    if (replay !== undefined) {
      return {
        status: 'debited',
        entitlementId: replay.entitlementId,
        debits: [...replay.debits],
        alreadyProcessed: true,
      };
    }
    if (!currencies.has(request.currency)) {
      return {
        status: 'rejected',
        error: {
          code: 'ITEM_UNAVAILABLE',
          retryable: false,
          message: `Currency ${request.currency} is not declared by the wallet.`,
        },
      };
    }
    if (!(request.amount > 0)) {
      return {
        status: 'rejected',
        error: {
          code: 'INVALID_RESPONSE',
          retryable: false,
          message: 'Spend amount must be positive.',
        },
      };
    }
    const candidates = eligibleLots(request.titleId, request.currency, scope);
    const available = candidates.reduce((sum, lot) => sum + lot.remaining, 0);
    if (available < request.amount) {
      return {
        status: 'rejected',
        error: {
          code: 'INSUFFICIENT_BALANCE',
          retryable: false,
          message: `Eligible ${request.currency} balance ${available} cannot cover ${request.amount}.`,
        },
      };
    }
    const spent: CreditDebit[] = [];
    let remaining = request.amount;
    for (const lot of candidates) {
      if (remaining <= 0) {
        break;
      }
      const amount = Math.min(lot.remaining, remaining);
      lot.remaining -= amount;
      remaining -= amount;
      spent.push({ lotId: lot.lotId, amount });
      debits.push({ idempotencyKey: request.idempotencyKey, lotId: lot.lotId, amount });
    }
    const entitlementId = request.idempotencyKey;
    spends.set(request.idempotencyKey, { entitlementId, debits: spent });
    if (request.logicalId !== undefined) {
      entitlements.push({
        entitlementId,
        titleId: request.titleId,
        logicalId: request.logicalId,
        idempotencyKey: request.idempotencyKey,
        createdAt: clock.now(),
        debits: [...spent],
        redeemed: false,
      });
    }
    return { status: 'debited', entitlementId, debits: [...spent] };
  };

  const renew = async (subscription: WalletSubscription): Promise<void> => {
    while (subscription.state === 'active' && Date.parse(subscription.expiresAt) <= Date.parse(clock.now())) {
      const nextPeriod = subscription.periodIndex + 1;
      const result = await spendScoped(
        {
          titleId: subscription.titleId,
          currency: subscription.terms.price.currency,
          amount: subscription.terms.price.amount,
          idempotencyKey: `membership:${subscription.subscriptionId}:${nextPeriod}`,
        },
        subscription.terms.scope,
      );
      if (result.status === 'rejected') {
        subscription.state = 'lapsed';
        emitSubscription(subscription, 'subscriptionLapsed', nextPeriod, result.error.code);
        return;
      }
      subscription.periodIndex = nextPeriod;
      subscription.expiresAt = addIsoDuration(subscription.expiresAt, subscription.terms.period);
      emitSubscription(subscription, 'subscriptionRenewed', nextPeriod);
    }
  };

  return {
    store,
    get lots() {
      return lots.map(snapshotLot);
    },
    get debits() {
      return [...debits];
    },
    get entitlements() {
      return entitlements.map(toEntitlement);
    },
    get subscriptionEvents() {
      return [...subscriptionEvents];
    },
    creditFromGrant(fixture, options = {}) {
      const existing = lots.find((lot) => lot.lotId === fixture.ledgerEntryId);
      if (existing !== undefined) {
        return snapshotLot(existing);
      }
      if (!currencies.has(fixture.currency)) {
        throw new CommerceConformanceScriptError(
          `Lot ${fixture.ledgerEntryId} uses currency ${fixture.currency}, which the wallet does not declare.`,
        );
      }
      const lot: WalletLot = {
        lotId: fixture.ledgerEntryId,
        currency: fixture.currency,
        amount: fixture.amount,
        remaining: fixture.amount,
        createdAt: normalizeIsoTimestamp(fixture.createdAt),
        ...(fixture.expiresAt === undefined
          ? {}
          : { expiresAt: normalizeIsoTimestamp(fixture.expiresAt) }),
        origin: { ...fixture.origin },
        spendScope: deriveCreditLotSpendScope(fixture.origin, options.spendScope),
      };
      lots.push(lot);
      return snapshotLot(lot);
    },
    spend: (request) => spendScoped(request, 'title'),
    async startMembership(request) {
      const current = subscriptions.get(request.subscriptionId);
      if (current !== undefined && current.state === 'active') {
        return {
          status: 'started',
          subscription: toActiveSubscription(current),
          entitlementId: `membership:${request.subscriptionId}:0`,
        };
      }
      const result = await spendScoped(
        {
          titleId: request.titleId,
          currency: request.terms.price.currency,
          amount: request.terms.price.amount,
          idempotencyKey: `membership:${request.subscriptionId}:0`,
          logicalId: request.logicalId,
        },
        request.terms.scope,
      );
      if (result.status === 'rejected') {
        return result;
      }
      const startedAt = clock.now();
      const subscription: WalletSubscription = {
        subscriptionId: request.subscriptionId,
        titleId: request.titleId,
        logicalId: request.logicalId,
        terms: request.terms,
        periodIndex: 0,
        startedAt,
        expiresAt: addIsoDuration(startedAt, request.terms.period),
        state: 'active',
      };
      subscriptions.set(subscription.subscriptionId, subscription);
      emitSubscription(subscription, 'subscriptionStarted', 0);
      return {
        status: 'started',
        subscription: toActiveSubscription(subscription),
        entitlementId: result.entitlementId,
      };
    },
    async renewDue() {
      for (const subscription of subscriptions.values()) {
        await renew(subscription);
      }
    },
    async listOffers() {
      return [...(input.offers ?? [])];
    },
    async listUnredeemed(request) {
      return entitlements
        .filter((entitlement) => !entitlement.redeemed && entitlement.titleId === request.titleId)
        .map(toEntitlement);
    },
    async redeem(request) {
      const entitlement = entitlements.find(
        (candidate) => candidate.entitlementId === request.entitlementId,
      );
      if (entitlement === undefined) {
        return { redeemed: false };
      }
      entitlement.redeemed = true;
      return { redeemed: true };
    },
    finalize(request) {
      const entitlement = entitlements.find(
        (candidate) => candidate.entitlementId === request.transactionId,
      );
      if (entitlement !== undefined) {
        entitlement.redeemed = true;
      }
    },
    async getBalance(request) {
      const balances: Record<string, number> = {};
      for (const currency of currencies) {
        balances[currency] = eligibleLots(request.titleId, currency, 'title').reduce(
          (sum, lot) => sum + lot.remaining,
          0,
        );
      }
      return { titleId: request.titleId, balances };
    },
    async getActiveSubscriptions() {
      return [...subscriptions.values()]
        .filter((subscription) => subscription.state === 'active')
        .map(toActiveSubscription);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Store lots are title-scoped, off-store lots cross-title, promotion lots as issued (title by default). */
export function deriveCreditLotSpendScope(
  origin: CreditLot['origin'],
  explicit?: CreditLotSpendScope,
): CreditLotSpendScope {
  switch (origin.channel) {
    case 'store':
      return { kind: 'title', titleId: origin.titleId };
    case 'off-store':
      return { kind: 'cross-title' };
    case 'promotion':
      return explicit ?? { kind: 'title', titleId: origin.titleId };
  }
}

/** RFC spend order: earliest `expiresAt` (none last), `title` before `cross-title`, oldest `createdAt`, then `lotId`. */
export function compareCreditLotSpendOrder(left: CreditLot, right: CreditLot): number {
  const leftExpiry = left.expiresAt === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(left.expiresAt);
  const rightExpiry = right.expiresAt === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(right.expiresAt);
  if (leftExpiry !== rightExpiry) {
    return leftExpiry < rightExpiry ? -1 : 1;
  }
  if (left.spendScope.kind !== right.spendScope.kind) {
    return left.spendScope.kind === 'title' ? -1 : 1;
  }
  const createdDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdDelta !== 0) {
    return createdDelta < 0 ? -1 : 1;
  }
  return left.lotId < right.lotId ? -1 : left.lotId > right.lotId ? 1 : 0;
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
 * `CommerceProvider` over the reference wallet: `fetchProducts` lists offers,
 * `requestPurchase` spends (outcome `purchased`, `settlement` set, evidence
 * adapter-settled), `getAvailablePurchases` lists unredeemed entitlements, and
 * finishing is the backend's `redeem`. Memberships exist only where the
 * billing authority is `host`.
 */
export function createCommerceConformanceWalletProvider(
  input: CreateCommerceConformanceWalletProviderInput,
): CommerceProvider {
  const { wallet, catalog, titleId, clock } = input;
  const store = input.profile.store;
  const membershipsOffered = input.billingAuthority === 'host';
  const defaultCurrency = input.currencies[0] ?? 'credits';
  const capabilities = (): CommerceCapabilities => {
    const base = createCommerceConformanceCapabilities(input.profile);
    return {
      ...base,
      purchase: { ...base.purchase, subscription: base.purchase.subscription && membershipsOffered },
    };
  };
  const offered = (entry: CommerceConformanceCatalogEntry): boolean =>
    entry.membership === undefined || membershipsOffered;
  const priceOf = (entry: CommerceConformanceCatalogEntry): CreditOffer['price'] =>
    entry.membership?.price ?? { currency: defaultCurrency, amount: 1 };
  const toPurchase = (
    entry: CommerceConformanceCatalogEntry,
    entitlementId: string,
    createdAt: string,
  ): StorePurchase => ({
    store,
    transactionId: entitlementId,
    storeSku: entry.storeSku,
    logicalId: entry.logicalId,
    quantity: 1,
    state: 'purchased',
    purchasedAt: createdAt,
    token: entitlementId,
    evidence: { schema: `fixture.${store}.entitlement.v1`, payload: { entitlementId } },
    accountBinding: { kind: 'host-identity' },
    settlement: { ledgerEntryId: entitlementId },
  });
  const unavailable = (message: string): RequestPurchaseResult => ({
    outcome: 'failed',
    error: new CommerceError('ITEM_UNAVAILABLE', { message }).toCommerceErrorInfo(),
  });

  return {
    store,
    async getCapabilities() {
      return capabilities();
    },
    async fetchProducts(request) {
      return catalog
        .filter((entry) => offered(entry) && matchesFetchProducts(entry, request))
        .map((entry): StoreProduct => {
          const price = priceOf(entry);
          return {
            logicalId: entry.logicalId,
            store,
            storeSku: entry.storeSku,
            kind: entry.kind,
            title: entry.logicalId,
            description: `Wallet offer ${entry.storeSku}`,
            price: { formatted: `${price.amount} ${price.currency}`, currencyCode: price.currency },
          };
        });
    },
    async requestPurchase(request) {
      const entry = catalog.find((candidate) => candidate.logicalId === request.logicalId);
      if (entry === undefined) {
        return unavailable(`The wallet offers no product ${request.logicalId}.`);
      }
      if (entry.membership !== undefined) {
        if (!membershipsOffered) {
          return unavailable('Memberships are offered only where the billing authority is host.');
        }
        const started = await wallet.startMembership({
          subscriptionId: request.idempotencyKey,
          titleId,
          logicalId: entry.logicalId,
          terms: entry.membership,
        });
        if (started.status === 'rejected') {
          return { outcome: 'failed', error: started.error };
        }
        return {
          outcome: 'purchased',
          purchase: toPurchase(entry, started.entitlementId, started.subscription.startedAt),
        };
      }
      const price = priceOf(entry);
      const spend = await wallet.spend({
        titleId,
        currency: price.currency,
        amount: price.amount * (request.quantity ?? 1),
        idempotencyKey: request.idempotencyKey,
        logicalId: entry.logicalId,
      });
      if (spend.status === 'rejected') {
        return { outcome: 'failed', error: spend.error };
      }
      return { outcome: 'purchased', purchase: toPurchase(entry, spend.entitlementId, clock.now()) };
    },
    async getAvailablePurchases() {
      const unredeemed = await wallet.listUnredeemed({ titleId });
      return unredeemed.flatMap((entitlement) => {
        const entry = catalog.find((candidate) => candidate.logicalId === entitlement.logicalId);
        return entry === undefined
          ? []
          : [toPurchase(entry, entitlement.entitlementId, entitlement.createdAt)];
      });
    },
    async getActiveSubscriptions() {
      return wallet.getActiveSubscriptions();
    },
    subscribe(listener) {
      return wallet.subscribe(listener);
    },
  };
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
  readonly playerId?: string;
  readonly titleId?: string;
}

export interface CommerceConformanceFailure {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface CommerceConformanceVectorResult {
  readonly vector: string;
  readonly passed: boolean;
  readonly failures: readonly CommerceConformanceFailure[];
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
 */
export async function runCommerceConformanceVector(
  vector: CommerceConformanceVector,
  options: CommerceConformanceRunOptions = {},
): Promise<CommerceConformanceVectorResult> {
  const failures: CommerceConformanceFailure[] = [];
  const playerId = options.playerId ?? commerceConformanceDefaultPlayerId;
  const titleId = options.titleId ?? commerceConformanceDefaultTitleId;
  const clock = createCommerceConformanceClock();
  const journal = createCommerceConformanceJournal();
  const harnessRef: { current?: CommerceConformanceHarness } = {};
  const backend = createCommerceConformanceBackend({
    finalize: async (request) => {
      await harnessRef.current?.store?.finalize?.(request);
      await harnessRef.current?.wallet?.finalize?.(request);
    },
  });
  const context: CommerceConformanceContext = {
    vector,
    profile: vector.profile,
    catalog: vector.catalog ?? [],
    playerId,
    titleId,
    clock,
    backend,
    journal,
  };
  const harness = await (options.createProvider ?? createCommerceConformanceHarness)(context);
  harnessRef.current = harness;
  const runtime = createCommerceConformanceRuntime({
    provider: harness.provider,
    backend,
    journal,
    clock,
    catalog: context.catalog,
    playerId,
  });

  for (const [index, step] of vector.steps.entries()) {
    const path = `steps[${index}]`;
    try {
      await runStep(step, path, { harness, runtime, backend, clock, failures });
      await runtime.runUntilIdle();
    } catch (error) {
      failures.push({
        path,
        expected: `${step.actor}.${step.action} completes`,
        actual: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      return { vector: vector.vector, passed: false, failures };
    }
  }

  await matchExpectations(vector, { harness, runtime, backend, journal, failures });
  return { vector: vector.vector, passed: failures.length === 0, failures };
}

export async function runCommerceConformanceVectors(
  vectors: readonly CommerceConformanceVector[],
  options: CommerceConformanceRunOptions = {},
): Promise<readonly CommerceConformanceVectorResult[]> {
  const results: CommerceConformanceVectorResult[] = [];
  for (const vector of vectors) {
    results.push(await runCommerceConformanceVector(vector, options));
  }
  return results;
}

interface StepContext {
  readonly harness: CommerceConformanceHarness;
  readonly runtime: CommerceConformanceRuntime;
  readonly backend: CommerceConformanceBackend;
  readonly clock: CommerceConformanceClock;
  readonly failures: CommerceConformanceFailure[];
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
      if (step.action === 'start') {
        await context.runtime.start();
      } else if (step.action === 'stop') {
        await context.runtime.stop();
      } else {
        await context.runtime.reconcile();
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
  vector: CommerceConformanceVector,
  context: ExpectationContext,
): Promise<void> {
  const { expect } = vector;
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
