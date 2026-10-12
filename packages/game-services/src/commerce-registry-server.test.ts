import assert from 'node:assert/strict';

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import { commerceProtocolVersion } from '@mpgd/platform/commerce';

import { createGameServicesHttpBackendApi, gameServicesBackendEndpoints } from './client.js';
import {
  createCommerceEvidenceRegistry,
  createDevvitOrderLookupCommerceEvidenceEntry,
  createGooglePlayCommerceEvidenceEntry,
  createVerse8Agent8EventLookupCommerceEvidenceEntry,
  type CommerceEvidenceRegistryEntry,
} from './commerce-evidence-registry.js';
import type {
  EvidenceVerificationDecision,
  GameServicesEvidenceVerifier,
  GameServicesPurchaseGrantFinalizer,
} from './evidence-verification.js';
import {
  createGameServicesBackend,
  createGameServicesBackendApiHandler,
  createGameServicesHttpFetchHandler,
  createGameServicesRouter,
  createGameServicesRpcFetchHandler,
  createInMemoryGameServicesStore,
  createInProcessGameServicesBackendTransport,
} from './server.js';
import { createPlatformOrderLedgerGrant } from './platform-order.js';
import type { VerifyPurchaseRequest, VerifyPurchaseResponse } from './types.js';

const catalog = {
  version: 'registry-test',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: {
        android: 'coins_100',
        ios: 'com.example.coins100',
        reddit: 'coins-100',
        verse8: 'vx-coins-100',
      },
    },
    {
      id: 'THEME_EMBER',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'theme.ember' },
      platformProductIds: { android: 'theme_ember', reddit: 'theme-ember' },
    },
  ],
} as const satisfies ProductCatalog;
const placements = { version: 'registry-test', placements: [] } as const satisfies AdPlacements;

const verifiedAt = '2026-10-12T00:00:00.000Z';
const verified = (verificationId: string): EvidenceVerificationDecision => ({
  status: 'verified',
  verificationId,
  verifiedAt,
});
const playVerifierCalls: string[] = [];
const playFinalizerCalls: string[] = [];
const playVerifier: Pick<GameServicesEvidenceVerifier, 'verifyPurchase'> = {
  async verifyPurchase({ request }) {
    playVerifierCalls.push(request.idempotencyKey);
    return verified(`play:${request.platformTransactionId}`);
  },
};
const playFinalizer: GameServicesPurchaseGrantFinalizer = {
  supportsPurchaseGrant(input) {
    return input.product.type !== 'subscription';
  },
  async finalizePurchaseGrant(input) {
    playFinalizerCalls.push(`${input.ledgerEntryId}:${input.request.evidence?.schema ?? 'none'}`);
    return {
      status: 'completed',
      action: input.product.type === 'consumable' ? 'consume' : 'acknowledge',
      alreadyCompleted: false,
    };
  },
};
const adRewardVerifier: GameServicesEvidenceVerifier = {
  async verifyPurchase() {
    throw new Error('the registry owns purchase verification');
  },
  async verifyAdReward() {
    return { status: 'rejected', reason: 'NOT_TESTED' };
  },
};

const store = createInMemoryGameServicesStore();
const registry = createCommerceEvidenceRegistry([
  createGooglePlayCommerceEvidenceEntry({ verifier: playVerifier, finalizer: playFinalizer }),
  createDevvitOrderLookupCommerceEvidenceEntry({ ledger: store }),
  createVerse8Agent8EventLookupCommerceEvidenceEntry({ ledger: store }),
]);
const backend = createGameServicesBackend({
  catalog,
  placements,
  store,
  commerceEvidenceRegistry: registry,
  evidenceVerifier: adRewardVerifier,
  now: () => verifiedAt,
});

const playRequest = (patch: Partial<VerifyPurchaseRequest> = {}): VerifyPurchaseRequest => ({
  target: 'android',
  playerId: 'player-1',
  productId: 'COINS_100',
  platformTransactionId: 'GPA.1',
  idempotencyKey: 'play-token-sha256:abc',
  purchasedAt: verifiedAt,
  evidence: { schema: 'google-play.product-purchase.v2', payload: { purchaseToken: 'token' } },
  ...patch,
});

// A v1 request without `store` maps android to google-play and routes by schema.
const v1 = await backend.purchases.verifyPurchase(playRequest());
assert.equal(v1.verified, true);
assert.equal(v1.finalization?.status, 'completed');
assert.equal(v1.finalization?.action, 'consume');
const v1Grant = await store.getEntitlementTransaction(v1.ledgerEntryId ?? '');
assert.equal(v1Grant?.payload.store, 'google-play', 'the grant records the resolved store');
assert.equal(v1Grant?.payload.evidenceSchema, 'google-play.product-purchase.v2');
assert.deepEqual(playVerifierCalls, ['play-token-sha256:abc']);

// The reconciler's v2 request names the store and the same ledger target.
const v2 = await backend.purchases.verifyPurchase(playRequest({ store: 'google-play' }));
assert.equal(v2.verified, true);
assert.equal(v2.alreadyProcessed, true, 'same key, same grant');
assert.equal(v2.ledgerEntryId, v1.ledgerEntryId);
assert.equal(playVerifierCalls.length, 1, 'a replay never re-verifies');

// An evidence-less retry finalizes through the schema the grant recorded.
const { evidence: _playEvidence, ...evidenceLessRetry } = playRequest();
const retry = await backend.purchases.verifyPurchase(evidenceLessRetry);
assert.equal(retry.verified, true);
assert.equal(retry.finalization?.status, 'completed');
assert.deepEqual(playFinalizerCalls, [
  `${String(v1.ledgerEntryId)}:google-play.product-purchase.v2`,
  `${String(v1.ledgerEntryId)}:google-play.product-purchase.v2`,
  `${String(v1.ledgerEntryId)}:none`,
]);

// Schema and store mismatches are rejected before any verifier runs.
const mismatch = await backend.purchases.verifyPurchase(
  playRequest({
    target: 'reddit',
    store: 'devvit',
    idempotencyKey: 'play-mismatch',
    platformTransactionId: 'GPA.2',
  }),
);
assert.deepEqual(mismatch, {
  verified: false,
  alreadyProcessed: false,
  disposition: 'rejected',
  reason: 'EVIDENCE_SCHEMA_STORE_MISMATCH',
});
const unsupported = await backend.purchases.verifyPurchase(
  playRequest({
    idempotencyKey: 'play-unknown',
    platformTransactionId: 'GPA.3',
    evidence: { schema: 'unknown.v1', payload: {} },
  }),
);
assert.equal(unsupported.reason, 'EVIDENCE_SCHEMA_UNSUPPORTED');
assert.equal(playVerifierCalls.length, 1);

// The store id is validated like the target, and an unserved store or an
// unknown target stays a 400 as it was in v1.
await assert.rejects(
  backend.purchases.verifyPurchase(playRequest({ store: 'Google Play' })),
  /store must be a lowercase kebab-case store identifier/u,
);
await assert.rejects(
  backend.purchases.verifyPurchase(playRequest({ target: 'Android' })),
  /target must be a lowercase kebab-case store identifier/u,
);
await assert.rejects(
  backend.purchases.verifyPurchase(playRequest({ store: 'credit-wallet' })),
  /store credit-wallet is not a store this backend serves/u,
);
await assert.rejects(
  backend.purchases.verifyPurchase(playRequest({ target: 'smart-fridge', store: 'google-play' })),
  /target smart-fridge is not a ledger target this backend serves/u,
);
// A registry next to the v1 finalizer is a configuration error, not a silent loss.
assert.throws(
  () =>
    createGameServicesBackend({
      catalog,
      placements,
      store,
      commerceEvidenceRegistry: registry,
      purchaseGrantFinalizer: playFinalizer,
    }),
  /unregistered.finalizer/u,
);

// Capabilities derive from the registry.
const capabilities = await backend.purchases.getCommerceCapabilities?.();
assert.deepEqual(capabilities, {
  commerceProtocolVersion,
  stores: [
    {
      store: 'google-play',
      schemas: ['google-play.product-purchase.v2'],
      finish: 'server',
      purchase: { consumable: true, durable: true, subscription: false },
    },
    {
      store: 'devvit',
      schemas: ['devvit.order.v1'],
      finish: 'none',
      purchase: { consumable: true, durable: true, subscription: false },
    },
    {
      store: 'verse8',
      schemas: ['verse8.agent8-event.v1'],
      finish: 'none',
      purchase: { consumable: true, durable: true, subscription: false },
    },
  ],
});

// Server-push: the client envelope answers pending until the fulfillment path wrote the grant.
const devvitOrderEvidence = (sku: string) => ({
  schema: 'devvit.order.v1',
  payload: { orderId: 'order-1', sku, source: 'checkout' },
});
const devvitRequest = (patch: Partial<VerifyPurchaseRequest> = {}): VerifyPurchaseRequest => ({
  target: 'reddit',
  store: 'devvit',
  playerId: 'reddit-player',
  productId: 'COINS_100',
  platformTransactionId: 'order-1',
  idempotencyKey: 'store:devvit:order-1',
  purchasedAt: verifiedAt,
  evidence: devvitOrderEvidence('coins-100'),
  ...patch,
});
const beforeFulfillment = await backend.purchases.verifyPurchase(devvitRequest());
assert.deepEqual(beforeFulfillment, {
  verified: false,
  alreadyProcessed: false,
  disposition: 'pending',
  reason: 'LEDGER_GRANT_PENDING',
});
assert.equal((await store.listEntitlementTransactions()).length, 1, 'nothing was granted');

const fulfillment = await store.recordEntitlementGrant(
  createPlatformOrderLedgerGrant({
    order: {
      target: 'reddit',
      orderId: 'order-1',
      playerId: 'reddit-player',
      platformSku: 'coins-100',
      paidAt: verifiedAt,
      evidence: {
        schema: 'devvit.payment-order.v1',
        payload: { orderId: 'order-1', status: 'PAID' },
      },
    },
    product: catalog.products[0],
    grantedAt: verifiedAt,
  }),
);
assert.equal(fulfillment.alreadyProcessed, false);
const afterFulfillment = await backend.purchases.verifyPurchase(devvitRequest());
assert.deepEqual(afterFulfillment, {
  verified: true,
  ledgerEntryId: fulfillment.ledgerEntryId,
  alreadyProcessed: true,
});
assert.equal((await store.listEntitlementTransactions()).length, 2, 'the lookup wrote nothing');
const otherPlayer = await backend.purchases.verifyPurchase(
  devvitRequest({ playerId: 'thief', idempotencyKey: 'store:devvit:order-1:thief' }),
);
assert.equal(otherPlayer.verified, false);
assert.equal(otherPlayer.reason, 'LEDGER_GRANT_PLAYER_MISMATCH');
const otherProduct = await backend.purchases.verifyPurchase(
  devvitRequest({ productId: 'THEME_EMBER', evidence: devvitOrderEvidence('theme-ember') }),
);
assert.equal(otherProduct.reason, 'LEDGER_GRANT_PRODUCT_MISMATCH');

// A settled entry that does not belong to the request is refused even when a
// verifier vouches for it.
const forgedRegistry = createCommerceEvidenceRegistry([
  {
    schema: 'forged.v1',
    store: 'devvit',
    finish: 'none',
    verifier: {
      async verifyPurchase() {
        return { status: 'settled', ledgerEntryId: fulfillment.ledgerEntryId };
      },
    },
  } satisfies CommerceEvidenceRegistryEntry,
]);
const forgedBackend = createGameServicesBackend({
  catalog,
  placements,
  store,
  commerceEvidenceRegistry: forgedRegistry,
});
const forged = await forgedBackend.purchases.verifyPurchase(
  devvitRequest({
    playerId: 'thief',
    idempotencyKey: 'forged',
    evidence: { schema: 'forged.v1', payload: {} },
  }),
);
assert.deepEqual(forged, {
  verified: false,
  alreadyProcessed: false,
  disposition: 'rejected',
  reason: 'LEDGER_GRANT_IDENTITY_MISMATCH',
});

// Ledger status: one answer per requested id in request order, active until
// a revoke entry references the grant, and scoped to the player when named.
const status = await backend.purchases.getPurchaseLedgerStatus?.({
  ledgerEntryIds: [fulfillment.ledgerEntryId, 'missing', fulfillment.ledgerEntryId],
});
assert.deepEqual(status, {
  statuses: [
    { ledgerEntryId: fulfillment.ledgerEntryId, status: 'active' },
    { ledgerEntryId: 'missing', status: 'unknown' },
    { ledgerEntryId: fulfillment.ledgerEntryId, status: 'active' },
  ],
});
assert.deepEqual(
  await backend.purchases.getPurchaseLedgerStatus?.({
    ledgerEntryIds: [fulfillment.ledgerEntryId],
    playerId: 'someone-else',
  }),
  { statuses: [{ ledgerEntryId: fulfillment.ledgerEntryId, status: 'unknown' }] },
  'another player cannot read the entry',
);
const readStatus = backend.purchases.getPurchaseLedgerStatus;
assert.notEqual(readStatus, undefined);
await assert.rejects(
  readStatus?.call(backend.purchases, { ledgerEntryIds: [''] }) ?? Promise.reject(new Error('')),
  /ledgerEntryIds\[\] must be a non-empty string/u,
);

// Without a registry the v1 path is unchanged: one verifier, one finalizer, no capabilities.
const v1Store = createInMemoryGameServicesStore();
const v1Backend = createGameServicesBackend({
  catalog,
  placements,
  store: v1Store,
  evidenceVerifier: { ...adRewardVerifier, verifyPurchase: playVerifier.verifyPurchase },
  purchaseGrantFinalizer: playFinalizer,
  now: () => verifiedAt,
});
assert.equal(v1Backend.purchases.getCommerceCapabilities, undefined);
const v1Only = await v1Backend.purchases.verifyPurchase(
  playRequest({ platformTransactionId: 'GPA.9' }),
);
assert.equal(v1Only.verified, true);
assert.equal(v1Only.finalization?.action, 'consume');
const v1Reddit = await v1Backend.purchases.verifyPurchase(
  devvitRequest({ platformTransactionId: 'order-9' }),
);
assert.equal(v1Reddit.verified, true, 'a ledger target reaches the single v1 verifier');
await assert.rejects(
  v1Backend.purchases.verifyPurchase(devvitRequest({ target: 'smart-fridge' })),
  /not a ledger target this backend serves/u,
  'a v1 backend keeps answering 400 for an unknown target',
);
assert.equal(
  (await v1Store.getEntitlementTransaction(v1Reddit.ledgerEntryId ?? ''))?.payload.store,
  'devvit',
);

// HTTP and oRPC transports expose the two reads.
const apiHandler = createGameServicesBackendApiHandler({
  catalog,
  placements,
  store,
  commerceEvidenceRegistry: registry,
  now: () => verifiedAt,
});
const httpApi = createGameServicesHttpBackendApi({
  transport: createInProcessGameServicesBackendTransport(apiHandler),
});
assert.deepEqual(await httpApi.purchases.getCommerceCapabilities?.(), capabilities);
assert.deepEqual(
  await httpApi.purchases.getPurchaseLedgerStatus?.({
    ledgerEntryIds: [fulfillment.ledgerEntryId],
  }),
  { statuses: [{ ledgerEntryId: fulfillment.ledgerEntryId, status: 'active' }] },
);
const fetchHandler = createGameServicesHttpFetchHandler(apiHandler);
const capabilitiesResponse = await fetchHandler(
  new Request(`https://backend.test${gameServicesBackendEndpoints.getCommerceCapabilities}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }),
);
assert.equal(capabilitiesResponse.status, 200);
assert.deepEqual(await capabilitiesResponse.json(), capabilities);
const v1ApiHandler = createGameServicesBackendApiHandler({ catalog, placements, store: v1Store });
const noCapabilities = await createGameServicesHttpFetchHandler(v1ApiHandler)(
  new Request(`https://backend.test${gameServicesBackendEndpoints.getCommerceCapabilities}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }),
);
assert.equal(noCapabilities.status, 404, 'a v1 backend has no capabilities endpoint');

const rpcFetch = createGameServicesRpcFetchHandler(createGameServicesRouter(backend));
const rpcStatus = await rpcFetch(
  new Request('https://backend.test/rpc/commerce/getPurchaseLedgerStatus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: { ledgerEntryIds: [fulfillment.ledgerEntryId] } }),
  }),
);
assert.equal(rpcStatus.status, 200);
const rpcStatusBody = await rpcStatus.json() as { readonly json: unknown };
assert.deepEqual(rpcStatusBody.json, {
  statuses: [{ ledgerEntryId: fulfillment.ledgerEntryId, status: 'active' }],
});
const rpcCapabilities = await rpcFetch(
  new Request('https://backend.test/rpc/commerce/getCapabilities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: undefined }),
  }),
);
assert.equal(rpcCapabilities.status, 200);
const rpcCapabilitiesBody = await rpcCapabilities.json() as { readonly json: unknown };
assert.deepEqual(rpcCapabilitiesBody.json, capabilities);
const rpcNoCapabilities = await createGameServicesRpcFetchHandler(
  createGameServicesRouter(v1Backend),
)(
  new Request('https://backend.test/rpc/commerce/getCapabilities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: undefined }),
  }),
);
assert.equal(rpcNoCapabilities.status, 404);

// The registry rejects a rewarded-ad verifier that answers settled.
const settledAds = createGameServicesBackend({
  catalog,
  placements: {
    version: 'ads',
    placements: [
      {
        id: 'CONTINUE',
        type: 'rewarded',
        reward: { type: 'currency', currency: 'coin', amount: 5 },
        frequencyCap: { cooldownSeconds: 0 },
        platformPlacementIds: { android: 'continue' },
      },
    ],
  },
  evidenceVerifier: {
    ...adRewardVerifier,
    async verifyAdReward() {
      return { status: 'settled', ledgerEntryId: fulfillment.ledgerEntryId };
    },
  },
});
const settledAd = await settledAds.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-1',
  placementId: 'CONTINUE',
  idempotencyKey: 'ad-1',
  completedAt: verifiedAt,
});
assert.equal(settledAd.granted, false);
assert.equal(settledAd.reason, 'EVIDENCE_VERIFIER_ERROR');

const responses: VerifyPurchaseResponse[] = [v1, v2, retry, afterFulfillment];
assert.equal(
  responses.every((response) => response.verified),
  true,
);

console.log('commerce evidence registry server tests passed');
