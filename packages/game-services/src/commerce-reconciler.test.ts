import type { AnalyticsEvent } from '@mpgd/analytics';
import type { PlatformGateway } from '@mpgd/platform';
import {
  createCommerceEventBuffer,
  createGooglePlayTokenPurchaseKey,
  type CommerceCapabilities,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceProvider,
  type FinishTransactionInput,
  type RequestPurchaseResult,
  type StorePurchase,
} from '@mpgd/platform/commerce';

import {
  createGameServicesClient,
  type GameServicesBackendApi,
  type PurchaseVerificationApi,
} from './client.js';
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
    available,
    finishCalls,
    get purchaseUiOpened() {
      return purchaseUiOpened;
    },
    get availableReads() {
      return availableReads;
    },
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
  queue(decision: Decision): void;
  reverse(ledgerEntryId: string, by: string): void;
}

function createFakeBackend(options: { readonly withLedgerStatus?: boolean } = {}): FakeBackend {
  const decisions: Decision[] = [];
  const requests: VerifyPurchaseRequest[] = [];
  const reversed = new Map<string, string>();
  return {
    requests,
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
    ...(options.withLedgerStatus === true
      ? {
          async getPurchaseLedgerStatus(input: { readonly ledgerEntryIds: readonly string[] }) {
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
      playerId: 'player-1',
      productId: 'gems_small',
      platformTransactionId: 'tx-1',
      idempotencyKey: 'op-1',
      purchasedAt: '2026-10-01T00:00:00.000Z',
      evidence: { schema: 'fixture.fake-store.v1', payload: { token: 'token-tx-1' } },
    },
    'the verify request carries the game key, the store transaction, its evidence, and the store purchase time',
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
  assertEqual(h.history('op-7b'), ['requested', 'failed'], 'the refused attempt is journaled');
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
    [{ transactionId: 'tx-13', ledgerEntryId: 'le-13', isConsumable: true }],
    'the finish was retried with the journaled ledger entry',
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
    (await store.listRecoverable('player-1')).map((record) => record.key).length,
    2,
    'both foreign records remain untouched',
  );
  assertEqual(
    isMonetizationOperationRecoverable((await store.read('legacy')) as never),
    true,
    'a v1 record without a result is recoverable',
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

// 19. Capabilities that cannot be read fail a purchase closed before the store UI opens; a later read is cached.
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
  await h.reconciler.requestPurchase({
    logicalId: 'remove_ads',
    idempotencyKey: 'op-19c',
    source: 'shop',
  });
  assertEqual(reads, 4, 'the successful read is cached');
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
        nativeIap: true,
        nativeAds: false,
        rewardedAds: false,
        interstitialAds: false,
        nativeLeaderboard: false,
        remoteLeaderboard: false,
        achievements: false,
        cloudSave: false,
        socialShare: false,
        haptics: false,
        localizedContent: true,
      };
    },
    identity: {
      async getPlayer() {
        return { playerId: 'player-1' };
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        throw new Error('the v1 commerce adapter must not be used with a v2 provider');
      },
      async getEntitlements() {
        return [];
      },
    },
    commerceV2: provider,
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
    playerId: 'player-1',
    target: 'android',
    analytics: { track: (event) => void events.push(event) },
  });
  const reconciler = client.commerceReconciler;
  if (reconciler === undefined) {
    throw new Error('A gateway with commerceV2 exposes the reconciler.');
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

// 22. createRecoverableMonetizationClient: v2 purchases, reconcile summaries, restore, and the deprecated callback wrapper.
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
  const replayed = await recovery.recoverPurchaseResult('op-22', {
    status: 'completed',
    transactionId: 'tx-22',
    entitlementIds: [],
  });
  assertEqual(
    replayed.status,
    'granted',
    'the deprecated callback wrapper answers from the journal',
  );
  await assertRejects(
    () => recovery.recoverPurchaseResult('missing', { status: 'pending', entitlementIds: [] }),
    /No reserved purchase operation/u,
    'an unknown key',
  );
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

console.info('commerce reconciler tests passed');
