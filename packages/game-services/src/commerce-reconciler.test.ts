import type { AnalyticsEvent } from '@mpgd/analytics';
import {
  createUnsupportedCapabilities,
  type PlatformGateway,
  type PlatformPurchasePresentationEvent,
} from '@mpgd/platform';
import {
  createCommerceEventBuffer,
  createGooglePlayTokenPurchaseKey,
  type CommerceCapabilities,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceProvider,
  type CommerceServiceCapabilities,
  type FinishTransactionInput,
  type GetAvailablePurchasesInput,
  type RequestPurchaseResult,
  type StorePurchase,
} from '@mpgd/platform/commerce';

import {
  createGameServicesClient,
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
  type GameServicesBackendApi,
  type PurchaseVerificationApi,
} from './client.js';
import { createGameServicesRouter, createGameServicesRpcFetchHandler } from './server.js';
import {
  assertCommerceFinishAllowed,
  createCommercePurchaseOperationKey,
  createCommerceReconciler,
  toGameServicesPurchaseResult,
  type CommercePurchaseOperationRecord,
  type CommerceReconciler,
  type CommerceReconcilerEvent,
  type CreateCommerceReconcilerInput,
} from './commerce-reconciler.js';
import {
  createInMemoryMonetizationOperationStore,
  isMonetizationOperationRecoverable,
} from './monetization-operation-store.js';
import {
  createRecoverableMonetizationClient,
  type MonetizationOperationStore,
} from './monetization-recovery.js';
import { createGameServicesRuntime } from './runtime.js';
import type {
  PurchaseLedgerStatus,
  PurchaseLedgerStatusRequest,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types.js';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

async function assertRejects(operation: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (pattern.test(String(error))) {
      return;
    }
    throw new Error(`${message}: unexpected rejection ${String(error)}.`);
  }
  throw new Error(`${message}: expected a rejection.`);
}

// Fakes.

interface FakeProvider extends CommerceProvider {
  readonly purchaseUiOpened: number;
  readonly finishCalls: FinishTransactionInput[];
  readonly availableReads: number;
  /** Every `getAvailablePurchases` request, in order. */
  readonly availableRequests: GetAvailablePurchasesInput[];
  readonly restoreCalls: number;
  readonly available: StorePurchase[];
  queueRequest(result: RequestPurchaseResult | { readonly throws: unknown }): void;
  queueFinish(result: { readonly finished: boolean } | { readonly throws: unknown }): void;
  emit(event: CommerceEvent): void;
  /** Lists the purchase and emits `purchaseUpdated` for it. */
  report(purchase: StorePurchase): void;
}

function capabilitiesOf(
  overrides: {
    readonly lifecycle?: Partial<CommerceCapabilities['lifecycle']>;
    readonly authority?: Partial<CommerceCapabilities['authority']>;
    readonly purchase?: Partial<CommerceCapabilities['purchase']>;
  } = {},
): CommerceCapabilities {
  return {
    purchase: {
      consumable: true,
      durable: true,
      subscription: false,
      quantity: false,
      ...overrides.purchase,
    },
    catalog: { products: true, offers: false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: true,
      events: true,
      finish: 'client',
      ...overrides.lifecycle,
    },
    authority: { evidence: 'client-token', accountBinding: 'optional', ...overrides.authority },
    availability: 'available',
  };
}

function createFakeProvider(input: {
  readonly store?: string;
  readonly capabilities?: CommerceCapabilities;
  readonly getCapabilities?: () => Promise<CommerceCapabilities>;
  readonly withFinish?: boolean;
  readonly withRestore?: boolean;
  /** Declares `acceptsFinishRetry`; defaults to true. */
  readonly acceptsFinishRetry?: boolean;
} = {}): FakeProvider {
  const store = input.store ?? 'fake-store';
  const capabilities = input.capabilities ?? capabilitiesOf();
  const available: StorePurchase[] = [];
  const requestQueue: (RequestPurchaseResult | { readonly throws: unknown })[] = [];
  const finishQueue: ({ readonly finished: boolean } | { readonly throws: unknown })[] = [];
  const finishCalls: FinishTransactionInput[] = [];
  const buffer = createCommerceEventBuffer();
  let listener: ((event: CommerceEvent) => void) | undefined;
  let purchaseUiOpened = 0;
  let availableReads = 0;
  const availableRequests: GetAvailablePurchasesInput[] = [];
  let restoreCalls = 0;
  const emit = (event: CommerceEvent): void => {
    if (!capabilities.lifecycle.events) {
      return;
    }
    if (listener === undefined) {
      buffer.push(event);
    } else {
      listener(event);
    }
  };
  const upsert = (purchase: StorePurchase): void => {
    const index = available.findIndex((entry) => entry.transactionId === purchase.transactionId);
    if (index === -1) {
      available.push(purchase);
    } else {
      available[index] = purchase;
    }
  };
  const provider: FakeProvider = {
    store,
    ...(input.acceptsFinishRetry === false ? {} : { acceptsFinishRetry: true }),
    available,
    finishCalls,
    get purchaseUiOpened() {
      return purchaseUiOpened;
    },
    get availableReads() {
      return availableReads;
    },
    availableRequests,
    get restoreCalls() {
      return restoreCalls;
    },
    getCapabilities: input.getCapabilities ?? (async () => ({ ...capabilities })),
    async fetchProducts() {
      return [
        {
          logicalId: 'gems_small',
          store,
          storeSku: 'gems.small',
          kind: 'consumable',
          title: 'Gems',
          description: 'A few gems',
          price: { formatted: '$0.99', currencyCode: 'USD' },
        },
        {
          logicalId: 'remove_ads',
          store,
          storeSku: 'remove.ads',
          kind: 'durable',
          title: 'Remove ads',
          description: 'No ads',
          price: { formatted: '$2.99', currencyCode: 'USD' },
        },
      ];
    },
    async requestPurchase() {
      purchaseUiOpened += 1;
      const queued = requestQueue.shift() ?? { outcome: 'launched' as const };
      if ('throws' in queued) {
        throw queued.throws;
      }
      if (queued.outcome === 'purchased') {
        upsert(queued.purchase);
      }
      return queued;
    },
    async getAvailablePurchases(request = {}) {
      availableReads += 1;
      availableRequests.push(request);
      return available.filter(
        (purchase) =>
          purchase.state !== 'revoked' && (request.includePending === true || purchase.state !== 'pending'),
      );
    },
    ...(input.withFinish === false
      ? {}
      : {
          async finishTransaction(request: FinishTransactionInput) {
            finishCalls.push(request);
            const queued = finishQueue.shift() ?? { finished: true };
            if ('throws' in queued) {
              throw queued.throws;
            }
            if (queued.finished) {
              const index = available.findIndex((entry) => entry.transactionId === request.transactionId);
              if (index !== -1) {
                available.splice(index, 1);
              }
            }
            return { finished: queued.finished };
          },
        }),
    ...(input.withRestore === true
      ? {
          async restorePurchases() {
            restoreCalls += 1;
          },
        }
      : {}),
    subscribe(next) {
      listener = next;
      buffer.drain(next);
      return () => {
        if (listener === next) {
          listener = undefined;
        }
      };
    },
    queueRequest(result) {
      requestQueue.push(result);
    },
    queueFinish(result) {
      finishQueue.push(result);
    },
    emit,
    report(purchase) {
      upsert(purchase);
      emit({ type: 'purchaseUpdated', purchase });
    },
  };
  return provider;
}

function purchaseOf(
  overrides: Partial<StorePurchase> & { readonly transactionId: string },
  store = 'fake-store',
): StorePurchase {
  return {
    store,
    storeSku: 'gems.small',
    logicalId: 'gems_small',
    quantity: 1,
    state: 'purchased',
    token: `token-${overrides.transactionId}`,
    evidence: {
      schema: 'fixture.fake-store.v1',
      payload: { token: `token-${overrides.transactionId}` },
    },
    purchasedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

type Decision =
  | { readonly status: 'granted'; readonly ledgerEntryId: string; readonly finalization?: 'pending' | 'completed' }
  | { readonly status: 'pending' | 'rejected'; readonly reason?: string }
  | { readonly throws: unknown };

interface FakeBackend extends PurchaseVerificationApi {
  readonly requests: VerifyPurchaseRequest[];
  readonly ledgerStatusRequests: PurchaseLedgerStatusRequest[];
  readonly capabilityReads: number;
  queue(decision: Decision): void;
  reverse(ledgerEntryId: string, by: string): void;
}

function createFakeBackend(options: {
  readonly withLedgerStatus?: boolean;
  /** The published capabilities; a backend without them is a v1 backend. */
  readonly serviceCapabilities?: CommerceServiceCapabilities;
  /** The capabilities read answers like a v1 server behind a v2 client adapter: 404. */
  readonly capabilitiesNotFound?: boolean;
  /** The capabilities read never answers. */
  readonly capabilitiesHang?: boolean;
  /** The ledger status read answers like a pre-C2 server: 404. */
  readonly ledgerStatusNotFound?: boolean;
} = {}): FakeBackend {
  const serviceCapabilities = options.serviceCapabilities;
  const ledgerStatusRequests: PurchaseLedgerStatusRequest[] = [];
  let capabilityReads = 0;
  const decisions: Decision[] = [];
  const requests: VerifyPurchaseRequest[] = [];
  const reversed = new Map<string, string>();
  return {
    requests,
    ledgerStatusRequests,
    get capabilityReads() {
      return capabilityReads;
    },
    queue(decision) {
      decisions.push(decision);
    },
    reverse(ledgerEntryId, by) {
      reversed.set(ledgerEntryId, by);
    },
    async verifyPurchase(request) {
      requests.push(request);
      const decision = decisions.shift();
      if (decision === undefined) {
        throw new Error(`Unscripted verify for ${request.idempotencyKey}.`);
      }
      if ('throws' in decision) {
        throw decision.throws;
      }
      if (decision.status !== 'granted') {
        const answer: VerifyPurchaseResponse = {
          verified: false,
          disposition: decision.status,
          alreadyProcessed: false,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        };
        return answer;
      }
      return {
        verified: true,
        ledgerEntryId: decision.ledgerEntryId,
        alreadyProcessed: false,
        ...(decision.finalization === undefined
          ? {}
          : {
              finalization: {
                status: decision.finalization,
                action: 'consume' as const,
                alreadyCompleted: false,
              },
            }),
      };
    },
    ...(serviceCapabilities === undefined
      && options.capabilitiesNotFound !== true
      && options.capabilitiesHang !== true
      ? {}
      : {
          async getCommerceCapabilities(): Promise<CommerceServiceCapabilities> {
            capabilityReads += 1;
            if (options.capabilitiesHang === true) {
              return new Promise<CommerceServiceCapabilities>(() => {});
            }
            if (serviceCapabilities === undefined) {
              throw Object.assign(new Error('not found'), { status: 404 });
            }
            return serviceCapabilities;
          },
        }),
    ...(options.withLedgerStatus === true
      ? {
          async getPurchaseLedgerStatus(input: PurchaseLedgerStatusRequest) {
            ledgerStatusRequests.push(input);
            if (options.ledgerStatusNotFound === true) {
              throw Object.assign(new Error('not found'), { status: 404 });
            }
            return {
              statuses: input.ledgerEntryIds.map((ledgerEntryId): PurchaseLedgerStatus => {
                const by = reversed.get(ledgerEntryId);
                return by === undefined
                  ? { ledgerEntryId, status: 'active' }
                  : { ledgerEntryId, status: 'reversed', reversedBy: by };
              }),
            };
          },
        }
      : {}),
  };
}

interface Harness {
  readonly provider: FakeProvider;
  readonly backend: FakeBackend;
  readonly store: MonetizationOperationStore;
  readonly reconciler: CommerceReconciler;
  readonly transitions: string[];
  readonly failures: string[];
  history(key: string): string[];
}

function createHarness(input: {
  readonly provider?: FakeProvider;
  readonly backend?: FakeBackend;
  readonly store?: MonetizationOperationStore;
  readonly overrides?: Partial<CreateCommerceReconcilerInput>;
} = {}): Harness {
  const provider = input.provider ?? createFakeProvider();
  const backend = input.backend ?? createFakeBackend();
  const store = input.store ?? createInMemoryMonetizationOperationStore();
  const transitions: string[] = [];
  const failures: string[] = [];
  const states = new Map<string, string[]>();
  const reconciler = createCommerceReconciler({
    provider,
    backend,
    store,
    playerId: 'player-1',
    target: 'android',
    now: () => '2026-10-02T00:00:00.000Z',
    onEvent(event: CommerceReconcilerEvent) {
      if (event.type === 'transition') {
        transitions.push(`${event.record.idempotencyKey}:${event.record.state}`);
        const history = states.get(event.record.idempotencyKey) ?? [];
        history.push(event.record.state);
        states.set(event.record.idempotencyKey, history);
      } else if (event.type === 'failure') {
        failures.push(
          `${event.stage}${event.idempotencyKey === undefined ? '' : `(${event.idempotencyKey})`}`,
        );
      }
    },
    ...input.overrides,
  });
  return {
    provider,
    backend,
    store,
    reconciler,
    transitions,
    failures,
    history: (key) => states.get(key) ?? [],
  };
}

function withoutField<K extends keyof CommercePurchaseOperationRecord>(
  record: CommercePurchaseOperationRecord,
  field: K,
): CommercePurchaseOperationRecord {
  const { [field]: _dropped, ...rest } = record;
  return rest as CommercePurchaseOperationRecord;
}

const fullClientHistory = [
  'requested',
  'launched',
  'purchased',
  'verifying',
  'granted',
  'finishing',
  'finished',
];

// 1. The normal client-finish lifecycle, one revision per transition, verify request shape, finish after the grant.
{
  const h = createHarness();
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-1' });
  await h.reconciler.start();
  const result = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-1',
    source: 'shop',
  });
  assertEqual(result, { outcome: 'launched' }, 'the store UI opened and answers later');
  assertEqual(
    h.history('op-1'),
    ['requested', 'launched'],
    'launched is journaled before the event arrives',
  );
  assertEqual(
    h.backend.requests.length,
    0,
    'nothing is verified before the store reports a purchase',
  );
  h.provider.report(purchaseOf({ transactionId: 'tx-1' }));
  await h.reconciler.runUntilIdle();
  assertEqual(h.history('op-1'), fullClientHistory, 'every RFC transition is its own revision');
  assertEqual(h.backend.requests.length, 1, 'one verify request');
  assertEqual(
    h.backend.requests[0],
    {
      target: 'android',
      store: 'fake-store',
      playerId: 'player-1',
      productId: 'gems_small',
      platformTransactionId: 'tx-1',
      idempotencyKey: 'op-1',
      purchasedAt: '2026-10-01T00:00:00.000Z',
      evidence: { schema: 'fixture.fake-store.v1', payload: { token: 'token-tx-1' } },
    },
    'the verify request carries the game key, the store id, the store transaction, its evidence, and the store purchase time',
  );
  assertEqual(
    h.provider.finishCalls,
    [{ transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true }],
    'the client finishes with the ledger entry id after the grant',
  );
  const record = await h.reconciler.read('op-1');
  assertEqual(record?.revision, 6, 'six writes after the reservation');
  assertEqual(record?.ledgerEntryId, 'le-1', 'the ledger entry is journaled');
  assertEqual(record?.origin, 'game', 'a game-started purchase');
  assertEqual(
    (await h.reconciler.listRecoverable()).length,
    0,
    'a finished record is not recoverable',
  );
  assertEqual(
    (await h.store.read(createCommercePurchaseOperationKey('android', 'op-1')))?.kind,
    'commerce-purchase',
    'terminal records stay addressable by key',
  );
  assertEqual(
    toGameServicesPurchaseResult(record as CommercePurchaseOperationRecord),
    {
      status: 'granted',
      purchase: {
        status: 'completed',
        transactionId: 'tx-1',
        entitlementIds: [],
        evidence: { schema: 'fixture.fake-store.v1', payload: { token: 'token-tx-1' } },
      },
      verification: { verified: true, ledgerEntryId: 'le-1', alreadyProcessed: false },
      ledgerEntryId: 'le-1',
    },
    'the journal record maps onto the client purchase result',
  );
  assertEqual(h.failures, [], 'no failure reported');

  // A replayed key answers from the journal and never reopens the store UI.
  const replay = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-1',
    source: 'shop',
  });
  assertEqual(replay.outcome, 'purchased', 'the journaled purchase is the answer');
  assertEqual(h.provider.purchaseUiOpened, 1, 'the store UI opened once per key');
  assertEqual(h.backend.requests.length, 1, 'a replayed key is not verified again');
  await h.reconciler.stop();
}

// 2. A synchronous purchased answer writes launched and purchased in order; durable kind reaches finish.
{
  const h = createHarness();
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-2' });
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({ transactionId: 'tx-2', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  });
  await h.reconciler.start();
  const result = await h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-2',
    source: 'shop',
  });
  assertEqual(result.outcome, 'purchased', 'the store answered synchronously');
  assertEqual(
    h.history('op-2'),
    fullClientHistory,
    'both launched and purchased are written, in order',
  );
  assertEqual(
    h.provider.finishCalls[0]?.isConsumable,
    false,
    'a durable product is finished as non-consumable',
  );
  await h.reconciler.stop();
}

// 3. Store-side pending is never verified until purchased; then one verify.
{
  const h = createHarness();
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-3',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-3', state: 'pending' }));
  await h.reconciler.runUntilIdle();
  await h.reconciler.reconcile();
  assertEqual(
    h.history('op-3'),
    ['requested', 'launched', 'pending'],
    'pending without a saved request waits on the store',
  );
  assertEqual(h.backend.requests.length, 0, 'a store-side pending record is never sent');
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-3' });
  h.provider.report(purchaseOf({ transactionId: 'tx-3', state: 'purchased' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-3'),
    ['requested', 'launched', 'pending', ...fullClientHistory.slice(2)],
    'pending moves to purchased and on to finished',
  );
  assertEqual(h.backend.requests.length, 1, 'verified once');
  await h.reconciler.stop();
}

// 4. Server-side pending keeps the saved request and resends it unchanged; finish 'none' marks finished.
{
  const provider = createFakeProvider({
    capabilities: capabilitiesOf({
      lifecycle: { finish: 'none', availablePurchases: false },
      authority: { evidence: 'server-push', accountBinding: 'host' },
    }),
    withFinish: false,
  });
  const h = createHarness({ provider });
  h.backend.queue({ status: 'pending', reason: 'FULFILLMENT_PENDING' });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-4',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'order-4' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-4'),
    ['requested', 'launched', 'purchased', 'verifying', 'pending'],
    'the backend answered pending',
  );
  const pendingRecord = await h.reconciler.read('op-4');
  assertEqual(
    pendingRecord?.request !== undefined,
    true,
    'the sent request is saved on the pending record',
  );
  assertEqual(
    pendingRecord?.response?.reason,
    'FULFILLMENT_PENDING',
    'the backend reason is journaled',
  );
  assertEqual(h.backend.requests.length, 1, 'one send so far');
  await h.reconciler.reconcile();
  assertEqual(
    h.history('op-4').slice(-2),
    ['pending', 'verifying'],
    'the resend moves pending to verifying; a transport failure keeps verifying',
  );
  assertEqual(h.failures, ['verify(op-4)'], 'the transport failure is reported');
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-4' });
  await h.reconciler.reconcile();
  assertEqual(
    h.history('op-4').slice(-3),
    ['verifying', 'granted', 'finished'],
    'finish none marks finished right after the grant',
  );
  assertEqual(h.backend.requests.length, 3, 'three sends');
  assertEqual(
    JSON.stringify(h.backend.requests[2]),
    JSON.stringify(h.backend.requests[0]),
    'the saved request is resent byte for byte',
  );
  assertEqual(h.provider.finishCalls.length, 0, 'nothing to finish');
  await h.reconciler.stop();
}

// 5. Rejected is terminal, replayable, and excluded from listRecoverable; an undefined disposition rejects too.
{
  const h = createHarness();
  h.backend.queue({ status: 'rejected', reason: 'EVIDENCE_INVALID' });
  await h.reconciler.start();
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({ transactionId: 'tx-5' }),
  });
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-5',
    source: 'shop',
  });
  assertEqual(
    h.history('op-5'),
    ['requested', 'launched', 'purchased', 'verifying', 'rejected'],
    'a definitive non-grant',
  );
  assertEqual((await h.reconciler.listRecoverable()).length, 0, 'rejected is terminal');
  assertEqual(h.provider.finishCalls.length, 0, 'a rejected purchase is never finished');
  const result = toGameServicesPurchaseResult(
    (await h.reconciler.read('op-5')) as CommercePurchaseOperationRecord,
  );
  assertEqual(result.status, 'rejected', 'summary status');
  assertEqual(result.verification?.reason, 'EVIDENCE_INVALID', 'the backend reason is kept');
  await h.reconciler.stop();
}

// 6. Synchronous cancel, cancel event, failure with the store code kept.
{
  const h = createHarness();
  await h.reconciler.start();
  const cancelError: CommerceErrorInfo = {
    code: 'USER_CANCELLED',
    retryable: false,
    storeCode: '1',
  };
  h.provider.queueRequest({ outcome: 'cancelled', error: cancelError });
  const cancelled = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-6a',
    source: 'shop',
  });
  assertEqual(
    cancelled,
    { outcome: 'cancelled', error: cancelError },
    'the synchronous cancel is the answer',
  );
  assertEqual(h.history('op-6a'), ['requested', 'cancelled'], 'a synchronous cancel');
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-6b',
    source: 'shop',
  });
  h.provider.emit({
    type: 'purchaseError',
    logicalId: 'gems_small',
    error: { code: 'USER_CANCELLED', retryable: false, storeCode: 'userCancelled' },
  });
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-6b'),
    ['requested', 'launched', 'cancelled'],
    'a cancel event closes the launched attempt',
  );
  assertEqual(
    (await h.reconciler.read('op-6b'))?.error?.storeCode,
    'userCancelled',
    'the store code is journaled',
  );
  h.provider.queueRequest({
    throws: Object.assign(new Error('store down'), {
      code: 'STORE_UNAVAILABLE',
      retryable: true,
      storeCode: 'fixture-unavailable',
    }),
  });
  const failed = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-6c',
    source: 'shop',
  });
  assertEqual(
    failed.outcome === 'failed' && failed.error.storeCode,
    'fixture-unavailable',
    'a thrown store failure keeps its code',
  );
  assertEqual(h.history('op-6c'), ['requested', 'failed'], 'a store failure');
  // Replaying a cancelled key returns the journaled outcome.
  assertEqual(
    await h.reconciler.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-6a', source: 'shop' }),
    { outcome: 'cancelled', error: cancelError },
    'the journaled cancel is replayed',
  );
  assertEqual(h.provider.purchaseUiOpened, 3, 'the UI opened once per key');
  assertEqual(h.backend.requests.length, 0, 'nothing verified');
  await h.reconciler.stop();
}

// 7. OUTCOME_UNKNOWN and ALREADY_OWNED keep a launched attempt open; the available list resolves it.
{
  const h = createHarness();
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-7',
    source: 'shop',
  });
  h.provider.emit({
    type: 'purchaseError',
    logicalId: 'gems_small',
    error: { code: 'OUTCOME_UNKNOWN', retryable: false },
  });
  h.provider.emit({
    type: 'purchaseError',
    logicalId: 'gems_small',
    error: { code: 'ALREADY_OWNED', retryable: false },
  });
  await h.reconciler.runUntilIdle();
  assertEqual(h.history('op-7'), ['requested', 'launched'], 'the attempt stays open');
  const blocked = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-7b',
    source: 'shop',
  });
  assertEqual(
    blocked.outcome === 'failed' && blocked.error.code,
    'IN_PROGRESS',
    'a second attempt for the same product is refused while one is open',
  );
  assertEqual(await h.reconciler.read('op-7b'), undefined, 'the refused attempt leaves no record');
  assertEqual(h.provider.purchaseUiOpened, 1, 'the store UI did not reopen');
  const other = await h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-7c',
    source: 'shop',
  });
  assertEqual(other.outcome, 'launched', 'another product is not serialized behind it');
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-7' });
  h.provider.available.push(purchaseOf({ transactionId: 'tx-7' }));
  await h.reconciler.restorePurchases();
  assertEqual(
    h.history('op-7'),
    fullClientHistory,
    'the available purchase matched the single open record for the product',
  );
  assertEqual(
    h.backend.requests[0]?.idempotencyKey,
    'op-7',
    'verified under the game key, not a derived one',
  );
  await h.reconciler.stop();
}

// 8. Match order: transaction id first, then the open record, then a derived key; derived forms keep v1 parity.
{
  const h = createHarness();
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-8' });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-8',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-8' }));
  await h.reconciler.runUntilIdle();
  // The store still lists tx-8 until finished; a second report matches by transaction id.
  h.provider.report(purchaseOf({ transactionId: 'tx-8' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-8'),
    fullClientHistory,
    'a re-reported transaction matches its record and verifies once',
  );
  assertEqual(h.backend.requests.length, 1, 'no second verify for the same transaction');
  assertEqual(
    Object.keys(await h.store.listRecoverable('player-1')).length,
    0,
    'no derived record was created',
  );

  // A purchase the journal never saw gets a derived key and starts at its state.
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-8b' });
  h.provider.report(purchaseOf({ transactionId: 'tx:8b' }));
  await h.reconciler.runUntilIdle();
  const derived = 'store:fake-store:tx%3A8b';
  assertEqual(
    h.history(derived),
    ['purchased', 'verifying', 'granted', 'finishing', 'finished'],
    'a discovered purchase starts at purchased under the derived key',
  );
  assertEqual((await h.reconciler.read(derived))?.origin, 'discovered', 'origin discovered');
  assertEqual(h.backend.requests[1]?.idempotencyKey, derived, 'the derived key is the verify key');
  assertEqual(
    h.backend.requests[1]?.intent,
    'restore',
    'a purchase the journal never started is sent as a restore (RFC "Restore sharing")',
  );
  assertEqual(
    h.backend.requests[0]?.intent,
    undefined,
    'a purchase the game started is never sent as a restore',
  );
  // The same purchase reported again finds the finished record by its derived key, even after a restart.
  await h.reconciler.stop();
  h.provider.available.push(purchaseOf({ transactionId: 'tx:8b' }));
  await h.reconciler.start();
  assertEqual(
    h.backend.requests.length,
    2,
    'the finished derived record is read back, not verified again',
  );
  assertEqual(h.failures, [], 'no failure');
  await h.reconciler.stop();
}

// 8b. Google Play and Apps in Toss derived keys keep their v1 forms.
{
  const play = createHarness({
    provider: createFakeProvider({
      store: 'google-play',
      capabilities: capabilitiesOf({ lifecycle: { finish: 'server' } }),
      withFinish: false,
    }),
  });
  play.backend.queue({ status: 'granted', ledgerEntryId: 'le-play', finalization: 'completed' });
  await play.reconciler.start();
  play.provider.report(
    purchaseOf({ transactionId: 'GPA.1', token: 'private-play-token' }, 'google-play'),
  );
  await play.reconciler.runUntilIdle();
  assertEqual(
    play.backend.requests[0]?.idempotencyKey,
    await createGooglePlayTokenPurchaseKey('private-play-token'),
    'play-token-sha256 parity with v1',
  );
  assertEqual(
    play.backend.requests[0]?.idempotencyKey.startsWith('play-token-sha256:'),
    true,
    'the Play key form',
  );
  assertEqual(
    play.history(await createGooglePlayTokenPurchaseKey('private-play-token')),
    ['purchased', 'verifying', 'granted', 'finishing', 'finished'],
    'finalization completed finishes a server-owned purchase',
  );
  await play.reconciler.stop();

  const ait = createHarness({
    provider: createFakeProvider({
      store: 'apps-in-toss',
      capabilities: capabilitiesOf({ lifecycle: { finish: 'host' } }),
    }),
  });
  ait.backend.queue({ status: 'granted', ledgerEntryId: 'le-ait' });
  await ait.reconciler.start();
  ait.provider.report(purchaseOf({ transactionId: 'order-9', token: 'order-9' }, 'apps-in-toss'));
  await ait.reconciler.runUntilIdle();
  assertEqual(
    ait.backend.requests[0]?.idempotencyKey,
    'apps-in-toss:purchase:order-9',
    'apps-in-toss:purchase: parity with v1',
  );
  assertEqual(
    ait.provider.finishCalls,
    [{ transactionId: 'order-9', ledgerEntryId: 'le-ait', isConsumable: true }],
    'the host finish carries the ledger entry',
  );
  await ait.reconciler.stop();
}

// 9. Ambiguity: two open records for one product never both match; the event is reported and skipped.
{
  const h = createHarness();
  await h.reconciler.start();
  // Two launched records for the same product can only exist through a crash
  // between runtimes; seed the second one directly in the journal.
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-9a',
    source: 'shop',
  });
  const first = (await h.reconciler.read('op-9a')) as CommercePurchaseOperationRecord;
  await h.store.reserve({
    ...first,
    key: createCommercePurchaseOperationKey('android', 'op-9b'),
    idempotencyKey: 'op-9b',
    revision: 0,
  });
  await h.reconciler.reconcile();
  h.provider.report(purchaseOf({ transactionId: 'tx-9' }));
  await h.reconciler.runUntilIdle();
  assertEqual(h.failures, ['match(op-9a)'], 'the ambiguous purchase is reported, not guessed');
  assertEqual(h.backend.requests.length, 0, 'nothing is verified');
  await h.reconciler.stop();
}

// 10. Transport failures keep state: verify and finish are retried on the next pass without a second grant.
{
  const h = createHarness();
  h.backend.queue({ throws: new Error('backend unavailable') });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-10',
    source: 'shop',
  });
  h.provider.queueFinish({
    throws: Object.assign(new Error('finish failed'), { code: 'NETWORK', retryable: true }),
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-10' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-10'),
    ['requested', 'launched', 'purchased', 'verifying'],
    'a failed verify keeps verifying',
  );
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-10' });
  await h.reconciler.reconcile();
  assertEqual(
    h.history('op-10'),
    ['requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing'],
    'a failed finish keeps finishing',
  );
  await h.reconciler.reconcile();
  assertEqual(h.history('op-10'), fullClientHistory, 'the finish is retried');
  assertEqual(h.provider.finishCalls.length, 2, 'two finish calls');
  assertEqual(
    h.backend.requests.length,
    2,
    'the verify was retried once; the grant was not requested a third time',
  );
  assertEqual(
    h.failures,
    ['verify(op-10)', 'finish(op-10)'],
    'both transport failures were reported',
  );
  await h.reconciler.stop();
}

// 11. The finish gate: finishTransaction is only ever called for granted or finishing records with a ledger entry.
{
  const granted = {
    state: 'granted',
    ledgerEntryId: 'le-x',
    purchase: purchaseOf({ transactionId: 'tx-x' }),
  } as CommercePurchaseOperationRecord;
  assertEqual(
    assertCommerceFinishAllowed(granted),
    { transactionId: 'tx-x', ledgerEntryId: 'le-x' },
    'a granted record with a ledger entry may be finished',
  );
  assertEqual(
    assertCommerceFinishAllowed({ ...granted, state: 'finishing' }).ledgerEntryId,
    'le-x',
    'and a finishing one',
  );
  for (const state of [
    'requested',
    'launched',
    'pending',
    'purchased',
    'verifying',
    'finished',
    'rejected',
    'revoked',
  ] as const) {
    let threw = false;
    try {
      assertCommerceFinishAllowed({ ...granted, state });
    } catch {
      threw = true;
    }
    assertEqual(threw, true, `${state} is never finished`);
  }
  await assertRejects(
    async () => assertCommerceFinishAllowed(withoutField(granted, 'ledgerEntryId')),
    /no ledger entry id/u,
    'no ledger entry',
  );
  await assertRejects(
    async () => assertCommerceFinishAllowed({ ...granted, ledgerEntryId: ' ' }),
    /no ledger entry id/u,
    'a blank ledger entry',
  );
  await assertRejects(
    async () => assertCommerceFinishAllowed(withoutField(granted, 'purchase')),
    /no store transaction/u,
    'no transaction',
  );

  // A verified answer without a ledger entry never reaches granted, so the gate never opens.
  const h = createHarness({
    backend: {
      ...createFakeBackend(),
      requests: [],
      queue() {},
      reverse() {},
      async verifyPurchase() {
        return { verified: true, alreadyProcessed: false };
      },
    },
  });
  await h.reconciler.start();
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({ transactionId: 'tx-11' }),
  });
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-11',
    source: 'shop',
  });
  assertEqual(
    h.history('op-11'),
    ['requested', 'launched', 'purchased', 'verifying'],
    'a grant without a ledger entry is a malformed answer, retried later',
  );
  assertEqual(
    h.provider.finishCalls.length,
    0,
    'the SDK is never asked to finish without a ledger entry',
  );
  assertEqual(h.failures, ['verify(op-11)'], 'reported');
  await h.reconciler.stop();
}

// 12. Server-owned finish: finishing waits for finalization, re-reading the saved request; completed on first answer needs no re-read.
{
  const provider = createFakeProvider({
    capabilities: capabilitiesOf({ lifecycle: { finish: 'server' } }),
    withFinish: false,
  });
  const h = createHarness({ provider });
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-12', finalization: 'pending' });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-12',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-12' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-12'),
    ['requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing'],
    'finishing until the backend finalizes',
  );
  assertEqual(h.backend.requests.length, 1, 'no re-read in the pass that granted');
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-12', finalization: 'pending' });
  await h.reconciler.reconcile();
  assertEqual(
    h.history('op-12').at(-1),
    'finishing',
    'still finishing while finalization is pending',
  );
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-12', finalization: 'completed' });
  await h.reconciler.reconcile();
  assertEqual(h.history('op-12').at(-1), 'finished', 'finalization completed finishes');
  assertEqual(h.backend.requests.length, 3, 'two finalization re-reads of the same saved request');
  assertEqual(
    h.backend.requests.every(
      (request) => request.idempotencyKey === 'op-12' && request.platformTransactionId === 'tx-12',
    ),
    true,
    'the re-read is the saved request',
  );
  await h.reconciler.stop();
}

// 13. Crash-resume between two writes: a second runtime over the same journal continues from the stored revision.
{
  const store = createInMemoryMonetizationOperationStore();
  const provider = createFakeProvider();
  const first = createHarness({ store, provider });
  first.backend.queue({ status: 'granted', ledgerEntryId: 'le-13' });
  first.provider.queueFinish({ finished: false });
  await first.reconciler.start();
  await first.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-13',
    source: 'shop',
  });
  first.provider.report(purchaseOf({ transactionId: 'tx-13' }));
  await first.reconciler.runUntilIdle();
  assertEqual(first.history('op-13').at(-1), 'finishing', 'the first runtime stopped at finishing');
  await first.reconciler.stop();
  const second = createHarness({ store, provider: createFakeProvider() });
  // The purchase is still listed by the store; the second runtime matches it by transaction id.
  second.provider.available.push(purchaseOf({ transactionId: 'tx-13' }));
  await second.reconciler.start();
  assertEqual(
    second.history('op-13'),
    ['finished'],
    'the second runtime wrote only the missing revision',
  );
  assertEqual(second.backend.requests.length, 0, 'no second verify after a restart');
  assertEqual(
    second.provider.finishCalls,
    [{ transactionId: 'tx-13', ledgerEntryId: 'le-13', isConsumable: true, retry: true }],
    'the finish was retried with the journaled ledger entry, marked as a retry',
  );
  assertEqual(
    (await store.read(createCommercePurchaseOperationKey('android', 'op-13')))?.revision,
    6,
    'the revision continued',
  );
  await second.reconciler.stop();

  // Stopped between purchased and verifying: the resumed runtime sends the saved request once.
  const purchasedOnly = createHarness({ store, provider: createFakeProvider() });
  await purchasedOnly.reconciler.start();
  await purchasedOnly.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-13b',
    source: 'shop',
  });
  await purchasedOnly.reconciler.stop();
  const open = (await store.read(
    createCommercePurchaseOperationKey('android', 'op-13b'),
  )) as CommercePurchaseOperationRecord;
  await store.replace(open.revision, {
    ...open,
    state: 'purchased',
    revision: open.revision + 1,
    purchase: purchaseOf({
      transactionId: 'tx-13b',
      storeSku: 'remove.ads',
      logicalId: 'remove_ads',
    }),
  });
  const resumed = createHarness({ store, provider: createFakeProvider() });
  resumed.backend.queue({ status: 'granted', ledgerEntryId: 'le-13b' });
  await resumed.reconciler.start();
  assertEqual(
    resumed.history('op-13b'),
    ['verifying', 'granted', 'finishing', 'finished'],
    'resumed from purchased',
  );
  assertEqual(
    resumed.backend.requests[0]?.idempotencyKey,
    'op-13b',
    'the game key survives the restart',
  );
  await resumed.reconciler.stop();
}

// 14. Nothing is granted from a provider result: adapter-settled and wallet purchases still go through verify.
{
  const provider = createFakeProvider({
    store: 'credit-wallet',
    capabilities: capabilitiesOf({
      lifecycle: { finish: 'server', events: false },
      authority: { evidence: 'adapter-settled', accountBinding: 'host' },
    }),
    withFinish: false,
  });
  const h = createHarness({ provider });
  h.backend.queue({ status: 'rejected', reason: 'WALLET_SPEND_UNKNOWN' });
  await h.reconciler.start();
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf(
      {
        transactionId: 'spend-14',
        evidence: { schema: 'credit-wallet.spend.v1', payload: { entitlementId: 'ent-14' } },
      },
      'credit-wallet',
    ),
  });
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-14',
    source: 'shop',
  });
  assertEqual(
    h.history('op-14'),
    ['requested', 'launched', 'purchased', 'verifying', 'rejected'],
    'a wallet spend without a settlement pointer is verified, and the backend decides',
  );
  assertEqual(
    h.backend.requests[0]?.evidence?.schema,
    'credit-wallet.spend.v1',
    'the wallet evidence is what the backend sees',
  );

  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-14b', finalization: 'completed' });
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf(
      { transactionId: 'tx-14b', settlement: { ledgerEntryId: 'le-settled' } },
      'credit-wallet',
    ),
  });
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-14b',
    source: 'shop',
  });
  assertEqual(
    h.history('op-14b'),
    fullClientHistory,
    'an adapter-settled purchase is confirmed through verify',
  );
  assertEqual(
    (await h.reconciler.read('op-14b'))?.ledgerEntryId,
    'le-14b',
    'the ledger entry is the backend answer, not the settlement pointer',
  );
  assertEqual(h.backend.requests.length, 2, 'both purchases were verified');
  await h.reconciler.stop();
}

// 15. A provider without events is polled on every pass.
{
  const provider = createFakeProvider({
    capabilities: capabilitiesOf({ lifecycle: { events: false } }),
  });
  const h = createHarness({ provider });
  await h.reconciler.start();
  assertEqual(h.provider.availableReads, 1, 'the first pass polls');
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-15' });
  h.provider.available.push(purchaseOf({ transactionId: 'tx-15' }));
  await h.reconciler.reconcile();
  assertEqual(h.provider.availableReads, 2, 'every pass polls');
  assertEqual(
    h.history('store:fake-store:tx-15'),
    ['purchased', 'verifying', 'granted', 'finishing', 'finished'],
    'the polled purchase is reconciled',
  );
  await h.reconciler.stop();
}

// 16. Revocation: inert without the backend read (C2 hook); reversed grants move to revoked with it, after a restart too.
{
  const inert = createHarness();
  inert.backend.queue({ status: 'granted', ledgerEntryId: 'le-16' });
  await inert.reconciler.start();
  inert.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({ transactionId: 'tx-16' }),
  });
  await inert.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-16',
    source: 'shop',
  });
  inert.backend.reverse('le-16', 'le-16-revoke');
  await inert.reconciler.reconcile();
  assertEqual(
    inert.history('op-16').at(-1),
    'finished',
    'without a ledger status read nothing is revoked',
  );
  await inert.reconciler.stop();

  const store = createInMemoryMonetizationOperationStore();
  const backend = createFakeBackend({ withLedgerStatus: true });
  const h = createHarness({ store, backend });
  backend.queue({ status: 'granted', ledgerEntryId: 'le-16b' });
  await h.reconciler.start();
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({ transactionId: 'tx-16b' }),
  });
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-16b',
    source: 'shop',
  });
  await h.reconciler.reconcile();
  assertEqual(h.history('op-16b').at(-1), 'finished', 'active grants stay');
  await h.reconciler.stop();
  backend.reverse('le-16b', 'le-16b-revoke');
  const restarted = createHarness({ store, backend });
  await restarted.reconciler.start();
  assertEqual(
    restarted.history('op-16b'),
    ['revoked'],
    'the stored grant was read through listGranted and revoked',
  );
  assertEqual(
    (await restarted.reconciler.read('op-16b'))?.revokedBy,
    'le-16b-revoke',
    'the reversing entry is journaled',
  );
  assertEqual(
    toGameServicesPurchaseResult((await restarted.reconciler.read('op-16b')) as CommercePurchaseOperationRecord).status,
    'revoked',
    'reported as revoked',
  );
  await restarted.reconciler.stop();
}

// 17. Records of another player, store, target, or kind are never touched.
{
  const store = createInMemoryMonetizationOperationStore();
  const other = createHarness({ store, provider: createFakeProvider({ store: 'other-store' }) });
  await other.reconciler.start();
  await other.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-17',
    source: 'shop',
  });
  await other.reconciler.stop();
  await store.reserve({
    key: 'legacy',
    kind: 'purchase',
    playerId: 'player-1',
    target: 'android',
    deploymentTarget: 'android',
    revision: 0,
    input: { productId: 'gems_small', source: 'shop', idempotencyKey: 'legacy' },
  });
  const h = createHarness({ store });
  await h.reconciler.start();
  assertEqual(
    (await h.reconciler.listRecoverable()).length,
    0,
    "the other store's open record is not this reconciler's",
  );
  h.provider.report(purchaseOf({ transactionId: 'tx-17', store: 'other-store' }));
  await h.reconciler.runUntilIdle();
  assertEqual(h.failures, ['match'], 'a purchase of another store is reported and ignored');
  assertEqual(
    (await store.listRecoverable('player-1')).length,
    1,
    "the other store's record stays open and untouched; the retired v1 record is not listed",
  );
  assertEqual(
    isMonetizationOperationRecoverable((await store.read('legacy')) as never),
    false,
    'a v1 purchase record whose platform never completed has nothing to verify',
  );
  assertEqual(
    (await store.read('legacy'))?.revision,
    0,
    'the retired record is read but never rewritten by the reconciler',
  );
  await h.reconciler.stop();
}

// 18. restorePurchases runs the provider restore, then a pass over the available purchases.
{
  const h = createHarness({ provider: createFakeProvider({ withRestore: true }) });
  await h.reconciler.start();
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-18' });
  h.provider.available.push(purchaseOf({ transactionId: 'tx-18' }));
  await h.reconciler.restorePurchases();
  assertEqual(h.provider.restoreCalls, 1, 'the provider restore ran');
  assertEqual(
    h.history('store:fake-store:tx-18').at(-1),
    'finished',
    'the restored purchase is reconciled',
  );
  await h.reconciler.stop();
}

// 18b. Only the Restore Purchases trigger asks the store for its restore read
// (owned non-consumables its recovery list hides); start and reconcile never do.
{
  const h = createHarness({ provider: createFakeProvider({ withRestore: true }) });
  await h.reconciler.start();
  await h.reconciler.reconcile();
  assertEqual(
    h.provider.availableRequests.map((request) => request.restore === true),
    [false],
    'start reads the recovery list only',
  );
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-18b' });
  h.provider.available.push(
    purchaseOf({
      transactionId: 'tx-18b',
      storeSku: 'remove.ads',
      logicalId: 'remove_ads',
    }),
  );
  await h.reconciler.restorePurchases();
  assertEqual(
    h.provider.availableRequests.map((request) => request.restore === true),
    [false, true],
    'Restore Purchases makes one restore read',
  );
  assertEqual(h.backend.requests[0]?.intent, 'restore', 'a restored purchase is sent as a restore');
  await h.reconciler.reconcile();
  assertEqual(
    h.provider.availableRequests.length,
    2,
    'an event provider is not read again by a later reconcile',
  );
  await h.reconciler.stop();

  // A polled provider: the restore pass's own read is the restore read; later
  // passes read the recovery list again.
  const polled = createHarness({
    provider: createFakeProvider({ capabilities: capabilitiesOf({ lifecycle: { events: false } }) }),
  });
  await polled.reconciler.start();
  await polled.reconciler.restorePurchases();
  await polled.reconciler.reconcile();
  assertEqual(
    polled.provider.availableRequests.map((request) => request.restore === true),
    [false, true, false],
    'a polled provider reads with restore on the Restore Purchases pass only',
  );
  await polled.reconciler.stop();

  // A provider (or bridge host) that rejects the restore read: the recovery
  // read still runs, and the restore failure is reported.
  const strict = createFakeProvider({ withRestore: true });
  const wider = strict.getAvailablePurchases.bind(strict);
  strict.getAvailablePurchases = async (request = {}) => {
    if (request.restore === true) {
      throw new Error('COMMERCE_V2_INVALID_PAYLOAD: restore');
    }
    return wider(request);
  };
  const fallback = createHarness({ provider: strict });
  await fallback.reconciler.start();
  fallback.backend.queue({ status: 'granted', ledgerEntryId: 'le-18b-fallback' });
  strict.available.push(purchaseOf({ transactionId: 'tx-18b-fallback' }));
  await fallback.reconciler.restorePurchases();
  assertEqual(
    fallback.history('store:fake-store:tx-18b-fallback').at(-1),
    'finished',
    'a rejected restore read falls back to the recovery read',
  );
  assertEqual(fallback.failures, ['available'], 'the rejected restore read is reported once');
  await fallback.reconciler.stop();
}

// 19. New purchases read fresh capabilities and refuse transient readiness without binding a key.
{
  let availability: CommerceCapabilities['availability'] = 'temporarily-unavailable';
  const provider = createFakeProvider({
    getCapabilities: async () => ({ ...capabilitiesOf(), availability }),
  });
  const h = createHarness({ provider });
  await h.reconciler.start();
  const request = {
    logicalId: 'gems_small',
    idempotencyKey: 'readiness-retry',
    source: 'shop' as const,
  };
  const refused = await h.reconciler.requestPurchase(request);
  assertEqual(
    refused.outcome === 'failed' && refused.error.retryable,
    true,
    'transient readiness is retryable',
  );
  assertEqual(
    await h.reconciler.read(request.idempotencyKey),
    undefined,
    'transient readiness must not reserve the idempotency key',
  );
  assertEqual(provider.purchaseUiOpened, 0, 'transient readiness never opens store UI');
  availability = 'available';
  provider.queueRequest({ outcome: 'launched' });
  assertEqual(
    (await h.reconciler.requestPurchase(request)).outcome,
    'launched',
    'the recovered provider accepts the original key',
  );
  assertEqual(provider.purchaseUiOpened, 1, 'the same key can open the recovered store once');
  await h.reconciler.stop();
}
{
  let reads = 0;
  const h = createHarness({
    provider: createFakeProvider({
      async getCapabilities() {
        reads += 1;
        if (reads < 4) {
          throw new Error('not ready');
        }
        return capabilitiesOf();
      },
    }),
  });
  await h.reconciler.start();
  const failed = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-19',
    source: 'shop',
  });
  assertEqual(failed.outcome === 'failed' && failed.error.code, 'NOT_PREPARED', 'fails closed');
  assertEqual(h.provider.purchaseUiOpened, 0, 'no UI');
  const launched = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-19b',
    source: 'shop',
  });
  assertEqual(launched.outcome, 'launched', 'the fourth read succeeded');
  const beforeNewPurchase = reads;
  await h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-19c',
    source: 'shop',
  });
  assertEqual(reads > beforeNewPurchase, true, 'a new purchase refreshes the capability read');
  await h.reconciler.stop();
}

// Readiness is checked before an optional provider catalog can hide its products.
for (const [availability, code] of [
  ['temporarily-unavailable', 'STORE_UNAVAILABLE'],
  ['configuration-required', 'CONFIGURATION_REQUIRED'],
  ['action-required', 'ACTION_REQUIRED'],
] as const) {
  let catalogReads = 0;
  const provider = createFakeProvider({
    getCapabilities: async () => ({ ...capabilitiesOf(), availability }),
  });
  provider.fetchProducts = async () => {
    catalogReads += 1;
    return [];
  };
  const h = createHarness({ provider });
  await h.reconciler.start();
  const refusal = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: `catalog-${availability}`,
    source: 'shop',
  });
  assertEqual(
    refusal.outcome === 'failed' && refusal.error.code,
    code,
    'readiness is not masked by a hidden catalog',
  );
  assertEqual(catalogReads, 0, 'an unavailable provider is refused before catalog lookup');
  assertEqual(provider.purchaseUiOpened, 0, 'readiness refusal never opens checkout');
  await h.reconciler.stop();
}

// A proven unopened checkout remains retryable across a restart, with its durable identity.
{
  const provider = createFakeProvider();
  const purchase = provider.requestPurchase;
  let presentationListener: ((event: PlatformPurchasePresentationEvent) => void) | undefined;
  let offline = true;
  Object.assign(provider, {
    presentation: {
      subscribe(listener: (event: PlatformPurchasePresentationEvent) => void) {
        presentationListener = listener;
        return () => {
          presentationListener = undefined;
        };
      },
    },
    async requestPurchase(request: Parameters<CommerceProvider['requestPurchase']>[0]): Promise<RequestPurchaseResult> {
      if (offline) {
        presentationListener?.({
          idempotencyKey: request.idempotencyKey,
          sequence: 1,
          state: 'not-started',
        });
        return { outcome: 'failed', error: { code: 'NETWORK', retryable: true } };
      }
      return purchase(request);
    },
  });
  const h = createHarness({ provider });
  const request = {
    logicalId: 'gems_small',
    idempotencyKey: 'intent-retry',
    source: 'shop' as const,
  };
  await h.reconciler.start();
  assertEqual(
    (await h.reconciler.requestPurchase(request)).outcome,
    'failed',
    'the caller sees the retryable refusal',
  );
  const refused = await h.reconciler.read(request.idempotencyKey);
  assertEqual(refused?.state, 'requested', 'an unopened checkout is not terminal');
  assertEqual(
    toGameServicesPurchaseResult(refused!).purchase.diagnostic?.retryable,
    true,
    'the client retains its retryable diagnostic',
  );
  assertEqual(provider.purchaseUiOpened, 0, 'offline intent issuance opens no store UI');
  await h.reconciler.stop();
  const restarted = createHarness({ provider, store: h.store });
  await restarted.reconciler.start();
  assertEqual(
    (await restarted.reconciler.read(request.idempotencyKey))?.state,
    'requested',
    'recovery does not terminalize the unopened checkout',
  );
  await assertRejects(
    () => restarted.reconciler.requestPurchase({ ...request, source: 'event' }),
    /bound to another product or source/,
    'a retry cannot change its bound identity',
  );
  for (const changed of [
    { ...request, quantity: 2 },
    { ...request, offerId: 'another-offer' },
  ]) {
    await assertRejects(
      () => restarted.reconciler.requestPurchase(changed),
      /bound to another product or source/,
      'a restart preserves the offer and quantity binding',
    );
  }
  offline = false;
  await Promise.all([
    restarted.reconciler.requestPurchase(request),
    restarted.reconciler.requestPurchase(request),
  ]);
  await restarted.reconciler.requestPurchase(request);
  assertEqual(provider.purchaseUiOpened, 1, 'same-key retries and replays open checkout only once');
  assertEqual(
    (await restarted.reconciler.read(request.idempotencyKey))?.state,
    'launched',
    'the recovered checkout advances',
  );
  await restarted.reconciler.stop();
}

// A retryable error alone cannot prove that a native payment surface never started.
{
  const h = createHarness();
  h.provider.queueRequest({ outcome: 'failed', error: { code: 'NETWORK', retryable: true } });
  await h.reconciler.start();
  const request = {
    logicalId: 'gems_small',
    idempotencyKey: 'ambiguous-network',
    source: 'shop' as const,
  };
  await h.reconciler.requestPurchase(request);
  await h.reconciler.requestPurchase(request);
  assertEqual(
    (await h.reconciler.read(request.idempotencyKey))?.state,
    'failed',
    'a refusal without presentation proof remains terminal',
  );
  assertEqual(h.provider.purchaseUiOpened, 1, 'an ambiguous failure never reopens checkout');
  await h.reconciler.stop();
}

// 20. An unsupported kind is refused before the store UI opens; an unknown product is refused without a record.
{
  const h = createHarness({
    provider: createFakeProvider({ capabilities: capabilitiesOf({ purchase: { durable: false } }) }),
  });
  await h.reconciler.start();
  const unsupported = await h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-20',
    source: 'shop',
  });
  assertEqual(
    unsupported.outcome === 'failed' && unsupported.error.code,
    'ITEM_UNAVAILABLE',
    'durable is not sold',
  );
  assertEqual(h.history('op-20'), ['requested', 'failed'], 'journaled as failed');
  const unknown = await h.reconciler.requestPurchase({
    logicalId: 'unknown_product',
    idempotencyKey: 'op-20b',
    source: 'shop',
  });
  assertEqual(
    unknown.outcome === 'failed' && unknown.error.code,
    'ITEM_UNAVAILABLE',
    'unknown product',
  );
  assertEqual(await h.reconciler.read('op-20b'), undefined, 'nothing opened, nothing journaled');
  assertEqual(h.provider.purchaseUiOpened, 0, 'no UI');
  await h.reconciler.stop();
}

// Client, recovery client, and runtime wiring.

function createGateway(provider: CommerceProvider): PlatformGateway {
  return {
    target: 'android',
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        localizedContent: true,
        commerce: await provider.getCapabilities(),
      };
    },
    identity: {
      async getPlayer() {
        return { playerId: 'player-1' };
      },
    },
    commerce: provider,
    ads: {
      async preload() {},
      async showRewarded() {
        return { status: 'skipped', rewardGranted: false };
      },
    },
    leaderboard: {
      async submitScore() {
        return { submitted: false };
      },
      async open() {},
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  };
}

function createBackendApi(purchases: PurchaseVerificationApi): GameServicesBackendApi {
  return {
    purchases,
    adRewards: {
      async claimAdReward() {
        return { granted: false, alreadyProcessed: false, disposition: 'rejected' };
      },
    },
    leaderboard: {
      async recordScore() {
        return { submitted: false, ledgerEntryId: 'none', alreadyProcessed: false, rank: 0 };
      },
    },
  };
}

// 21. createGameServicesClient: a launched purchase ends pending, the grant arrives later and is tracked once.
{
  const provider = createFakeProvider();
  const backend = createFakeBackend();
  const events: AnalyticsEvent[] = [];
  const progress: string[] = [];
  const client = createGameServicesClient({
    gateway: createGateway(provider),
    backend: createBackendApi(backend),
    warn: () => {},
    playerId: 'player-1',
    target: 'android',
    analytics: { track: (event) => void events.push(event) },
  });
  const reconciler = client.commerceReconciler;
  if (reconciler === undefined) {
    throw new Error('A gateway with a commerce provider exposes the reconciler.');
  }
  const pending = await client.purchase(
    { productId: 'gems_small', source: 'shop', idempotencyKey: 'op-21' },
    { onProgress: (step) => void progress.push(step.phase) },
  );
  assertEqual(pending.status, 'pending', 'the store answers later');
  assertEqual(pending.purchase, { status: 'pending', entitlementIds: [] }, 'no transaction yet');
  assertEqual(
    progress,
    ['platform-requested', 'platform-result', 'completed'],
    'no server phase before the store answers',
  );
  assertEqual(
    events.map((event) => `${event.name}:${String(event.properties.reason)}`),
    ['purchase_pending:purchase_pending'],
    'pending analytics',
  );
  backend.queue({ status: 'granted', ledgerEntryId: 'le-21' });
  provider.report(purchaseOf({ transactionId: 'tx-21' }));
  await reconciler.runUntilIdle();
  assertEqual(
    events.map((event) => `${event.name}:${String(event.properties.ledgerEntryId)}`),
    ['purchase_pending:undefined', 'purchase_granted:le-21'],
    'the grant is tracked once when it arrives',
  );
  const replay = await client.purchase({
    productId: 'gems_small',
    source: 'shop',
    idempotencyKey: 'op-21',
  });
  assertEqual(replay.status, 'granted', 'the replayed key reports the grant');
  assertEqual(replay.ledgerEntryId, 'le-21', 'with its ledger entry');
  assertEqual(events.length, 3, 'a replay reports its status');
  assertEqual(events[2]?.name, 'purchase_granted', 'as granted');

  // A synchronous store answer verifies inside the call and reports the server phases.
  backend.queue({ status: 'rejected', reason: 'EVIDENCE_INVALID' });
  provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({
      transactionId: 'tx-21b',
      storeSku: 'remove.ads',
      logicalId: 'remove_ads',
    }),
  });
  const inlineProgress: string[] = [];
  const rejected = await client.purchase(
    { productId: 'remove_ads', source: 'shop', idempotencyKey: 'op-21b' },
    {
      onProgress: (step) => void inlineProgress.push(step.phase === 'server-result' ? `server-result:${String(step.accepted)}` : step.phase),
    },
  );
  assertEqual(rejected.status, 'rejected', 'rejected inside the call');
  assertEqual(
    inlineProgress,
    [
      'platform-requested',
      'platform-result',
      'server-requested',
      'server-result:false',
      'completed',
    ],
    'server phases observed',
  );
  assertEqual(events.at(-1)?.name, 'purchase_rejected', 'rejected analytics');
  assertEqual(events.at(-1)?.properties.reason, 'EVIDENCE_INVALID', 'with the backend reason');
  await reconciler.stop();
}

// 22. createRecoverableMonetizationClient: purchases, reconcile summaries, and restore.
{
  const provider = createFakeProvider({ withRestore: true });
  const backend = createFakeBackend({ withLedgerStatus: true });
  const store = createInMemoryMonetizationOperationStore();
  const recovery = createRecoverableMonetizationClient({
    gateway: createGateway(provider),
    backend: createBackendApi(backend),
    playerId: 'player-1',
    target: 'android',
    operationStore: store,
  });
  const reconciler = recovery.commerceReconciler;
  if (reconciler === undefined) {
    throw new Error('The recovery client exposes the reconciler.');
  }
  assertEqual(await recovery.reconcile(), [], 'nothing to recover');
  assertEqual(reconciler.started, true, 'reconcile started the reconciler');
  const pending = await recovery.purchase({
    productId: 'gems_small',
    source: 'shop',
    idempotencyKey: 'op-22',
  });
  assertEqual(pending.status, 'pending', 'launched');
  assertEqual(
    await recovery.reconcile(),
    [
      {
        kind: 'commerce-purchase',
        idempotencyKey: 'op-22',
        status: 'pending',
        finalizationPending: false,
      },
    ],
    'the open record is summarized',
  );
  backend.queue({ status: 'granted', ledgerEntryId: 'le-22' });
  provider.queueFinish({ finished: false });
  provider.available.push(purchaseOf({ transactionId: 'tx-22' }));
  assertEqual(
    await recovery.restorePurchases(),
    [
      {
        kind: 'commerce-purchase',
        idempotencyKey: 'op-22',
        status: 'granted',
        finalizationPending: true,
      },
    ],
    'granted but not finished yet',
  );
  assertEqual(provider.restoreCalls, 1, 'restore ran');
  assertEqual(
    await recovery.reconcile(),
    [
      {
        kind: 'commerce-purchase',
        idempotencyKey: 'op-22',
        status: 'granted',
        finalizationPending: false,
      },
    ],
    'finished after the retried finish',
  );
  assertEqual(await recovery.reconcile(), [], 'a finished record is no longer reported');
  const replayed = await recovery.purchase({
    productId: 'gems_small',
    source: 'shop',
    idempotencyKey: 'op-22',
  });
  assertEqual(replayed.status, 'granted', 'a replayed key answers from the journal');
  assertEqual(replayed.ledgerEntryId, 'le-22', 'with the journaled ledger entry');
  assertEqual(provider.purchaseUiOpened, 1, 'a replayed key never reopens the store UI');
  backend.reverse('le-22', 'le-22-refund');
  assertEqual(await recovery.reconcile(), [], 'revoked records are reported only while open');
  assertEqual((await reconciler.read('op-22'))?.state, 'revoked', 'the refund revoked the grant');
  await reconciler.stop();
}

// 23. createGameServicesRuntime routes the client through the recovery client's reconciler.
{
  const provider = createFakeProvider();
  const runtime = createGameServicesRuntime({
    gateway: createGateway(provider),
    playerId: 'player-1',
    authorityMode: 'non-production',
    allowLocalBackend: true,
    localBackend: createBackendApi(createFakeBackend()),
    operationStore: createInMemoryMonetizationOperationStore(),
  });
  assertEqual(runtime.mode, 'local', 'local backend');
  assertEqual(
    runtime.client?.commerceReconciler !== undefined,
    true,
    'the runtime client exposes the reconciler',
  );
  assertEqual(
    runtime.client?.commerceReconciler === runtime.monetizationRecovery?.commerceReconciler,
    true,
    'one reconciler over the durable journal',
  );
}

// 23b. createGameServicesRuntime hands `commerceProducts` to the reconciler:
// the configured catalog kind wins over the store's answer.
{
  const provider = createFakeProvider();
  const store = createInMemoryMonetizationOperationStore();
  const runtime = createGameServicesRuntime({
    gateway: createGateway(provider),
    playerId: 'player-1',
    authorityMode: 'non-production',
    allowLocalBackend: true,
    localBackend: createBackendApi(createFakeBackend()),
    operationStore: store,
    commerceProducts: [{ logicalId: 'gems_small', kind: 'durable', storeSku: 'gems.small' }],
  });
  const result = await runtime.client?.purchase({
    productId: 'gems_small',
    source: 'shop',
    idempotencyKey: 'op-23b',
  });
  assertEqual(result?.status, 'pending', 'launched');
  const record = await store.read(
    createCommercePurchaseOperationKey(runtime.target ?? 'android', 'op-23b'),
  ) as CommercePurchaseOperationRecord | undefined;
  assertEqual(record?.productKind, 'durable', 'the configured catalog kind is journaled');
}

// 23c. createGameServicesRuntime hands `commerceStaleLaunchedAfterMs` to the reconciler: a
// launched attempt with no store purchase expires after it (24 hours by default), and a
// non-positive value is refused like the reconciler option.
{
  let clock = Date.parse('2026-10-02T00:00:00.000Z');
  const runtimeOf = (store: MonetizationOperationStore, staleMs?: number) =>
    createGameServicesRuntime({
      gateway: createGateway(createFakeProvider()),
      playerId: 'player-1',
      authorityMode: 'non-production',
      allowLocalBackend: true,
      localBackend: createBackendApi(createFakeBackend()),
      operationStore: store,
      now: () => new Date(clock).toISOString(),
      ...(staleMs === undefined ? {} : { commerceStaleLaunchedAfterMs: staleMs }),
    });
  const shortStore = createInMemoryMonetizationOperationStore();
  const defaultStore = createInMemoryMonetizationOperationStore();
  const short = runtimeOf(shortStore, 60_000);
  const defaulted = runtimeOf(defaultStore);
  for (const runtime of [short, defaulted]) {
    const result = await runtime.client?.purchase({
      productId: 'gems_small',
      source: 'shop',
      idempotencyKey: 'op-23c',
    });
    assertEqual(result?.status, 'pending', 'launched');
  }
  clock += 3_600_000;
  await short.monetizationRecovery?.reconcile();
  await defaulted.monetizationRecovery?.reconcile();
  const stateIn = async (store: MonetizationOperationStore) =>
    ((await store.read(
      createCommercePurchaseOperationKey(
        short.target ?? 'android',
        'op-23c',
      ),
    )) as CommercePurchaseOperationRecord | undefined)?.state;
  assertEqual(
    [await stateIn(shortStore), await stateIn(defaultStore)],
    ['failed', 'launched'],
    'the configured expiry ends the attempt; the 24-hour default keeps it',
  );
  await short.client?.commerceReconciler?.stop();
  await defaulted.client?.commerceReconciler?.stop();
  for (const bad of [0, -1, Number.NaN]) {
    assertThrowsSync(
      () => runtimeOf(createInMemoryMonetizationOperationStore(), bad),
      /commerceStaleLaunchedAfterMs must be a positive duration/u,
    );
  }
  // Refused where it enters, also when no reconciler is built (no commerce provider) or the
  // runtime is disabled before it builds a client.
  const { commerce: _commerce, ...withoutCommerce } = createGateway(createFakeProvider());
  assertThrowsSync(
    () =>
      createGameServicesRuntime({
        gateway: withoutCommerce,
        playerId: 'player-1',
        authorityMode: 'production',
        commerceStaleLaunchedAfterMs: 0,
      }),
    /commerceStaleLaunchedAfterMs must be a positive duration/u,
  );
  assertThrowsSync(
    () =>
      createGameServicesClient({
        gateway: withoutCommerce,
        backend: createBackendApi(createFakeBackend()),
        playerId: 'player-1',
        target: 'android',
        commerceStaleLaunchedAfterMs: -5,
      }),
    /commerceStaleLaunchedAfterMs must be a positive duration/u,
  );
  assertEqual(
    runtimeOf(createInMemoryMonetizationOperationStore(), Number.POSITIVE_INFINITY).mode,
    'local',
    'Infinity is accepted',
  );
}

// Review fixes.

// 24. A leftover v1 purchase record is retired: nothing resumes it through the reconciler, but it
// stays readable so a durable journal still parses it, and the recoverable client finishes the
// verification it was in the middle of (one backend request, never a local grant).
{
  const provider = createFakeProvider();
  const store = createInMemoryMonetizationOperationStore();
  const requests: VerifyPurchaseRequest[] = [];
  const legacyKey = JSON.stringify(['android', 'purchase', 'legacy-1']);
  await store.reserve({
    key: legacyKey,
    kind: 'purchase',
    playerId: 'player-1',
    target: 'android',
    deploymentTarget: 'android',
    revision: 0,
    input: { productId: 'gems_small', source: 'shop', idempotencyKey: 'legacy-1' },
    platform: {
      status: 'completed',
      transactionId: 'legacy-tx-1',
      entitlementIds: [],
      evidence: { schema: 'fixture.fake-store.v1', payload: { token: 'legacy-token' } },
    },
    platformCompletedAt: '2026-10-01T00:00:00.000Z',
  });
  const legacyRecord = await store.read(legacyKey);
  assertEqual(legacyRecord?.kind, 'purchase', 'the retired record is still readable');
  assertEqual(
    legacyRecord !== undefined && isMonetizationOperationRecoverable(legacyRecord),
    true,
    'a retired v1 purchase record with a completed platform result and no result is still open',
  );
  assertEqual(
    (await store.listRecoverable('player-1')).length,
    1,
    'the journal lists it so the recoverable client can finish the verification',
  );
  const recovery = createRecoverableMonetizationClient({
    gateway: createGateway(provider),
    backend: createBackendApi({
      async verifyPurchase(request) {
        requests.push(request);
        return { verified: true, alreadyProcessed: false, ledgerEntryId: 'ledger-legacy' };
      },
    }),
    playerId: 'player-1',
    target: 'android',
    operationStore: store,
  });
  assertEqual(
    (await recovery.reconcile()).filter((entry) => entry.kind === 'purchase').map(
      (entry) => entry.status,
    ),
    ['granted'],
    'reconcile finishes the retired v1 purchase record through the backend',
  );
  assertEqual(requests.length, 1, 'the recorded platform result is verified once');
  assertEqual(requests[0]?.idempotencyKey, 'legacy-1', 'under the key the v1 purchase used');
  assertEqual(requests[0]?.platformTransactionId, 'legacy-tx-1', 'for the recorded transaction');
  assertEqual(provider.purchaseUiOpened, 0, 'the provider never opened the store UI');
  const closed = await store.read(legacyKey);
  assertEqual(
    closed?.kind === 'purchase' && closed.result?.status === 'granted',
    true,
    'the backend answer closes the record',
  );
  assertEqual(
    closed !== undefined && isMonetizationOperationRecoverable(closed),
    false,
    'a closed retired record is not open again',
  );
  assertEqual(
    (await recovery.reconcile()).filter((entry) => entry.kind === 'purchase').length,
    0,
    'a closed retired record is not reported or sent again',
  );
  assertEqual(requests.length, 1, 'no second request');
  // The store-side purchase it covered is found again from the store's own list.
  const backendQueue = createFakeBackend();
  backendQueue.queue({ status: 'granted', ledgerEntryId: 'le-legacy-rediscovered' });
  const rediscovery = createHarness({ backend: backendQueue });
  rediscovery.provider.available.push(purchaseOf({ transactionId: 'legacy-tx-1' }));
  await rediscovery.reconciler.start();
  assertEqual(
    (await rediscovery.reconciler.listRecoverable()).length,
    0,
    'the rediscovered purchase is granted through the reconciler, not left open',
  );
  assertEqual(backendQueue.requests.length, 1, 'the store-side purchase is verified once');
  await rediscovery.reconciler.stop();
  await recovery.commerceReconciler?.stop();
}

// 24b. The retired-record drain keeps the backend in charge: an outage leaves the record open, the
// saved request is sent unchanged, a definitive non-grant closes it as rejected, and another
// player's record is left alone.
{
  const store = createInMemoryMonetizationOperationStore();
  const requests: VerifyPurchaseRequest[] = [];
  let mode: 'outage' | 'granted' | 'rejected' = 'outage';
  const retired = (idempotencyKey: string, playerId = 'player-1') => ({
    key: JSON.stringify(['android', 'purchase', idempotencyKey]),
    kind: 'purchase' as const,
    playerId,
    target: 'android',
    deploymentTarget: 'android',
    revision: 0,
    input: { productId: 'gems_small', source: 'shop' as const, idempotencyKey },
    platform: {
      status: 'completed' as const,
      transactionId: `${idempotencyKey}-tx`,
      entitlementIds: [],
      evidence: { schema: 'fixture.fake-store.v1', payload: { token: `${idempotencyKey}-token` } },
    },
    platformCompletedAt: '2026-10-01T00:00:00.000Z',
    request: {
      target: 'android',
      playerId,
      productId: 'gems_small',
      platformTransactionId: `${idempotencyKey}-tx`,
      idempotencyKey,
      purchasedAt: '2026-10-01T00:00:00.000Z',
      evidence: { schema: 'fixture.fake-store.v1', payload: { token: `${idempotencyKey}-token` } },
    },
  });
  await store.reserve(retired('saved-1'));
  await store.reserve(retired('foreign-1', 'player-2'));
  const recovery = createRecoverableMonetizationClient({
    gateway: createGateway(createFakeProvider()),
    backend: createBackendApi({
      async verifyPurchase(request) {
        requests.push(request);
        if (mode === 'outage') {
          throw new Error('backend unavailable');
        }
        return mode === 'granted'
          ? { verified: true, alreadyProcessed: false, ledgerEntryId: 'ledger-saved' }
          : {
              verified: false,
              alreadyProcessed: false,
              disposition: 'rejected',
              reason: 'DECLINED',
            };
      },
    }),
    playerId: 'player-1',
    target: 'android',
    operationStore: store,
  });
  assertEqual(
    (await recovery.reconcile()).filter((entry) => entry.kind === 'purchase').map(
      (entry) => entry.status,
    ),
    ['pending'],
    'a backend outage leaves the retired record open and pending',
  );
  assertEqual(
    (await store.listRecoverable('player-1')).filter((record) => record.kind === 'purchase').length,
    1,
    'the record is retried on the next pass',
  );
  mode = 'rejected';
  assertEqual(
    (await recovery.reconcile()).filter((entry) => entry.kind === 'purchase').map(
      (entry) => entry.status,
    ),
    ['rejected'],
    'a definitive non-grant closes the retired record as rejected',
  );
  assertEqual(
    requests.every(
      (request) => JSON.stringify(request) === JSON.stringify(retired('saved-1').request),
    ),
    true,
    'the saved verify request is sent unchanged every time',
  );
  assertEqual(
    (await store.listRecoverable('player-1')).filter((record) => record.kind === 'purchase').length,
    0,
    'a rejected retired record is closed',
  );
  assertEqual(
    requests.filter((request) => request.playerId === 'player-2').length,
    0,
    "another player's retired record is never verified by this client",
  );
  await recovery.commerceReconciler?.stop();
}

// 25. Stale attempts: a requested record without an in-flight call and an expired launched record end as failed.
{
  const store = createInMemoryMonetizationOperationStore();
  const h = createHarness({ store });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-25',
    source: 'shop',
  });
  await h.reconciler.stop();
  const launched = (await store.read(
    createCommercePurchaseOperationKey('android', 'op-25'),
  )) as CommercePurchaseOperationRecord;
  // Seed what a crash between the reservation and the launched write leaves behind.
  await store.reserve({
    ...launched,
    key: createCommercePurchaseOperationKey('android', 'op-25b'),
    idempotencyKey: 'op-25b',
    state: 'requested',
    revision: 0,
  });
  let clock = '2026-10-02T00:00:00.000Z';
  const later = createHarness({ store, overrides: { now: () => clock } });
  await later.reconciler.start();
  assertEqual(
    later.history('op-25b'),
    ['failed'],
    'a requested record with no in-flight call is stale and ends',
  );
  assertEqual(
    (await later.reconciler.read('op-25b'))?.error?.code,
    'OUTCOME_UNKNOWN',
    'with the OUTCOME_UNKNOWN class',
  );
  const blocked = await later.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-25c',
    source: 'shop',
  });
  assertEqual(
    blocked.outcome === 'failed' && blocked.error.code,
    'IN_PROGRESS',
    'a fresh launched attempt still serializes the product',
  );
  clock = '2026-10-03T00:00:01.000Z';
  await later.reconciler.reconcile();
  assertEqual(
    later.history('op-25'),
    ['failed'],
    'a launched attempt with no store purchase expires after the window',
  );
  const allowed = await later.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-25d',
    source: 'shop',
  });
  assertEqual(allowed.outcome, 'launched', 'the product is purchasable again');
  await later.reconciler.stop();
  // A purchase the store reports after the expiry is still journaled under its derived key.
  const resumed = createHarness({ store, overrides: { now: () => clock } });
  resumed.backend.queue({ status: 'granted', ledgerEntryId: 'le-25' });
  await resumed.reconciler.start();
  await resumed.reconciler.stop();
  // Infinity keeps the RFC rule without expiry.
  const forever = createHarness({
    overrides: {
      staleLaunchedAfterMs: Number.POSITIVE_INFINITY,
      now: () => '2030-01-01T00:00:00.000Z',
    },
  });
  await forever.reconciler.start();
  await forever.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-25e',
    source: 'shop',
  });
  await forever.reconciler.reconcile();
  assertEqual(forever.history('op-25e'), ['requested', 'launched'], 'no expiry');
  await forever.reconciler.stop();
}

// 26. A reused key must name the same product and source.
{
  const h = createHarness();
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-26',
    source: 'shop',
  });
  await assertRejects(
    () =>
      h.reconciler.requestPurchase({
        logicalId: 'remove_ads',
        idempotencyKey: 'op-26',
        source: 'shop',
      }),
    /bound to another product or source/u,
    'another product under the same key',
  );
  await assertRejects(
    () =>
      h.reconciler.requestPurchase({
        logicalId: 'gems_small',
        idempotencyKey: 'op-26',
        source: 'event',
      }),
    /bound to another product or source/u,
    'another source under the same key',
  );
  assertEqual(h.provider.purchaseUiOpened, 1, 'no store UI for the mismatched replays');
  await h.reconciler.stop();
}

// 27. A failed start is retryable and leaves nothing subscribed.
{
  const store = createInMemoryMonetizationOperationStore();
  let listFailures = 1;
  const flaky: MonetizationOperationStore = {
    ...store,
    async listRecoverable(playerId) {
      if (listFailures > 0) {
        listFailures -= 1;
        throw new Error('journal unavailable');
      }
      return store.listRecoverable(playerId);
    },
  };
  const h = createHarness({ store: flaky });
  await assertRejects(() => h.reconciler.start(), /journal unavailable/u, 'the first start fails');
  assertEqual(h.reconciler.started, false, 'not started');
  await h.reconciler.start();
  assertEqual(h.reconciler.started, true, 'the retry starts');
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-27' });
  h.provider.report(purchaseOf({ transactionId: 'tx-27' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('store:fake-store:tx-27').at(-1),
    'finished',
    'events reach the retried subscription',
  );
  await h.reconciler.stop();
}

// 28. An unknown product kind never finishes as consumable; the finish waits for the catalog.
{
  let catalogDown = true;
  const provider = createFakeProvider();
  const fetchProducts = provider.fetchProducts;
  const flakyProvider: FakeProvider = {
    ...provider,
    async fetchProducts(request) {
      if (catalogDown) {
        throw new Error('catalog unavailable');
      }
      return fetchProducts.call(provider, request);
    },
  };
  const h = createHarness({ provider: flakyProvider });
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-28' });
  await h.reconciler.start();
  provider.report(
    purchaseOf({ transactionId: 'tx-28', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('store:fake-store:tx-28'),
    ['purchased', 'verifying', 'granted', 'finishing'],
    'granted, but the finish waits',
  );
  assertEqual(
    (await h.reconciler.read('store:fake-store:tx-28'))?.productKind,
    undefined,
    'the kind is unknown',
  );
  assertEqual(provider.finishCalls.length, 0, 'no finish with a guessed kind');
  catalogDown = false;
  await h.reconciler.reconcile();
  assertEqual(
    h.history('store:fake-store:tx-28').at(-1),
    'finished',
    'finished once the catalog answers',
  );
  assertEqual(provider.finishCalls[0]?.isConsumable, false, 'as the durable product it is');
  await h.reconciler.stop();
}

// 29. A pass failure from an earlier event never rejects a purchase the store already answered.
{
  const store = createInMemoryMonetizationOperationStore();
  let fail = false;
  const flaky: MonetizationOperationStore = {
    ...store,
    async listRecoverable(playerId) {
      if (fail) {
        throw new Error('journal unavailable');
      }
      return store.listRecoverable(playerId);
    },
  };
  const h = createHarness({ store: flaky });
  await h.reconciler.start();
  fail = true;
  h.provider.emit({ type: 'purchaseError', error: { code: 'UNKNOWN', retryable: false } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  fail = false;
  const result = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-29',
    source: 'shop',
  });
  assertEqual(result.outcome, 'launched', 'the purchase call resolves with the store answer');
  assertEqual(
    h.failures.includes('journal(op-29)') || h.failures.includes('journal'),
    true,
    'the stale pass failure is reported instead',
  );
  await h.reconciler.stop();
}

// 30. An error event never ends a record that holds a purchase or a saved request.
{
  const h = createHarness();
  h.backend.queue({ status: 'pending' });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-30',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-30' }));
  await h.reconciler.runUntilIdle();
  assertEqual(h.history('op-30').at(-1), 'pending', 'backend-side pending with a saved request');
  h.provider.emit({
    type: 'purchaseError',
    logicalId: 'gems_small',
    error: { code: 'USER_CANCELLED', retryable: false },
  });
  h.provider.emit({ type: 'purchaseError', error: { code: 'UNKNOWN', retryable: false } });
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-30').filter((state) => state === 'cancelled' || state === 'failed'),
    [],
    'a later error does not end a paid attempt (the pass resends the saved request)',
  );
  await h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-30b',
    source: 'shop',
  });
  h.provider.report(
    purchaseOf({
      transactionId: 'tx-30b',
      storeSku: 'remove.ads',
      logicalId: 'remove_ads',
      state: 'pending',
    }),
  );
  await h.reconciler.runUntilIdle();
  h.provider.emit({
    type: 'purchaseError',
    logicalId: 'remove_ads',
    error: { code: 'USER_CANCELLED', retryable: false },
  });
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-30b').at(-1),
    'pending',
    'a store-side pending purchase is decided by the store, not by an error event',
  );
  await h.reconciler.stop();
}

// 31. A second transaction for a product whose attempt is backend-pending gets its own derived record.
{
  const h = createHarness();
  h.backend.queue({ status: 'pending' });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-31',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-31' }));
  await h.reconciler.runUntilIdle();
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-31b' });
  h.provider.report(purchaseOf({ transactionId: 'tx-31b' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('store:fake-store:tx-31b').at(-1),
    'finished',
    'the second transaction is journaled and granted under its derived key',
  );
  assertEqual(
    (await h.reconciler.read('op-31'))?.purchase?.transactionId,
    'tx-31',
    'the game attempt keeps its own transaction',
  );
  await h.reconciler.stop();
}

// 32. The client reports the server phase once per call under a server-owned finish.
{
  const provider = createFakeProvider({
    capabilities: capabilitiesOf({ lifecycle: { finish: 'server' } }),
    withFinish: false,
  });
  const backend = createFakeBackend();
  const client = createGameServicesClient({
    gateway: createGateway(provider),
    backend: createBackendApi(backend),
    playerId: 'player-1',
    warn: () => {},
    target: 'android',
  });
  backend.queue({ status: 'granted', ledgerEntryId: 'le-32' });
  backend.queue({ status: 'granted', ledgerEntryId: 'le-32', finalization: 'completed' });
  provider.queueRequest({ outcome: 'purchased', purchase: purchaseOf({ transactionId: 'tx-32' }) });
  const phases: string[] = [];
  const result = await client.purchase(
    { productId: 'gems_small', source: 'shop', idempotencyKey: 'op-32' },
    { onProgress: (step) => void phases.push(step.phase) },
  );
  assertEqual(result.status, 'granted', 'granted');
  assertEqual(
    phases,
    ['platform-requested', 'platform-result', 'server-requested', 'server-result', 'completed'],
    'one server phase for two verify calls',
  );
  assertEqual(backend.requests.length, 2, 'the finalization re-read happened');
  await client.commerceReconciler?.stop();
}

// Pre-merge review fixes.

// 33. The store call runs outside the lock: an event that arrives while the sheet is open is reconciled first.
{
  const h = createHarness();
  await h.reconciler.start();
  let answer: ((result: RequestPurchaseResult) => void) | undefined;
  const sheet = new Promise<RequestPurchaseResult>((resolve) => {
    answer = resolve;
  });
  const slowProvider = h.provider;
  const requestPurchase = slowProvider.requestPurchase;
  slowProvider.requestPurchase = async (request) => {
    await requestPurchase.call(slowProvider, request);
    return sheet;
  };
  const inFlight = h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-33',
    source: 'shop',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(h.history('op-33'), ['requested'], 'the attempt is reserved while the sheet is open');
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-33' });
  h.provider.report(purchaseOf({ transactionId: 'tx-33' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('store:fake-store:tx-33').at(-1),
    'finished',
    'an unrelated purchase is verified before the store answers',
  );
  const blocked = await h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-33b',
    source: 'shop',
  });
  assertEqual(
    blocked.outcome === 'failed' && blocked.error.code,
    'IN_PROGRESS',
    'the product is serialized behind the open sheet',
  );
  assertEqual(await h.reconciler.read('op-33b'), undefined, 'and the refused key is not journaled');
  answer?.({ outcome: 'launched' });
  assertEqual(
    (await inFlight).outcome,
    'launched',
    'the sheet answer is journaled after the lock is taken again',
  );
  assertEqual(h.history('op-33'), ['requested', 'launched'], 'launched');
  await h.reconciler.stop();
}

// 34. Refusals before the store call do not burn the game's key; a retry with the same key opens the sheet.
{
  const h = createHarness();
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-34',
    source: 'shop',
  });
  const refused = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-34b',
    source: 'shop',
  });
  assertEqual(
    refused.outcome === 'failed' && refused.error.code,
    'IN_PROGRESS',
    'refused while op-34 is launched',
  );
  assertEqual(await h.reconciler.read('op-34b'), undefined, 'IN_PROGRESS leaves no record');
  h.provider.emit({
    type: 'purchaseError',
    logicalId: 'gems_small',
    error: { code: 'USER_CANCELLED', retryable: false },
  });
  await h.reconciler.runUntilIdle();
  const retried = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-34b',
    source: 'shop',
  });
  assertEqual(retried.outcome, 'launched', 'the same key opens the sheet once the product is free');
  assertEqual(h.history('op-34b'), ['requested', 'launched'], 'journaled on the retry');

  let reads = 0;
  const notReady = createHarness({
    provider: createFakeProvider({
      async getCapabilities() {
        reads += 1;
        if (reads < 4) {
          throw new Error('not ready');
        }
        return capabilitiesOf();
      },
    }),
  });
  await notReady.reconciler.start();
  const unprepared = await notReady.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-34c',
    source: 'shop',
  });
  assertEqual(
    unprepared.outcome === 'failed' && unprepared.error.code,
    'NOT_PREPARED',
    'not ready',
  );
  assertEqual(await notReady.reconciler.read('op-34c'), undefined, 'NOT_PREPARED leaves no record');
  const ready = await notReady.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-34c',
    source: 'shop',
  });
  assertEqual(ready.outcome, 'launched', 'the same key works once the provider is ready');
  await notReady.reconciler.stop();
  await h.reconciler.stop();
}

// 35. A backend-pending record is not resent by an unrelated event inside the interval; explicit triggers resend.
{
  let clock = '2026-10-02T00:00:00.000Z';
  const h = createHarness({ overrides: { now: () => clock, retryIntervalMs: 60_000 } });
  h.backend.queue({ status: 'pending' });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-35',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-35' }));
  await h.reconciler.runUntilIdle();
  assertEqual(h.backend.requests.length, 1, 'verified once, answered pending');
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-35b' });
  h.provider.report(
    purchaseOf({ transactionId: 'tx-35b', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.backend.requests.map((request) => request.idempotencyKey),
    ['op-35', 'store:fake-store:tx-35b'],
    'the unrelated event did not resend the pending request',
  );
  assertEqual(h.history('op-35').at(-1), 'pending', 'still pending, no extra revisions');
  h.backend.queue({ status: 'pending' });
  await h.reconciler.reconcile();
  assertEqual(h.backend.requests.length, 3, 'an explicit reconcile resends inside the interval');
  clock = '2026-10-02T00:02:00.000Z';
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-35' });
  h.provider.emit({ type: 'purchaseError', error: { code: 'UNKNOWN', retryable: false } });
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-35').at(-1),
    'finished',
    'after the interval an event pass resends and the grant lands',
  );
  await h.reconciler.stop();
}

// 36. A terminal record is matched by transaction after a restart, so a re-listed transaction is not verified again.
{
  const store = createInMemoryMonetizationOperationStore();
  const first = createHarness({ store });
  first.backend.queue({ status: 'rejected', reason: 'EVIDENCE_INVALID' });
  await first.reconciler.start();
  await first.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-36',
    source: 'shop',
  });
  first.provider.report(purchaseOf({ transactionId: 'tx-36' }));
  await first.reconciler.runUntilIdle();
  assertEqual(first.history('op-36').at(-1), 'rejected', 'rejected under the game key');
  await first.reconciler.stop();
  const second = createHarness({ store });
  second.provider.available.push(purchaseOf({ transactionId: 'tx-36' }));
  await second.reconciler.start();
  assertEqual(second.backend.requests.length, 0, 'the re-listed transaction is not verified again');
  assertEqual(
    await second.reconciler.read('store:fake-store:tx-36'),
    undefined,
    'no derived record',
  );
  assertEqual(second.transitions, [], 'no journal write');
  await second.reconciler.stop();
}

// 37. Capabilities are read again on explicit triggers, not on every event.
{
  let reads = 0;
  let availability: CommerceCapabilities['availability'] = 'configuration-required';
  const h = createHarness({
    provider: createFakeProvider({
      async getCapabilities() {
        reads += 1;
        return { ...capabilitiesOf(), availability };
      },
    }),
  });
  await h.reconciler.start();
  const afterStart = reads;
  h.provider.emit({ type: 'purchaseError', error: { code: 'UNKNOWN', retryable: false } });
  await h.reconciler.runUntilIdle();
  assertEqual(reads, afterStart, 'an event pass uses the cached block');
  availability = 'available';
  await h.reconciler.reconcile();
  assertEqual(reads, afterStart + 1, 'reconcile reads the block again');
  await h.reconciler.restorePurchases();
  assertEqual(reads, afterStart + 2, 'restore reads the block again');
  await h.reconciler.stop();
}

// 38. A client without an operation store warns once about the session-only journal.
{
  const warnings: string[] = [];
  const client = createGameServicesClient({
    gateway: createGateway(createFakeProvider()),
    backend: createBackendApi(createFakeBackend()),
    playerId: 'player-1',
    target: 'android',
    warn: (message) => void warnings.push(message),
  });
  assertEqual(warnings.length, 1, 'one warning');
  assertEqual(warnings[0]?.includes('operationStore'), true, 'naming the missing store');
  assertEqual(client.commerceReconciler !== undefined, true, 'the reconciler still exists');
  const silent: string[] = [];
  createGameServicesClient({
    gateway: createGateway(createFakeProvider()),
    backend: createBackendApi(createFakeBackend()),
    playerId: 'player-1',
    target: 'android',
    operationStore: createInMemoryMonetizationOperationStore(),
    warn: (message) => void silent.push(message),
  });
  assertEqual(silent, [], 'no warning with a store');
}

// Bot review threads on PR #344.

// 39. An unattributed purchaseError never ends an open attempt (CodeRabbit).
{
  const h = createHarness();
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-39',
    source: 'shop',
  });
  h.provider.emit({ type: 'purchaseError', error: { code: 'USER_CANCELLED', retryable: false } });
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-39'),
    ['requested', 'launched'],
    'an error without a product cannot be bound to the attempt',
  );
  h.provider.emit({
    type: 'purchaseError',
    logicalId: 'gems_small',
    error: { code: 'USER_CANCELLED', retryable: false },
  });
  await h.reconciler.runUntilIdle();
  assertEqual(h.history('op-39').at(-1), 'cancelled', 'an attributed error does');
  await h.reconciler.stop();
}

// 40. A game key equal to a derived key never adopts another transaction (Codex).
{
  const h = createHarness();
  await h.reconciler.start();
  // The game chose the derived form of tx-40 as its own key for another product.
  await h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'store:fake-store:tx-40',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-40' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('store:fake-store:tx-40'),
    ['requested', 'launched'],
    'the colliding record is untouched',
  );
  assertEqual(h.failures, ['match(store:fake-store:tx-40)'], 'the collision is reported');
  assertEqual(h.backend.requests.length, 0, 'nothing is verified under the wrong key');
  await h.reconciler.stop();
}

// 41. Concurrent starts share one subscription, and a failing initial pass leaves nothing started (Codex).
{
  let subscriptions = 0;
  const provider = createFakeProvider();
  const subscribe = provider.subscribe;
  provider.subscribe = (next) => {
    subscriptions += 1;
    return subscribe.call(provider, next);
  };
  const h = createHarness({ provider });
  await Promise.all([h.reconciler.start(), h.reconciler.start()]);
  assertEqual(subscriptions, 1, 'one subscription for two concurrent starts');
  await h.reconciler.stop();

  const store = createInMemoryMonetizationOperationStore();
  let lists = 0;
  const flaky: MonetizationOperationStore = {
    ...store,
    async listRecoverable(playerId) {
      lists += 1;
      // The load succeeds; the first pass's list fails.
      if (lists === 2) {
        throw new Error('journal unavailable');
      }
      return store.listRecoverable(playerId);
    },
  };
  const failing = createHarness({ store: flaky });
  await assertRejects(
    () => failing.reconciler.start(),
    /journal unavailable/u,
    'the initial pass failure fails the start',
  );
  assertEqual(failing.reconciler.started, false, 'nothing stays started');
  await failing.reconciler.start();
  assertEqual(failing.reconciler.started, true, 'the retry starts');
  await failing.reconciler.stop();
}

// 42. A failed start-time read of the available purchases is retried by the next pass (Codex).
{
  const provider = createFakeProvider();
  let availableDown = true;
  const getAvailablePurchases = provider.getAvailablePurchases;
  provider.getAvailablePurchases = async (request) => {
    if (availableDown) {
      throw new Error('store unavailable');
    }
    return getAvailablePurchases.call(provider, request);
  };
  provider.available.push(purchaseOf({ transactionId: 'tx-42' }));
  const h = createHarness({ provider });
  await h.reconciler.start();
  assertEqual(h.failures, ['available', 'available'], 'the start read and its retry failed');
  assertEqual(
    await h.reconciler.read('store:fake-store:tx-42'),
    undefined,
    'the purchase is not known yet',
  );
  availableDown = false;
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-42' });
  h.provider.emit({ type: 'purchaseError', error: { code: 'UNKNOWN', retryable: false } });
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('store:fake-store:tx-42').at(-1),
    'finished',
    'the next pass read the available purchases',
  );
  assertEqual(
    h.provider.availableReads,
    1,
    'one successful read; later passes do not poll an event provider',
  );
  h.provider.emit({ type: 'purchaseError', error: { code: 'UNKNOWN', retryable: false } });
  await h.reconciler.runUntilIdle();
  assertEqual(h.provider.availableReads, 1, 'the retry stops once the read succeeded');
  await h.reconciler.stop();
}

// 43. The finalization re-read that finishes a server-owned record is journaled as its last answer (Codex).
{
  const provider = createFakeProvider({
    capabilities: capabilitiesOf({ lifecycle: { finish: 'server' } }),
    withFinish: false,
  });
  const h = createHarness({ provider });
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-43', finalization: 'pending' });
  await h.reconciler.start();
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({ transactionId: 'tx-43' }),
  });
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-43',
    source: 'shop',
  });
  assertEqual(
    (await h.reconciler.read('op-43'))?.response?.finalization?.status,
    'pending',
    'the grant reported pending finalization',
  );
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-43', finalization: 'completed' });
  await h.reconciler.reconcile();
  const finished = await h.reconciler.read('op-43');
  assertEqual(finished?.state, 'finished', 'finished');
  assertEqual(
    finished?.response?.finalization?.status,
    'completed',
    'the re-read is the last backend answer',
  );
  await h.reconciler.stop();
}

// Delta review before the second push.

// 44. A same-key replay while the store sheet is open never releases the in-flight attempt.
{
  const h = createHarness();
  await h.reconciler.start();
  let answer: ((result: RequestPurchaseResult) => void) | undefined;
  const sheet = new Promise<RequestPurchaseResult>((resolve) => {
    answer = resolve;
  });
  const requestPurchase = h.provider.requestPurchase;
  h.provider.requestPurchase = async (request) => {
    await requestPurchase.call(h.provider, request);
    return sheet;
  };
  const inFlight = h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-44',
    source: 'shop',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replay = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-44',
    source: 'shop',
  });
  assertEqual(replay.outcome, 'launched', 'the replay answers from the journal');
  await h.reconciler.reconcile();
  assertEqual(
    h.history('op-44'),
    ['requested'],
    'the open sheet is still in flight; nothing expired it',
  );
  answer?.({ outcome: 'launched' });
  assertEqual((await inFlight).outcome, 'launched', 'the sheet answer is journaled');
  assertEqual(h.history('op-44'), ['requested', 'launched'], 'launched after the sheet');
  assertEqual(h.provider.purchaseUiOpened, 1, 'one sheet');
  await h.reconciler.stop();
}

// 45. Events for the in-flight product wait for the store answer: one record, one verify; a cancel event ends the attempt.
{
  const h = createHarness();
  await h.reconciler.start();
  let answer: ((result: RequestPurchaseResult) => void) | undefined;
  const sheet = new Promise<RequestPurchaseResult>((resolve) => {
    answer = resolve;
  });
  const requestPurchase = h.provider.requestPurchase;
  h.provider.requestPurchase = async (request) => {
    await requestPurchase.call(h.provider, request);
    return sheet;
  };
  const inFlight = h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-45',
    source: 'shop',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The store reports the purchase as an event before the sheet call resolves.
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-45' });
  h.provider.report(purchaseOf({ transactionId: 'tx-45' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    await h.reconciler.read('store:fake-store:tx-45'),
    undefined,
    'the event waited; no derived record',
  );
  answer?.({ outcome: 'launched' });
  await inFlight;
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-45'),
    fullClientHistory,
    'the waiting event matched the launched attempt',
  );
  assertEqual(
    h.backend.requests.map((request) => request.idempotencyKey),
    ['op-45'],
    'verified once, under the game key',
  );
  assertEqual(h.provider.finishCalls.length, 1, 'finished once');

  // A sheet open past inFlightTimeoutMs stops deferring: an event for the
  // product is journaled under its derived key, and the late synchronous
  // answer for the same transaction supersedes the attempt instead of
  // journaling the purchase twice.
  let clock = '2026-10-02T00:00:00.000Z';
  const late = createHarness({ overrides: { now: () => clock, inFlightTimeoutMs: 1_000 } });
  await late.reconciler.start();
  let lateAnswer: ((result: RequestPurchaseResult) => void) | undefined;
  const lateSheet = new Promise<RequestPurchaseResult>((resolve) => {
    lateAnswer = resolve;
  });
  const lateRequest = late.provider.requestPurchase;
  late.provider.requestPurchase = async (request) => {
    await lateRequest.call(late.provider, request);
    return lateSheet;
  };
  const lateCall = late.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-45b',
    source: 'shop',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  clock = '2026-10-02T00:00:02.000Z';
  late.backend.queue({ status: 'granted', ledgerEntryId: 'le-45b' });
  late.provider.report(
    purchaseOf({ transactionId: 'tx-45b', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  await late.reconciler.runUntilIdle();
  assertEqual(
    late.history('store:fake-store:tx-45b').at(-1),
    'finished',
    'after the timeout the event is journaled under its derived key',
  );
  lateAnswer?.({
    outcome: 'purchased',
    purchase: purchaseOf({
      transactionId: 'tx-45b',
      storeSku: 'remove.ads',
      logicalId: 'remove_ads',
    }),
  });
  const duplicate = await lateCall;
  assertEqual(
    duplicate.outcome === 'failed' && duplicate.error.code,
    'OUTCOME_UNKNOWN',
    'the late answer is superseded by the record that journals the transaction',
  );
  assertEqual(
    late.history('op-45b'),
    ['requested', 'failed'],
    'the stale attempt was ended by the pass; the late answer did not reopen it',
  );
  assertEqual(
    late.backend.requests.length,
    1,
    'the transaction was verified once, under its derived key',
  );
  await late.reconciler.stop();

  // A store that reuses an add-on id (Microsoft Store) still journals a
  // repurchase the game starts after the earlier purchase finished.
  h.provider.requestPurchase = requestPurchase;
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-45c' });
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({ transactionId: 'tx-45' }),
  });
  const repurchase = await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-45d',
    source: 'shop',
  });
  assertEqual(repurchase.outcome, 'purchased', 'the reused id is a new purchase');
  assertEqual(h.history('op-45d'), fullClientHistory, 'verified under the game key');

  // A cancel event during the sheet ends the attempt once the sheet reports launched.
  let cancelAnswer: ((result: RequestPurchaseResult) => void) | undefined;
  const cancelSheet = new Promise<RequestPurchaseResult>((resolve) => {
    cancelAnswer = resolve;
  });
  h.provider.requestPurchase = async (request) => {
    await requestPurchase.call(h.provider, request);
    return cancelSheet;
  };
  const cancelled = h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-45c',
    source: 'shop',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.provider.emit({
    type: 'purchaseError',
    logicalId: 'gems_small',
    error: { code: 'USER_CANCELLED', retryable: false },
  });
  await h.reconciler.runUntilIdle();
  cancelAnswer?.({ outcome: 'launched' });
  await cancelled;
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('op-45c'),
    ['requested', 'launched', 'cancelled'],
    'the waiting cancel event ended the launched attempt',
  );
  await h.reconciler.stop();
}

// 46. A store that renames the transaction once it assigns an order id keeps the same record (Play token key to order id).
{
  const h = createHarness();
  await h.reconciler.start();
  h.provider.report(
    purchaseOf({ transactionId: 'token-key-46', token: 'token-46', state: 'pending' }),
  );
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('store:fake-store:token-key-46'),
    ['pending'],
    'discovered while pending under the token key',
  );
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-46' });
  h.provider.report(purchaseOf({ transactionId: 'GPA.46', token: 'token-46', state: 'purchased' }));
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.history('store:fake-store:token-key-46'),
    ['pending', 'purchased', 'verifying', 'granted', 'finishing', 'finished'],
    'the same token advances the same record',
  );
  assertEqual(
    (await h.reconciler.read('store:fake-store:GPA.46')),
    undefined,
    'no second record under the order id',
  );
  assertEqual(h.failures, [], 'no collision reported');
  await h.reconciler.stop();
}

// 47. stop() during a start that is waiting for the lock tears the subscription down.
{
  let subscriptions = 0;
  let unsubscriptions = 0;
  const provider = createFakeProvider();
  const subscribe = provider.subscribe;
  provider.subscribe = (next) => {
    subscriptions += 1;
    const release = subscribe.call(provider, next);
    return () => {
      unsubscriptions += 1;
      release();
    };
  };
  const h = createHarness({ provider });
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Hold the lock with a purchase whose preparation waits on the journal.
  const store = h.store;
  const slowStore: MonetizationOperationStore = {
    ...store,
    async listRecoverable(playerId) {
      await blocked;
      return store.listRecoverable(playerId);
    },
  };
  const slow = createHarness({ store: slowStore, provider });
  const starting = slow.reconciler.start();
  const stopping = slow.reconciler.stop();
  release?.();
  await Promise.all([starting, stopping]);
  assertEqual(slow.reconciler.started, false, 'stopped');
  assertEqual(subscriptions, unsubscriptions, 'every subscription the start made was released');
  await h.reconciler.stop();
}

// 48. The retry interval covers failed finishes and finalization re-reads; explicit triggers retry at once.
{
  let clock = '2026-10-02T00:00:00.000Z';
  const h = createHarness({ overrides: { now: () => clock } });
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-48' });
  h.provider.queueFinish({
    throws: Object.assign(new Error('finish failed'), { code: 'NETWORK' }),
  });
  await h.reconciler.start();
  h.provider.queueRequest({
    outcome: 'purchased',
    purchase: purchaseOf({ transactionId: 'tx-48' }),
  });
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-48',
    source: 'shop',
  });
  assertEqual(h.history('op-48').at(-1), 'finishing', 'the finish failed');
  h.provider.emit({ type: 'purchaseError', error: { code: 'UNKNOWN', retryable: false } });
  await h.reconciler.runUntilIdle();
  assertEqual(
    h.provider.finishCalls.length,
    1,
    'an event pass inside the interval does not retry the finish',
  );
  await h.reconciler.reconcile();
  assertEqual(h.provider.finishCalls.length, 2, 'an explicit reconcile retries at once');
  assertEqual(h.history('op-48').at(-1), 'finished', 'finished');
  clock = '2026-10-02T00:02:00.000Z';
  await h.reconciler.stop();
}

// 49. The backend's published capabilities are compared with the provider at start (C2).
{
  const published = (
    finish: 'client' | 'server',
    store = 'fake-store',
  ): CommerceServiceCapabilities => ({
    commerceProtocolVersion: '2.0.0-draft.1',
    stores: [
      {
        store,
        schemas: ['fixture.fake-store.v1'],
        finish,
        purchase: { consumable: true, durable: true, subscription: false },
      },
    ],
  });
  const aligned = createHarness({
    backend: createFakeBackend({ serviceCapabilities: published('client') }),
  });
  await aligned.reconciler.start();
  assertEqual(
    aligned.reconciler.serviceAlignment?.status,
    'aligned',
    'the backend accepts the store as declared',
  );
  const alignedCapabilities = await aligned.reconciler.getCapabilities();
  assertEqual(alignedCapabilities.availability, 'available', 'availability unchanged');
  assertEqual(aligned.failures, [], 'no failure reported');
  await aligned.reconciler.stop();

  const v1 = createHarness({ backend: createFakeBackend() });
  await v1.reconciler.start();
  assertEqual(
    v1.reconciler.serviceAlignment,
    undefined,
    'a v1 backend publishes nothing to compare',
  );
  await v1.reconciler.stop();

  const finishMismatch = createHarness({
    backend: createFakeBackend({ serviceCapabilities: published('server') }),
  });
  await finishMismatch.reconciler.start();
  const alignment = finishMismatch.reconciler.serviceAlignment;
  assertEqual(
    alignment?.status === 'configuration-required' ? alignment.reason : alignment?.status,
    'FINISH_OWNER_MISMATCH',
    'a finish owner that disagrees is configuration-required',
  );
  assertEqual(
    (await finishMismatch.reconciler.getCapabilities()).availability,
    'configuration-required',
    'the reported capabilities carry the alignment',
  );
  assertEqual(finishMismatch.failures, ['capabilities'], 'the mismatch is reported once per read');
  const refused = await finishMismatch.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-49',
    source: 'shop',
  });
  assertEqual(
    refused.outcome === 'failed' ? refused.error.code : refused.outcome,
    'CONFIGURATION_REQUIRED',
    'no store UI opens while the deployment is misaligned',
  );
  const refusedRecord = await finishMismatch.reconciler.read('op-49');
  assertEqual(refusedRecord, undefined, 'the refusal leaves no record');
  assertEqual(finishMismatch.provider.purchaseUiOpened, 0, 'the store was not called');
  await finishMismatch.reconciler.stop();

  const notAccepted = createHarness({
    backend: createFakeBackend({ serviceCapabilities: published('client', 'other-store') }),
  });
  await notAccepted.reconciler.start();
  const missing = notAccepted.reconciler.serviceAlignment;
  assertEqual(
    missing?.status === 'configuration-required' ? missing.reason : missing?.status,
    'STORE_NOT_ACCEPTED',
    'a store the backend does not accept is configuration-required',
  );
  await notAccepted.reconciler.stop();

  // A v1 server behind a v2 client adapter answers 404 once: remembered, not a failure.
  const unpublished = createHarness({ backend: createFakeBackend({ capabilitiesNotFound: true }) });
  await unpublished.reconciler.start();
  assertEqual(unpublished.reconciler.serviceAlignment?.status, 'unpublished', 'remembered');
  assertEqual(unpublished.failures, [], 'a missing endpoint is not a failure');
  await unpublished.reconciler.reconcile();
  assertEqual(unpublished.backend.capabilityReads, 1, 'the 404 is not read again on refresh');
  await unpublished.reconciler.stop();

  // The same answer over oRPC from a Worker on either side of the oRPC 2.0.0-beta.34 error-body
  // change: NOT_FOUND must still read as a v1 server, not as a failed comparison.
  const recordedBeta14NotFound = new Response(
    '{"json":{"defined":false,"inferable":false,"code":"NOT_FOUND","message":"This backend publishes no commerce capabilities."}}',
    { status: 404, headers: { 'content-type': 'application/json' } },
  );
  const currentServerWithoutCapabilities = createGameServicesRpcFetchHandler(
    createGameServicesRouter({
      purchases: { verifyPurchase: () => Promise.reject(new Error('unused')) },
      adRewards: { claimAdReward: () => Promise.reject(new Error('unused')) },
      leaderboard: { recordScore: () => Promise.reject(new Error('unused')) },
    } as unknown as GameServicesBackendApi),
  );
  for (const [server, answer] of [
    ['an oRPC 2.0.0-beta.14 Worker', async () => recordedBeta14NotFound.clone()],
    [
      'a current Worker',
      (url: string, init?: RequestInit) => {
        return currentServerWithoutCapabilities(new Request(url, init));
      },
    ],
  ] as const) {
    const orpcBackend = createGameServicesOrpcBackendApi(
      createGameServicesOrpcClient({
        url: 'https://game-services.test/rpc',
        fetch: answer as typeof fetch,
      }),
    );
    const overOrpc = createHarness({ overrides: { backend: orpcBackend.purchases } });
    await overOrpc.reconciler.start();
    assertEqual(
      overOrpc.reconciler.serviceAlignment?.status,
      'unpublished',
      `NOT_FOUND from ${server} reads as unpublished`,
    );
    assertEqual(overOrpc.failures, [], `NOT_FOUND from ${server} is not a failure`);
    await overOrpc.reconciler.stop();
  }

  // A purchase before start() attempts the comparison before any store UI opens.
  const early = createHarness({
    backend: createFakeBackend({ serviceCapabilities: published('server') }),
  });
  const earlyResult = await early.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-49b',
    source: 'shop',
  });
  assertEqual(
    earlyResult.outcome === 'failed' ? earlyResult.error.code : earlyResult.outcome,
    'CONFIGURATION_REQUIRED',
    'the comparison runs before the first purchase even without start()',
  );
  assertEqual(early.provider.purchaseUiOpened, 0, 'the store was not called');

  // A hung read keeps the last comparison after the timeout instead of holding the lock.
  const hung = createHarness({
    backend: createFakeBackend({ capabilitiesHang: true }),
    overrides: { serviceCapabilitiesTimeoutMs: 5 },
  });
  await hung.reconciler.start();
  assertEqual(hung.reconciler.serviceAlignment, undefined, 'nothing compared yet');
  assertEqual(hung.failures, ['capabilities'], 'the timeout is reported');
  await hung.reconciler.stop();
}

// 50. The revocation pass reads ledger status in chunks scoped to the player (C2).
{
  const backend = createFakeBackend({ withLedgerStatus: true });
  const h = createHarness({ backend });
  await h.reconciler.start();
  for (let index = 0; index < 120; index += 1) {
    backend.queue({ status: 'granted', ledgerEntryId: `le-chunk-${String(index)}` });
    h.provider.report(purchaseOf({ transactionId: `tx-chunk-${String(index)}` }));
  }
  await h.reconciler.runUntilIdle();
  backend.ledgerStatusRequests.length = 0;
  await h.reconciler.reconcile();
  assertEqual(
    backend.ledgerStatusRequests.map((request) => request.ledgerEntryIds.length),
    [100, 20],
    'granted records are read in chunks of at most 100 ids',
  );
  assertEqual(
    backend.ledgerStatusRequests.every((request) => request.playerId === 'player-1'),
    true,
    'every chunk names the player whose grants it reads',
  );
  await h.reconciler.stop();

  // A pre-C2 backend behind an adapter that always exposes the read: asked once, then inert.
  const legacy = createFakeBackend({ withLedgerStatus: true, ledgerStatusNotFound: true });
  const quiet = createHarness({ backend: legacy });
  legacy.queue({ status: 'granted', ledgerEntryId: 'le-legacy' });
  await quiet.reconciler.start();
  quiet.provider.report(purchaseOf({ transactionId: 'tx-legacy' }));
  await quiet.reconciler.runUntilIdle();
  await quiet.reconciler.reconcile();
  assertEqual(legacy.ledgerStatusRequests.length, 1, 'the 404 is remembered');
  assertEqual(quiet.failures, [], 'a missing ledger status read is not a failure');
  await quiet.reconciler.stop();
  assertThrowsSync(
    () => createHarness({ overrides: { serviceCapabilitiesTimeoutMs: 0 } }),
    /positive finite duration/u,
  );
}

// Restore follow-ups (L6a).

// 51. A restore pending at the holder limit is resent by Restore Purchases only: a reconcile, an
// event pass after the retry interval, and a restart leave it; other pending reasons still retry.
{
  let clock = '2026-10-02T00:00:00.000Z';
  const provider = createFakeProvider({ withRestore: true });
  const h = createHarness({ provider, overrides: { now: () => clock, retryIntervalMs: 60_000 } });
  await h.reconciler.start();
  h.backend.queue({ status: 'pending', reason: 'PURCHASE_HOLDER_LIMIT_REACHED' });
  provider.available.push(
    purchaseOf({ transactionId: 'tx-51', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  await h.reconciler.restorePurchases();
  const key = 'store:fake-store:tx-51';
  assertEqual(h.backend.requests.length, 1, 'Restore Purchases sends the restore once');
  assertEqual(h.history(key).at(-1), 'pending', 'the backend answered pending at the holder limit');

  await h.reconciler.reconcile();
  clock = '2026-10-02T00:05:00.000Z';
  provider.emit({ type: 'purchaseError', error: { code: 'UNKNOWN', retryable: false } });
  await h.reconciler.runUntilIdle();
  await h.reconciler.stop();
  const relaunched = createHarness({
    provider,
    backend: h.backend,
    store: h.store,
    overrides: { now: () => clock, retryIntervalMs: 60_000 },
  });
  await relaunched.reconciler.start();
  assertEqual(
    h.backend.requests.length,
    1,
    'a reconcile, an event pass after the retry interval, and a restart never resend it',
  );
  assertEqual(
    (await relaunched.reconciler.listRecoverable()).map((record) => record.state),
    ['pending'],
    'the restore stays pending for the game to report',
  );

  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-51' });
  await relaunched.reconciler.restorePurchases();
  assertEqual(h.backend.requests.length, 2, "the player's Restore Purchases resends it");
  assertEqual(
    h.backend.requests[1],
    h.backend.requests[0],
    'the saved request is resent unchanged',
  );
  assertEqual(
    relaunched.history(key).slice(-2),
    ['finishing', 'finished'],
    'a freed holder lets the restore land',
  );

  // Another backend-pending reason keeps the automatic retry.
  h.backend.queue({ status: 'pending', reason: 'PURCHASE_HOLDER_CONFLICT' });
  provider.report(
    purchaseOf({ transactionId: 'tx-51b', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  await relaunched.reconciler.runUntilIdle();
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-51b' });
  await relaunched.reconciler.reconcile();
  assertEqual(
    relaunched.history('store:fake-store:tx-51b'),
    ['purchased', 'verifying', 'pending', 'verifying', 'granted', 'finishing', 'finished'],
    'a restore pending after lost races is resent by the next reconcile',
  );
  assertEqual([...h.failures, ...relaunched.failures], [], 'no stage failed');
  await relaunched.reconciler.stop();

  // A polled provider: the Restore Purchases pass reads and resends; its later polls do not.
  const polledProvider = createFakeProvider({
    capabilities: capabilitiesOf({ lifecycle: { events: false } }),
  });
  const polled = createHarness({ provider: polledProvider });
  await polled.reconciler.start();
  polled.backend.queue({ status: 'pending', reason: 'PURCHASE_HOLDER_LIMIT_REACHED' });
  polledProvider.available.push(
    purchaseOf({ transactionId: 'tx-51p', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  await polled.reconciler.restorePurchases();
  await polled.reconciler.reconcile();
  await polled.reconciler.reconcile();
  assertEqual(polled.backend.requests.length, 1, 'polling passes never resend it');
  polled.backend.queue({ status: 'granted', ledgerEntryId: 'le-51p' });
  await polled.reconciler.restorePurchases();
  assertEqual(
    polled.history('store:fake-store:tx-51p').at(-1),
    'finished',
    "a polled provider's Restore Purchases resends it",
  );
  await polled.reconciler.stop();
}

// 52. Logout, then another player on the same install: a durable the earlier player journaled
// first under the shared derived key is the new player's own restore, journaled under its
// player-scoped key; the earlier player's consumable is never sent for it, and the earlier
// player's records (the pre-L6a journal format) are read and resumed unchanged.
{
  const store = createInMemoryMonetizationOperationStore();
  const provider = createFakeProvider({ withRestore: true });
  const backend = createFakeBackend();
  const removeAds = (): StorePurchase =>
    purchaseOf({ transactionId: 'tx-52', storeSku: 'remove.ads', logicalId: 'remove_ads' });
  const adsKey = 'store:fake-store:tx-52';
  const gemsKey = 'store:fake-store:tx-52c';
  const earlier = createHarness({ store, provider, backend });
  await earlier.reconciler.start();
  backend.queue({ status: 'granted', ledgerEntryId: 'le-52' });
  backend.queue({ status: 'pending' });
  provider.available.push(removeAds(), purchaseOf({ transactionId: 'tx-52c' }));
  await earlier.reconciler.restorePurchases();
  assertEqual(
    [earlier.history(adsKey).at(-1), earlier.history(gemsKey).at(-1)],
    ['finished', 'pending'],
    "the earlier player's durable is granted and its consumable waits on the backend",
  );
  await earlier.reconciler.stop();

  // Logout. The store still lists the owned durable on a restore read.
  provider.available.push(removeAds());
  const next = createHarness({ store, provider, backend, overrides: { playerId: 'player-2' } });
  backend.queue({ status: 'granted', ledgerEntryId: 'le-52-next' });
  await next.reconciler.start();
  await next.reconciler.reconcile();
  assertEqual(
    backend.requests.length,
    2,
    "automatic passes never take the earlier player's durable: only Restore Purchases does",
  );
  assertEqual(
    await store.read(createCommercePurchaseOperationKey('android', adsKey, 'player-2')),
    undefined,
    'nothing is journaled under the player-scoped key before Restore Purchases',
  );
  await next.reconciler.restorePurchases();
  assertEqual(
    backend.requests.slice(2).map((request) => [
      request.playerId,
      request.idempotencyKey,
      request.intent,
    ]),
    [['player-2', adsKey, 'restore']],
    "only the durable is sent for the next player, as its own restore; the earlier player's consumable is not",
  );
  assertEqual(next.history(adsKey).at(-1), 'finished', "the next player's restore lands");
  assertEqual(
    next.failures.every((failure) => failure === 'journal') && next.failures.length > 0,
    true,
    "the earlier player's consumable under the shared key is still refused",
  );
  const shared = await store.read(createCommercePurchaseOperationKey('android', adsKey));
  const scoped = await store.read(
    createCommercePurchaseOperationKey('android', adsKey, 'player-2'),
  );
  assertEqual(
    [
      shared?.playerId,
      scoped?.playerId,
      scoped?.kind === 'commerce-purchase' ? scoped.state : undefined,
    ],
    ['player-1', 'player-2', 'finished'],
    "the earlier player keeps the shared key; the next player's record is under its player-scoped key",
  );
  assertEqual(
    (await store.read(createCommercePurchaseOperationKey('android', gemsKey)))?.revision,
    earlier.history(gemsKey).length - 1,
    "the earlier player's consumable record is never rewritten",
  );
  assertEqual(
    (await next.reconciler.read(adsKey))?.playerId,
    'player-2',
    'read answers the scoped record',
  );
  await assertRejects(
    () => next.reconciler.read(gemsKey),
    /bound to another player/u,
    "read still refuses a key only the earlier player's consumable record holds",
  );
  await next.reconciler.stop();

  // A restart over a journal without the transaction index or the granted list reaches the
  // player-scoped key through the derived key, and sends nothing again.
  // The store still lists the owned durable on a restore read.
  provider.available.push(removeAds());
  const {
    findByTransaction: _findByTransaction,
    listGranted: _listGranted,
    ...unindexed
  } = store;
  const restarted = createHarness({
    store: unindexed,
    provider,
    backend,
    overrides: { playerId: 'player-2' },
  });
  assertEqual(
    (await restarted.reconciler.read(adsKey))?.playerId,
    'player-2',
    'before any pass, read finds the player-scoped record in the journal',
  );
  await restarted.reconciler.start();
  await restarted.reconciler.restorePurchases();
  assertEqual(backend.requests.length, 3, 'the restored durable is matched to its scoped record');
  await restarted.reconciler.stop();
  assertEqual(
    createCommercePurchaseOperationKey('android', adsKey, 'player-2')
      === createCommercePurchaseOperationKey('android', adsKey),
    false,
    'the player-scoped key never equals the shared key',
  );

  // The journal's retention dropped the earlier player's finished record (open ones are kept): the
  // shared key is free, and the next player's record is still found under its player-scoped key,
  // not journaled again.
  const pruned = createInMemoryMonetizationOperationStore();
  for (const key of [
    createCommercePurchaseOperationKey('android', adsKey, 'player-2'),
    createCommercePurchaseOperationKey('android', gemsKey),
  ]) {
    const kept = await store.read(key);
    if (kept === undefined) {
      throw new Error(`${key} is journaled`);
    }
    await pruned.reserve(kept);
  }
  const {
    findByTransaction: _prunedIndex,
    listGranted: _prunedGranted,
    ...prunedUnindexed
  } = pruned;
  const afterRetention = createHarness({
    store: prunedUnindexed,
    provider,
    backend,
    overrides: { playerId: 'player-2' },
  });
  await afterRetention.reconciler.start();
  await afterRetention.reconciler.restorePurchases();
  assertEqual(backend.requests.length, 3, 'the restored durable is not sent again');
  assertEqual(
    (await afterRetention.reconciler.read(adsKey))?.playerId,
    'player-2',
    'with the shared key free, the player-scoped record is the one matched',
  );
  assertEqual(
    await pruned.read(createCommercePurchaseOperationKey('android', adsKey)),
    undefined,
    'nothing is journaled under the freed shared key',
  );
  await afterRetention.reconciler.stop();

  // The earlier player logs back in: its own records under the shared key resume unchanged.
  const back = createHarness({ store, provider, backend });
  backend.queue({ status: 'granted', ledgerEntryId: 'le-52c' });
  await back.reconciler.start();
  assertEqual(
    backend.requests.slice(3).map((request) => [request.playerId, request.idempotencyKey]),
    [['player-1', gemsKey]],
    "only the earlier player's own pending consumable is resent, for that player",
  );
  assertEqual(back.failures, [], 'nothing of the next player blocks the earlier one');
  await back.reconciler.stop();
}

// 53. A consumable a client-finish store reports again after its record finished (a finish
// reported done without a native call, then the store listed it again) is finished again once
// per session with the journaled ledger entry; it is never verified again. A durable, which a
// store keeps listing after its finish, and a server-finish store are left alone.
{
  const store = createInMemoryMonetizationOperationStore();
  const first = createHarness({ store });
  first.backend.queue({ status: 'granted', ledgerEntryId: 'le-53' });
  first.backend.queue({ status: 'granted', ledgerEntryId: 'le-53d' });
  await first.reconciler.start();
  await first.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-53',
    source: 'shop',
  });
  first.provider.report(purchaseOf({ transactionId: 'tx-53' }));
  await first.reconciler.runUntilIdle();
  await first.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-53d',
    source: 'shop',
  });
  first.provider.report(
    purchaseOf({ transactionId: 'tx-53d', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  await first.reconciler.runUntilIdle();
  assertEqual(
    [first.history('op-53').at(-1), first.history('op-53d').at(-1)],
    ['finished', 'finished'],
    'both purchases finished',
  );
  const transitionsBefore = first.transitions.length;
  first.provider.report(purchaseOf({ transactionId: 'tx-53' }));
  first.provider.report(
    purchaseOf({ transactionId: 'tx-53d', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  await first.reconciler.runUntilIdle();
  first.provider.report(purchaseOf({ transactionId: 'tx-53' }));
  await first.reconciler.runUntilIdle();
  assertEqual(
    first.provider.finishCalls.map((call) => [
      call.transactionId,
      call.ledgerEntryId,
      call.isConsumable,
    ]),
    [
      ['tx-53', 'le-53', true],
      ['tx-53d', 'le-53d', false],
      ['tx-53', 'le-53', true],
    ],
    'the consumable reported again is finished again once this session; the durable is not',
  );
  assertEqual(first.backend.requests.length, 2, 'nothing is verified again');
  assertEqual(
    first.transitions.length,
    transitionsBefore,
    'the finished records are not rewritten',
  );
  await first.reconciler.stop();

  // A finish that failed in transport is reported and tried again on the next report; one the
  // store refused is reported and left for the next session, which tries again from the journal.
  const failing = createHarness({ store });
  failing.provider.available.push(purchaseOf({ transactionId: 'tx-53' }));
  failing.provider.queueFinish({ throws: new Error('store unavailable') });
  failing.provider.queueFinish({ finished: false });
  await failing.reconciler.start();
  assertEqual(failing.failures, ['finish(op-53)'], 'the failed finish is reported');
  failing.provider.report(purchaseOf({ transactionId: 'tx-53' }));
  await failing.reconciler.runUntilIdle();
  failing.provider.report(purchaseOf({ transactionId: 'tx-53' }));
  await failing.reconciler.runUntilIdle();
  assertEqual(
    failing.provider.finishCalls.length,
    2,
    'the transport failure is tried again on the next report; the refusal is not, this session',
  );
  assertEqual(failing.failures, ['finish(op-53)', 'finish(op-53)'], 'the refusal is reported too');
  assertEqual(failing.backend.requests.length, 0, 'nothing is verified again');
  const next = createHarness({ store });
  next.provider.available.push(purchaseOf({ transactionId: 'tx-53' }));
  await next.reconciler.start();
  assertEqual(
    next.provider.finishCalls,
    [{ transactionId: 'tx-53', ledgerEntryId: 'le-53', isConsumable: true }],
    'a restart finishes the listed consumable from the journal',
  );
  assertEqual(next.backend.requests.length, 0, 'a restart verifies nothing');
  assertEqual(next.history('op-53'), [], 'the record stays finished');
  await failing.reconciler.stop();
  await next.reconciler.stop();

  // A server-finish store finishes nothing on the client.
  const server = createHarness({
    provider: createFakeProvider({
      capabilities: capabilitiesOf({ lifecycle: { finish: 'server' } }),
    }),
  });
  server.backend.queue({ status: 'granted', ledgerEntryId: 'le-53s', finalization: 'completed' });
  await server.reconciler.start();
  await server.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-53s',
    source: 'shop',
  });
  server.provider.report(purchaseOf({ transactionId: 'tx-53s' }));
  await server.reconciler.runUntilIdle();
  assertEqual(server.history('op-53s').at(-1), 'finished', 'the server finalized the grant');
  server.provider.report(purchaseOf({ transactionId: 'tx-53s' }));
  await server.reconciler.runUntilIdle();
  assertEqual(
    server.provider.finishCalls,
    [],
    'a server-finish purchase reported again is not finished',
  );
  assertEqual(server.backend.requests.length, 1, 'nor verified again');
  await server.reconciler.stop();
}

// 54. Only a finish of a record that was already `finishing` carries `retry`, only for a
// `client` owner, and only to a provider that declares `acceptsFinishRetry`: the first finish
// after the grant never does, so a store cannot read a transaction its list does not carry yet
// as a lost acknowledgement, and a provider on the earlier contract never sees the field.
{
  const h = createHarness();
  h.backend.queue({ status: 'granted', ledgerEntryId: 'le-54' });
  h.provider.queueFinish({ finished: false });
  await h.reconciler.start();
  await h.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-54',
    source: 'shop',
  });
  h.provider.report(purchaseOf({ transactionId: 'tx-54' }));
  await h.reconciler.runUntilIdle();
  await h.reconciler.reconcile();
  assertEqual(
    h.provider.finishCalls,
    [
      { transactionId: 'tx-54', ledgerEntryId: 'le-54', isConsumable: true },
      { transactionId: 'tx-54', ledgerEntryId: 'le-54', isConsumable: true, retry: true },
    ],
    'the first finish is not a retry; the next one is',
  );
  assertEqual(h.history('op-54').at(-1), 'finished', 'the retry finished it');
  await h.reconciler.stop();

  const host = createHarness({
    provider: createFakeProvider({
      capabilities: capabilitiesOf({ lifecycle: { finish: 'host' } }),
    }),
  });
  host.backend.queue({ status: 'granted', ledgerEntryId: 'le-54h' });
  host.provider.queueFinish({ finished: false });
  await host.reconciler.start();
  await host.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-54h',
    source: 'shop',
  });
  host.provider.report(purchaseOf({ transactionId: 'tx-54h' }));
  await host.reconciler.runUntilIdle();
  await host.reconciler.reconcile();
  assertEqual(
    host.provider.finishCalls.map((call) => call.retry),
    [undefined, undefined],
    'a host finish never carries the hint',
  );
  await host.reconciler.stop();

  const earlier = createHarness({ provider: createFakeProvider({ acceptsFinishRetry: false }) });
  earlier.backend.queue({ status: 'granted', ledgerEntryId: 'le-54e' });
  earlier.provider.queueFinish({ finished: false });
  await earlier.reconciler.start();
  await earlier.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-54e',
    source: 'shop',
  });
  earlier.provider.report(purchaseOf({ transactionId: 'tx-54e' }));
  await earlier.reconciler.runUntilIdle();
  await earlier.reconciler.reconcile();
  assertEqual(
    earlier.provider.finishCalls.map((call) => call.retry),
    [undefined, undefined],
    'a provider that does not declare acceptsFinishRetry never gets the hint',
  );
  assertEqual(earlier.history('op-54e').at(-1), 'finished', 'and still finishes');
  await earlier.reconciler.stop();
}

function assertThrowsSync(run: () => unknown, pattern: RegExp): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof Error) || !pattern.test(thrown.message)) {
    throw new Error(`Expected ${String(pattern)}, received ${String(thrown)}.`);
  }
}

// 55. `closed`: while it answers true, `start()` subscribes nothing and starts nothing (an
// owner closed for good, after its `stop()`); without the input a stopped reconciler starts
// again.
{
  const countSubscriptions = (provider: FakeProvider): { readonly open: () => number } => {
    let open = 0;
    const subscribe = provider.subscribe;
    provider.subscribe = (next) => {
      open += 1;
      const release = subscribe.call(provider, next);
      return () => {
        open -= 1;
        release();
      };
    };
    return { open: () => open };
  };

  let closed = false;
  const owned = createFakeProvider();
  const ownedSubscriptions = countSubscriptions(owned);
  const h = createHarness({ provider: owned, overrides: { closed: () => closed } });
  await h.reconciler.start();
  assertEqual(ownedSubscriptions.open(), 1, 'an open owner starts as usual');
  closed = true;
  await h.reconciler.stop();
  assertEqual(ownedSubscriptions.open(), 0, 'stop unsubscribes');
  await h.reconciler.start();
  assertEqual(ownedSubscriptions.open(), 0, 'a closed owner subscribes nothing');
  assertEqual(h.reconciler.started, false, 'and starts nothing');

  const plain = createFakeProvider();
  const plainSubscriptions = countSubscriptions(plain);
  const restartable = createHarness({ provider: plain });
  await restartable.reconciler.start();
  await restartable.reconciler.stop();
  assertEqual(plainSubscriptions.open(), 0, 'stop unsubscribes');
  await restartable.reconciler.start();
  assertEqual(plainSubscriptions.open(), 1, 'without `closed` a stopped reconciler starts again');
  assertEqual(restartable.reconciler.started, true, 'and is started');
  await restartable.reconciler.stop();
}

// 56. Another account's purchase (RFC "Another account's purchase"): the backend answers
// PURCHASE_BOUND_TO_ANOTHER_ACCOUNT. The record is parked in `verifying` (never ended,
// never resent automatically, not listed, `rejected` for this player), its shared key is
// left to the purchase's account, and only this player's Restore Purchases asks again.
{
  const store = createInMemoryMonetizationOperationStore();
  const provider = createFakeProvider();
  const backend = createFakeBackend();
  const gemsKey = 'store:fake-store:tx-56';
  const sharedKey = createCommercePurchaseOperationKey('android', gemsKey);
  const httpAnswer = Object.assign(new Error('GameServices backend request failed'), {
    status: 409,
    body: { error: 'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT', reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH' },
  });

  // Player 2's session reaches player 1's consumable (no client-side binding check).
  const other = createHarness({ store, provider, backend, overrides: { playerId: 'player-2' } });
  provider.available.push(purchaseOf({ transactionId: 'tx-56' }));
  backend.queue({ throws: httpAnswer });
  await other.reconciler.start();
  assertEqual(
    other.history(gemsKey),
    ['purchased', 'verifying'],
    "another account's purchase is never ended as rejected",
  );
  const parked = await other.reconciler.read(gemsKey);
  assertEqual(
    [parked?.state, parked?.anotherAccount?.reason, parked?.request?.playerId],
    ['verifying', 'GOOGLE_PLAY_ACCOUNT_MISMATCH', 'player-2'],
    'the record is parked with the binding mismatch and its saved request',
  );
  assertEqual(other.failures, [`verify(${gemsKey})`], 'the answer is reported as a verify failure');
  assertEqual(
    toGameServicesPurchaseResult(parked as CommercePurchaseOperationRecord).status,
    'rejected',
    'nothing was or will be granted to this player',
  );
  assertEqual(
    await other.reconciler.listRecoverable(),
    [],
    "a parked record is not this player's to recover",
  );
  assertEqual(
    isMonetizationOperationRecoverable(parked as CommercePurchaseOperationRecord),
    true,
    'the journal keeps it open: it is not ended for the store transaction',
  );
  await other.reconciler.reconcile();
  await other.reconciler.reconcile();
  assertEqual(backend.requests.length, 1, 'start, resume, and events never resend it');
  // It never serializes this player's own purchases of the product.
  const ownAttempt = await other.reconciler.requestPurchase({
    logicalId: 'gems_small',
    idempotencyKey: 'op-56-own',
    source: 'shop',
  });
  assertEqual(
    ownAttempt,
    { outcome: 'launched' },
    'a new purchase of the product is not IN_PROGRESS',
  );
  await other.reconciler.stop();

  // A restart over the same journal leaves it parked.
  const otherAgain = createHarness({
    store,
    provider,
    backend,
    overrides: { playerId: 'player-2' },
  });
  await otherAgain.reconciler.start();
  assertEqual(backend.requests.length, 1, 'a restart does not resend a parked record');
  await otherAgain.reconciler.stop();

  // The purchase's own account on the same install: the shared key does not refuse it.
  const owner = createHarness({ store, provider, backend });
  backend.queue({ status: 'granted', ledgerEntryId: 'le-56' });
  await owner.reconciler.start();
  assertEqual(
    backend.requests.slice(1).map((request) => [request.playerId, request.idempotencyKey]),
    [['player-1', gemsKey]],
    'the owner sends the same derived key for itself',
  );
  assertEqual(
    owner.history(gemsKey).at(-1),
    'finished',
    "the owner's purchase is granted and finished",
  );
  assertEqual(
    [
      (await store.read(sharedKey))?.playerId,
      (await store.read(createCommercePurchaseOperationKey('android', gemsKey, 'player-1')))
        ?.playerId,
    ],
    ['player-2', 'player-1'],
    "the owner's record is under its player-scoped key; the parked record keeps the shared key",
  );
  assertEqual(owner.failures, [], 'nothing of the other player blocks the owner');
  assertEqual(
    (await owner.reconciler.read(gemsKey))?.playerId,
    'player-1',
    "read answers the owner's scoped record",
  );
  await owner.reconciler.stop();
}

// 56b. Only the parked player's Restore Purchases sends it again, once per report; the
// oRPC shape of the answer parks as the HTTP one does.
{
  const provider = createFakeProvider({ withRestore: true });
  const backend = createFakeBackend();
  const key = 'store:fake-store:tx-56b';
  const h = createHarness({ provider, backend });
  provider.available.push(purchaseOf({ transactionId: 'tx-56b' }));
  backend.queue({
    throws: Object.assign(new Error('bound'), {
      code: 'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT',
      data: { reason: 'APP_STORE_ACCOUNT_TOKEN_MISMATCH' },
    }),
  });
  await h.reconciler.start();
  assertEqual(
    (await h.reconciler.read(key))?.anotherAccount?.reason,
    'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
    'the oRPC error parks the record with its reason',
  );
  backend.queue({ status: 'granted', ledgerEntryId: 'le-56b' });
  await h.reconciler.restorePurchases();
  assertEqual(backend.requests.length, 2, 'Restore Purchases asks the backend again');
  const restored = await h.reconciler.read(key);
  assertEqual(
    [restored?.state, restored?.anotherAccount],
    ['finished', undefined],
    'a restore the backend now grants (a changed policy or binding) lands normally',
  );
}

// 56c. A backend from before the answer: a `rejected` receipt with a store binding
// mismatch reason is parked the same way (no other reason is); a journal written before
// it, holding another player's terminal mismatch record, leaves the key to the owner.
{
  const store = createInMemoryMonetizationOperationStore();
  const provider = createFakeProvider();
  const backend = createFakeBackend();
  const mismatchKey = 'store:fake-store:tx-56c';
  const otherKey = 'store:fake-store:tx-56d';
  const h = createHarness({ store, provider, backend, overrides: { playerId: 'player-2' } });
  provider.available.push(
    purchaseOf({ transactionId: 'tx-56c' }),
    purchaseOf({ transactionId: 'tx-56d', storeSku: 'remove.ads', logicalId: 'remove_ads' }),
  );
  backend.queue({ status: 'rejected', reason: 'GOOGLE_PLAY_PROFILE_MISMATCH' });
  backend.queue({ status: 'rejected', reason: 'GOOGLE_PLAY_ACCOUNT_ID_MISSING' });
  await h.reconciler.start();
  const legacy = await h.reconciler.read(mismatchKey);
  assertEqual(
    [legacy?.state, legacy?.anotherAccount?.reason, legacy?.response?.reason],
    ['verifying', 'GOOGLE_PLAY_PROFILE_MISMATCH', 'GOOGLE_PLAY_PROFILE_MISMATCH'],
    "an older backend's mismatch receipt is parked, keeping the receipt",
  );
  assertEqual(
    h.history(otherKey).at(-1),
    'rejected',
    'any other rejection, a missing binding included, still ends the record',
  );
  await h.reconciler.stop();

  // A journal from before the answer: player 2 ended player 1's purchase as rejected.
  const pre = createInMemoryMonetizationOperationStore();
  const preKey = 'store:fake-store:tx-56e';
  await pre.reserve({
    kind: 'commerce-purchase',
    key: createCommercePurchaseOperationKey('android', preKey),
    playerId: 'player-2',
    target: 'android',
    deploymentTarget: 'android',
    revision: 3,
    idempotencyKey: preKey,
    store: 'fake-store',
    logicalId: 'gems_small',
    productKind: 'consumable',
    origin: 'discovered',
    state: 'rejected',
    updatedAt: '2026-10-01T00:00:00.000Z',
    purchase: purchaseOf({ transactionId: 'tx-56e' }),
    response: {
      verified: false,
      alreadyProcessed: false,
      disposition: 'rejected',
      reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
    },
  } satisfies CommercePurchaseOperationRecord);
  const preProvider = createFakeProvider();
  const preBackend = createFakeBackend();
  preProvider.available.push(purchaseOf({ transactionId: 'tx-56e' }));
  preBackend.queue({ status: 'granted', ledgerEntryId: 'le-56e' });
  const owner = createHarness({ store: pre, provider: preProvider, backend: preBackend });
  await owner.reconciler.start();
  assertEqual(
    [owner.history(preKey).at(-1), preBackend.requests[0]?.playerId],
    ['finished', 'player-1'],
    'the owner recovers its purchase despite the old rejected record',
  );
  await owner.reconciler.stop();

  // Another player's terminal record for any other reason still refuses the key.
  const refused = createInMemoryMonetizationOperationStore();
  const refusedKey = 'store:fake-store:tx-56f';
  await refused.reserve({
    kind: 'commerce-purchase',
    key: createCommercePurchaseOperationKey('android', refusedKey),
    playerId: 'player-2',
    target: 'android',
    deploymentTarget: 'android',
    revision: 3,
    idempotencyKey: refusedKey,
    store: 'fake-store',
    logicalId: 'gems_small',
    productKind: 'consumable',
    origin: 'discovered',
    state: 'rejected',
    updatedAt: '2026-10-01T00:00:00.000Z',
    purchase: purchaseOf({ transactionId: 'tx-56f' }),
    response: {
      verified: false,
      alreadyProcessed: false,
      disposition: 'rejected',
      reason: 'GOOGLE_PLAY_PURCHASE_REFUNDED',
    },
  } satisfies CommercePurchaseOperationRecord);
  const refusedProvider = createFakeProvider();
  const refusedBackend = createFakeBackend();
  refusedProvider.available.push(purchaseOf({ transactionId: 'tx-56f' }));
  const refusedOwner = createHarness({
    store: refused,
    provider: refusedProvider,
    backend: refusedBackend,
  });
  await refusedOwner.reconciler.start();
  assertEqual(
    [refusedBackend.requests.length, refusedOwner.failures],
    [0, ['journal']],
    "a key another player's record holds for any other reason is still refused",
  );
  await refusedOwner.reconciler.stop();
}

console.info('commerce reconciler tests passed');
