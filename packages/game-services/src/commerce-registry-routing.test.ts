import assert from 'node:assert/strict';

import type { ProductCatalog } from '@mpgd/catalog';
import { commerceProtocolVersion } from '@mpgd/platform/commerce';

import {
  compareCommerceServiceCapabilities,
  createCommerceEvidenceRegistry,
  createCommerceLedgerLookupVerifier,
  createDevvitOrderLookupCommerceEvidenceEntry,
  createDevvitPaymentOrderEvidenceVerifier,
  createGooglePlayCommerceEvidenceEntry,
  createServerPushLedgerGrant,
  createVerse8Agent8EventLookupCommerceEvidenceEntry,
  resolveCommerceStoreId,
  resolveLegacyCommerceStoreId,
  type CommerceEvidenceRegistryEntry,
  type DevvitPaymentOrderAuthorityResult,
} from './commerce-evidence-registry.js';
import type {
  EvidenceVerificationDecision,
  FinalizePurchaseGrantInput,
  GameServicesPurchaseGrantFinalizer,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification.js';
import { createInMemoryGameServicesStore } from './server.js';
import type { VerifyPurchaseRequest } from './types.js';

const product = {
  id: 'COINS_100',
  type: 'consumable',
  grant: { type: 'currency', currency: 'coin', amount: 100 },
  platformProductIds: { android: 'coins_100', reddit: 'coins-100', verse8: 'vx-coins-100' },
} as const satisfies ProductCatalog['products'][number];

const verified = (verificationId: string): EvidenceVerificationDecision => ({
  status: 'verified',
  verificationId,
  verifiedAt: '2026-10-12T00:00:00.000Z',
});

function verifier(label: string, calls: string[]) {
  return {
    async verifyPurchase() {
      calls.push(label);
      return verified(`${label}:verified`);
    },
  };
}

const finalizer: GameServicesPurchaseGrantFinalizer = {
  async finalizePurchaseGrant() {
    return { status: 'completed', action: 'acknowledge', alreadyCompleted: false };
  },
};

function request(patch: Partial<VerifyPurchaseRequest> = {}): VerifyPurchaseRequest {
  return {
    target: 'android',
    playerId: 'player-1',
    productId: 'COINS_100',
    platformTransactionId: 'order-1',
    idempotencyKey: 'key-1',
    purchasedAt: '2026-10-12T00:00:00.000Z',
    ...patch,
  };
}

function verificationInput(
  patch: Partial<VerifyPurchaseRequest> = {},
): VerifyPurchaseEvidenceInput {
  return {
    request: request(patch),
    product,
    platformProductId: 'coins_100',
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  };
}

// Legacy mapping (RFC "Open store ids").
assert.equal(resolveLegacyCommerceStoreId('android'), 'google-play');
assert.equal(resolveLegacyCommerceStoreId('ios'), 'app-store');
assert.equal(resolveLegacyCommerceStoreId('ait'), 'apps-in-toss');
assert.equal(resolveLegacyCommerceStoreId('reddit'), 'devvit');
assert.equal(resolveLegacyCommerceStoreId('microsoft-store'), 'microsoft-store');
assert.equal(resolveLegacyCommerceStoreId('verse8'), 'verse8');
assert.equal(resolveLegacyCommerceStoreId('oneplay'), 'oneplay');
assert.equal(resolveCommerceStoreId({ target: 'android' }), 'google-play');
assert.equal(
  resolveCommerceStoreId({ target: 'browser', store: 'credit-wallet' }),
  'credit-wallet',
);

// Construction rules.
assert.throws(
  () =>
    createCommerceEvidenceRegistry([
      { schema: 'x.v1', store: 'x', verifier: verifier('x', []), finish: 'server' },
    ]),
  /finish: server and needs a finalizer/u,
  'a server-finish entry without a finalizer fails construction',
);
assert.throws(
  () =>
    createCommerceEvidenceRegistry([
      { schema: 'x.v1', store: 'x', verifier: verifier('x', []), finish: 'client' },
      { schema: 'x.v1', store: 'y', verifier: verifier('y', []), finish: 'client' },
    ]),
  /claimed by two registry entries/u,
  'two entries cannot claim one schema',
);
assert.throws(
  () =>
    createCommerceEvidenceRegistry([
      { schema: 'x.v1', store: 'x', verifier: verifier('x', []), finish: 'client' },
      { schema: 'x.v2', store: 'x', verifier: verifier('x', []), finish: 'none' },
    ]),
  /one store has one finish owner/u,
  'one store has one finish owner',
);
assert.throws(
  () =>
    createCommerceEvidenceRegistry([
      {
        schema: 'x.v1',
        store: 'x',
        verifier: verifier('x', []),
        finish: 'client',
        acceptsMissingEvidence: true,
      },
      {
        schema: 'x.v2',
        store: 'x',
        verifier: verifier('x', []),
        finish: 'client',
        acceptsMissingEvidence: true,
      },
    ]),
  /two entries that accept a missing evidence envelope/u,
  'one store has one missing-envelope entry',
);
assert.throws(
  () =>
    createCommerceEvidenceRegistry([
      { schema: 'x.v1', store: 'Not Kebab', verifier: verifier('x', []), finish: 'client' },
    ]),
  /kebab-case store identifier/u,
  'a store id is a bounded kebab-case identifier',
);

// Routing by schema.
const calls: string[] = [];
const registry = createCommerceEvidenceRegistry([
  createGooglePlayCommerceEvidenceEntry({ verifier: verifier('play', calls), finalizer }),
  {
    schema: 'app-store.signed-transaction.v1',
    store: 'app-store',
    verifier: verifier('app-store', calls),
    finish: 'client',
    acceptsMissingEvidence: true,
  },
  {
    schema: 'credit-wallet.spend.v1',
    store: 'credit-wallet',
    verifier: verifier('wallet', calls),
    finish: 'server',
    finalizer,
    purchase: { consumable: true, durable: true, subscription: true },
  },
]);

const playEvidence = {
  schema: 'google-play.product-purchase.v2',
  payload: { purchaseToken: 't' },
};
assert.deepEqual(
  await registry.verifyPurchase(verificationInput({ evidence: playEvidence })),
  verified('play:verified'),
  'a v1 android request routes by schema to the Play entry',
);
assert.deepEqual(
  await registry.verifyPurchase(
    verificationInput({ store: 'google-play', evidence: playEvidence }),
  ),
  verified('play:verified'),
  'a v2 request naming the store routes the same way',
);
assert.deepEqual(
  await registry.verifyPurchase(verificationInput({ store: 'app-store', evidence: playEvidence })),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_STORE_MISMATCH' },
  'a schema registered for another store is rejected before any verifier runs',
);
assert.deepEqual(
  await registry.verifyPurchase(verificationInput({ target: 'ios', evidence: playEvidence })),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_STORE_MISMATCH' },
  'the legacy target mapping is the store for the mismatch check',
);
assert.deepEqual(
  await registry.verifyPurchase(
    verificationInput({ target: 'browser', store: 'google-play', evidence: playEvidence }),
  ),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_TARGET_MISMATCH' },
  'a reference entry accepts only its ledger target',
);
assert.deepEqual(
  await registry.verifyPurchase(
    verificationInput({ evidence: { schema: 'unknown.v1', payload: {} } }),
  ),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' },
  'an unknown schema is rejected',
);
assert.deepEqual(
  await registry.verifyPurchase(
    verificationInput({ target: 'browser', store: 'nowhere', evidence: playEvidence }),
  ),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_STORE_MISMATCH' },
  'a claimed schema under an unknown store is a store mismatch',
);
assert.deepEqual(
  await registry.verifyPurchase(verificationInput()),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' },
  'a missing envelope is rejected for a store without a missing-envelope entry',
);
assert.deepEqual(
  await registry.verifyPurchase(verificationInput({ target: 'ios' })),
  verified('app-store:verified'),
  'a missing envelope routes to the store entry that accepts one',
);
assert.deepEqual(calls, ['play', 'play', 'app-store']);

// Finalization routing: by request schema, by the stored payload schema, by store.
const finalizationInput = (
  patch: Partial<FinalizePurchaseGrantInput>,
): Omit<FinalizePurchaseGrantInput, 'signal'> => ({
  request: request(),
  product,
  platformProductId: 'coins_100',
  evidenceVerificationId: 'play:verified',
  ledgerEntryId: 'ledger-1',
  alreadyProcessed: false,
  timeoutMs: 1_000,
  ...patch,
});
const supports = (patch: Partial<FinalizePurchaseGrantInput>): boolean | undefined =>
  registry.finalizer.supportsPurchaseGrant?.(finalizationInput(patch));
assert.equal(supports({ request: request({ evidence: playEvidence }) }), true);
assert.equal(
  supports({
    evidencePayload: { store: 'google-play', evidenceSchema: 'google-play.product-purchase.v2' },
  }),
  true,
  'an evidence-less retry finalizes through the schema the grant recorded',
);
assert.equal(
  supports({}),
  true,
  'a grant written before payloads carried the schema finalizes through its store entry',
);
assert.equal(
  supports({ request: request({ target: 'ios' }) }),
  false,
  'a client-finish store has nothing to finalize on the server',
);
assert.equal(
  supports({ request: request({ store: 'app-store', evidence: playEvidence }) }),
  true,
  'a grant recorded under another store than its schema stays pending, never reported done',
);
assert.deepEqual(
  await registry.finalizer.finalizePurchaseGrant({
    ...finalizationInput({ request: request({ store: 'app-store', evidence: playEvidence }) }),
    signal: new AbortController().signal,
  }),
  { status: 'pending', alreadyCompleted: false, reason: 'PURCHASE_FINALIZER_STORE_MISMATCH' },
);
const retryEnvelope = { schema: 'app-store.signed-transaction.v1', payload: {} };
const recordedPlay = { store: 'google-play', evidenceSchema: 'google-play.product-purchase.v2' };
assert.equal(
  supports({
    request: request({ target: 'ios', evidence: retryEnvelope }),
    evidencePayload: recordedPlay,
  }),
  true,
  'the schema the grant recorded wins over the retry envelope',
);

// Capabilities endpoint derivation.
assert.deepEqual(registry.getCapabilities(), {
  commerceProtocolVersion,
  stores: [
    {
      store: 'google-play',
      schemas: ['google-play.product-purchase.v2'],
      finish: 'server',
      purchase: { consumable: true, durable: true, subscription: false },
    },
    {
      store: 'app-store',
      schemas: ['app-store.signed-transaction.v1'],
      finish: 'client',
      purchase: { consumable: true, durable: true, subscription: false },
    },
    {
      store: 'credit-wallet',
      schemas: ['credit-wallet.spend.v1'],
      finish: 'server',
      purchase: { consumable: true, durable: true, subscription: true },
    },
  ],
});
assert.notEqual(registry.getCapabilities(), registry.getCapabilities(), 'a fresh object per read');

// The unregistered fallback keeps a deployment's aggregate verifier for
// stores without an entry; a store with an entry never reaches it.
const fallbackCalls: string[] = [];
const withFallback = createCommerceEvidenceRegistry(
  [createGooglePlayCommerceEvidenceEntry({ verifier: verifier('play', fallbackCalls), finalizer })],
  { unregistered: { verifier: verifier('aggregate', fallbackCalls) } },
);
assert.deepEqual(
  await withFallback.verifyPurchase(
    verificationInput({ target: 'ios', evidence: { schema: 'legacy.v1', payload: {} } }),
  ),
  verified('aggregate:verified'),
);
assert.deepEqual(
  await withFallback.verifyPurchase(
    verificationInput({ store: 'app-store', evidence: playEvidence }),
  ),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_STORE_MISMATCH' },
  'a claimed schema never reaches the fallback',
);
assert.deepEqual(
  await withFallback.verifyPurchase(
    verificationInput({ evidence: { schema: 'legacy.v1', payload: {} } }),
  ),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' },
  'a store with its own entry is never served by the fallback',
);
assert.deepEqual(
  await withFallback.verifyPurchase(verificationInput()),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' },
  'nor is its missing envelope',
);
assert.deepEqual(fallbackCalls, ['aggregate']);
assert.equal(withFallback.servesUndeclaredStores, true);
const fallbackStores = withFallback.getCapabilities().stores.map((entry) => entry.store);
assert.deepEqual(fallbackStores, ['google-play']);

// A fallback that declares its stores publishes them and serves only them.
const declared = createCommerceEvidenceRegistry(
  [
    createGooglePlayCommerceEvidenceEntry({
      verifier: verifier('play', fallbackCalls),
      finalizer,
      acceptsUnclaimedSchemas: true,
    }),
  ],
  {
    unregistered: {
      verifier: verifier('aggregate', fallbackCalls),
      stores: [{ store: 'app-store', finish: 'client', targets: ['ios'] }],
    },
  },
);
assert.equal(declared.servesUndeclaredStores, false);
assert.deepEqual([...declared.stores], ['google-play', 'app-store']);
assert.deepEqual(declared.getCapabilities().stores[1], {
  store: 'app-store',
  schemas: [],
  finish: 'client',
  purchase: { consumable: true, durable: true, subscription: false },
});
assert.deepEqual(
  await declared.verifyPurchase(
    verificationInput({ target: 'ios', evidence: { schema: 'legacy.v1', payload: {} } }),
  ),
  verified('aggregate:verified'),
  'a declared fallback store reaches the fallback',
);
assert.deepEqual(
  await declared.verifyPurchase(
    verificationInput({ target: 'ait', evidence: { schema: 'legacy.v1', payload: {} } }),
  ),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' },
  'an undeclared store is rejected',
);
assert.deepEqual(
  await declared.verifyPurchase(
    verificationInput({ target: 'browser', store: 'app-store', evidence: { schema: 'x', payload: {} } }),
  ),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_TARGET_MISMATCH' },
  'a declared fallback store keeps its targets',
);
assert.deepEqual(
  await declared.verifyPurchase(
    verificationInput({ evidence: { schema: 'game.play.v9', payload: {} } }),
  ),
  verified('play:verified'),
  "an entry that accepts unclaimed schemas serves its store's other schemas",
);
const playOnly = [
  createGooglePlayCommerceEvidenceEntry({ verifier: verifier('play', []), finalizer }),
];
const redeclaredPlay = {
  unregistered: {
    verifier: verifier('a', []),
    stores: [{ store: 'google-play', finish: 'server' as const }],
  },
};
assert.throws(
  () => createCommerceEvidenceRegistry(playOnly, redeclaredPlay),
  /one or the other serves it/u,
  'a store cannot be both registered and declared for the fallback',
);
const unclaimedEntry = (schema: string): CommerceEvidenceRegistryEntry => ({
  schema,
  store: 'x',
  verifier: verifier('x', []),
  finish: 'client',
  acceptsUnclaimedSchemas: true,
});
assert.throws(
  () => createCommerceEvidenceRegistry([unclaimedEntry('x.v1'), unclaimedEntry('x.v2')]),
  /two entries that accept unclaimed schemas/u,
);

// Server-push lookups never grant from the envelope.
const ledger = createInMemoryGameServicesStore();
const devvitEntry = createDevvitOrderLookupCommerceEvidenceEntry({ ledger });
const verse8Entry = createVerse8Agent8EventLookupCommerceEvidenceEntry({ ledger });
const lookupRegistry = createCommerceEvidenceRegistry([devvitEntry, verse8Entry]);
const devvitOrder = (orderId: string, sku = 'coins-100') => ({
  schema: 'devvit.order.v1',
  payload: { orderId, sku, source: 'checkout' },
});
const devvitInput = (
  patch: Partial<VerifyPurchaseRequest> = {},
): VerifyPurchaseEvidenceInput => ({
  ...verificationInput({
    target: 'reddit',
    store: 'devvit',
    platformTransactionId: 'order-1',
    evidence: devvitOrder('order-1'),
    ...patch,
  }),
  platformProductId: 'coins-100',
});

assert.deepEqual(
  await lookupRegistry.verifyPurchase(devvitInput()),
  { status: 'pending', reason: 'LEDGER_GRANT_PENDING' },
  'no fulfillment ledger entry yet: pending, never granted from the client envelope',
);
assert.deepEqual(
  await lookupRegistry.verifyPurchase(devvitInput({ platformTransactionId: 'order-2' })),
  { status: 'rejected', reason: 'PLATFORM_TRANSACTION_ID_MISMATCH' },
);
assert.deepEqual(
  await lookupRegistry.verifyPurchase(
    devvitInput({ evidence: devvitOrder('order-1', 'other-sku') }),
  ),
  { status: 'rejected', reason: 'PLATFORM_PRODUCT_MISMATCH' },
);
assert.deepEqual(
  await lookupRegistry.verifyPurchase(
    devvitInput({ evidence: { schema: 'devvit.order.v1', payload: { sku: 'coins-100' } } }),
  ),
  { status: 'rejected', reason: 'EVIDENCE_PAYLOAD_INVALID' },
);

const fulfillment = createServerPushLedgerGrant({
  store: 'devvit',
  target: 'reddit',
  playerId: 'player-1',
  product,
  platformProductId: 'coins-100',
  transactionId: 'order-1',
  purchasedAt: '2026-10-12T00:00:00.000Z',
  grantedAt: '2026-10-12T00:00:01.000Z',
  evidence: { schema: 'devvit.payment-order.v1', payload: { orderId: 'order-1', status: 'PAID' } },
  idempotencyKey: 'reddit:order-1',
});
assert.equal(fulfillment.payload.platformTransactionId, 'order-1');
assert.equal(fulfillment.payload.store, 'devvit');
assert.equal(fulfillment.evidenceVerificationId, 'devvit:devvit.payment-order.v1:order-1');
const recorded = await ledger.recordEntitlementGrant(fulfillment);
assert.deepEqual(
  await lookupRegistry.verifyPurchase(devvitInput()),
  { status: 'settled', ledgerEntryId: recorded.ledgerEntryId },
  'the fulfillment entry settles the client envelope',
);
assert.deepEqual(
  await lookupRegistry.verifyPurchase(devvitInput({ playerId: 'player-2' })),
  { status: 'rejected', reason: 'LEDGER_GRANT_PLAYER_MISMATCH' },
  'another player cannot claim the order',
);
assert.deepEqual(await lookupRegistry.verifyPurchase(devvitInput({ productId: 'OTHER' })), {
  status: 'rejected',
  reason: 'LEDGER_GRANT_PRODUCT_MISMATCH',
});
assert.deepEqual(
  await lookupRegistry.verifyPurchase(devvitInput({ target: 'browser' })),
  { status: 'rejected', reason: 'EVIDENCE_SCHEMA_TARGET_MISMATCH' },
  'the Devvit entry accepts only the reddit ledger target',
);
const pinnedLookup = createCommerceEvidenceRegistry([
  createDevvitOrderLookupCommerceEvidenceEntry({
    ledger,
    ledgerTarget: 'reddit',
    targets: ['reddit', 'browser'],
  }),
]);
assert.deepEqual(
  await pinnedLookup.verifyPurchase(devvitInput({ target: 'browser' })),
  { status: 'settled', ledgerEntryId: recorded.ledgerEntryId, ledgerTarget: 'reddit' },
  'a pinned ledger target is read under that target and reported with the entry',
);
await ledger.recordEntitlementRevocation({
  playerId: 'player-1',
  revokesLedgerEntryId: recorded.ledgerEntryId,
  idempotencyKey: 'reddit:order-1:refund',
  reason: 'refund',
  revokedAt: '2026-10-12T01:00:00.000Z',
  payload: {},
});
assert.deepEqual(
  await lookupRegistry.verifyPurchase(devvitInput()),
  { status: 'rejected', reason: 'LEDGER_GRANT_REVERSED' },
  'a reversed fulfillment no longer settles',
);

// Verse8: the Agent8 event's ledger grant under target verse8.
const verse8Ledger = createInMemoryGameServicesStore();
const verse8Lookup = createCommerceLedgerLookupVerifier({
  schema: 'verse8.agent8-event.v1',
  store: 'verse8',
  ledger: verse8Ledger,
  readTransactionId: (payload) =>
    typeof payload.purchaseId === 'string' ? payload.purchaseId : undefined,
});
const verse8Evidence = {
  schema: 'verse8.agent8-event.v1',
  payload: { purchaseId: '42', productId: 'vx-coins-100', quantity: 1 },
};
const verse8Input = (): VerifyPurchaseEvidenceInput => ({
  ...verificationInput({
    target: 'verse8',
    store: 'verse8',
    platformTransactionId: '42',
    evidence: verse8Evidence,
  }),
  platformProductId: 'vx-coins-100',
});
assert.equal((await verse8Lookup.verifyPurchase(verse8Input())).status, 'pending');
const agent8Input = {
  store: 'verse8',
  target: 'verse8',
  playerId: 'player-1',
  product,
  platformProductId: 'vx-coins-100',
  transactionId: '42',
  purchasedAt: '2026-10-12T00:00:00.000Z',
  grantedAt: '2026-10-12T00:00:00.000Z',
  evidence: verse8Evidence,
};
const agent8Grant = createServerPushLedgerGrant(agent8Input);
const agent8 = await verse8Ledger.recordEntitlementGrant(agent8Grant);
assert.deepEqual(await verse8Lookup.verifyPurchase(verse8Input()), {
  status: 'settled',
  ledgerEntryId: agent8.ledgerEntryId,
});
assert.equal(
  (await verse8Ledger.getEntitlementTransaction(agent8.ledgerEntryId))?.idempotencyKey,
  'store:verse8:42',
  'the default server-push key is the reconciler derived key',
);
const threeUnits = createServerPushLedgerGrant({ ...agent8Input, quantity: 3 });
assert.deepEqual(threeUnits.grant, { type: 'currency', currency: 'coin', amount: 300 });
assert.equal(threeUnits.payload.quantity, 3);
assert.equal(agent8Grant.payload.quantity, 1);
assert.throws(
  () => createServerPushLedgerGrant({ ...agent8Input, quantity: 0 }),
  /positive integer/u,
);

// devvit.payment-order.v1: the fulfillment handler's own record, bound through the authority.
const authorityCalls: string[] = [];
const paidOrder = (playerId: string, status: string) => ({
  orderId: 'order-7',
  playerId,
  sku: 'coins-100',
  status,
  occurredAt: '2026-10-12T00:00:00.000Z',
});
let authorityAnswer: DevvitPaymentOrderAuthorityResult = {
  decision: 'resolved',
  order: paidOrder('player-1', 'PAID'),
};
const paymentOrder = createDevvitPaymentOrderEvidenceVerifier({
  authority: {
    async getOrder(input) {
      authorityCalls.push(`${input.orderId}:${input.playerId}:${input.platformSku}`);
      return authorityAnswer;
    },
  },
  now: () => '2026-10-12T00:00:02.000Z',
});
const paymentOrderInput = (
  patch: Partial<VerifyPurchaseRequest> = {},
): VerifyPurchaseEvidenceInput => ({
  ...verificationInput({
    target: 'reddit',
    store: 'devvit',
    platformTransactionId: 'order-7',
    idempotencyKey: 'reddit:order-7',
    evidence: {
      schema: 'devvit.payment-order.v1',
      payload: {
        orderId: 'order-7',
        status: 'PAID',
        occurredAt: '2026-10-12T00:00:00.000Z',
        playerIdSource: 'devvit-context',
      },
    },
    ...patch,
  }),
  platformProductId: 'coins-100',
});
assert.deepEqual(await paymentOrder.verifyPurchase(paymentOrderInput()), {
  status: 'verified',
  verificationId: 'devvit:payment-order:order-7',
  verifiedAt: '2026-10-12T00:00:02.000Z',
  platformEvidenceId: 'order-7',
  payload: {
    devvitOrderId: 'order-7',
    devvitOrderStatus: 'PAID',
    devvitOrderOccurredAt: '2026-10-12T00:00:00.000Z',
  },
});
assert.deepEqual(authorityCalls, ['order-7:player-1:coins-100']);
authorityAnswer = { decision: 'resolved', order: paidOrder('player-2', 'PAID') };
assert.deepEqual(await paymentOrder.verifyPurchase(paymentOrderInput()), {
  status: 'rejected',
  reason: 'DEVVIT_ORDER_PLAYER_MISMATCH',
});
authorityAnswer = { decision: 'resolved', order: paidOrder('player-1', 'REVERTED') };
assert.deepEqual(await paymentOrder.verifyPurchase(paymentOrderInput()), {
  status: 'rejected',
  reason: 'DEVVIT_ORDER_REVERTED',
});
authorityAnswer = { decision: 'pending' };
assert.deepEqual(await paymentOrder.verifyPurchase(paymentOrderInput()), { status: 'pending' });
assert.deepEqual(
  await paymentOrder.verifyPurchase(paymentOrderInput({ platformTransactionId: 'order-8' })),
  { status: 'rejected', reason: 'DEVVIT_ORDER_ID_MISMATCH' },
  'the envelope must name the request transaction',
);
assert.deepEqual(
  await paymentOrder.verifyPurchase(paymentOrderInput({
    evidence: {
      schema: 'devvit.payment-order.v1',
      payload: { orderId: 'order-7', status: 'REVERTED' },
    },
  })),
  { status: 'rejected', reason: 'DEVVIT_ORDER_NOT_PAID' },
);

// Client-side comparison (RFC "Provider capabilities endpoint").
const service = registry.getCapabilities();
const providerBlock = (finish: 'client' | 'server' | 'host' | 'none') => ({
  lifecycle: { availablePurchases: true, pending: true, restore: true, events: true, finish },
});
const compare = (
  store: string,
  finish: 'client' | 'server' | 'host' | 'none',
  published = service,
) =>
  compareCommerceServiceCapabilities({
    store,
    provider: providerBlock(finish),
    service: published,
  });
const reasonOf = (alignment: ReturnType<typeof compare>) =>
  alignment.status === 'configuration-required' ? alignment.reason : alignment.status;
assert.deepEqual(compare('google-play', 'server'), { status: 'aligned', store: 'google-play' });
assert.equal(reasonOf(compare('google-play', 'client')), 'FINISH_OWNER_MISMATCH');
assert.equal(reasonOf(compare('devvit', 'none')), 'STORE_NOT_ACCEPTED');
assert.equal(
  reasonOf(compare('google-play', 'server', { ...service, commerceProtocolVersion: '3.0.0' })),
  'PROTOCOL_VERSION_MISMATCH',
);

// Entries are frozen copies: a later mutation of the input does not reach the registry.
const mutable: CommerceEvidenceRegistryEntry = {
  schema: 'm.v1',
  store: 'm',
  verifier: verifier('m', []),
  finish: 'client',
};
const frozenRegistry = createCommerceEvidenceRegistry([mutable]);
assert.equal(Object.isFrozen(frozenRegistry.entries[0]), true);

console.log('commerce evidence registry routing tests passed');
