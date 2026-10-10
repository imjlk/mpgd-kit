import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { ProductCatalog } from '@mpgd/catalog';
import { createGameServicesBackend, createInMemoryGameServicesStore } from './server.js';
import {
  createOnePlayPurchaseClient,
  type OnePlayPurchaseClient,
} from './oneplay-purchase-client.js';
import {
  createOnePlayCheckoutIntentIssuer,
  createOnePlayPurchaseBoundary,
  onePlayManagedPurchaseEvidenceSchema,
  type OnePlayCheckoutIntent,
  type OnePlayCheckoutIntentStore,
} from './oneplay-purchase.js';
import { createOnePlayPnsReceiver, verifyOnePlayPns } from './oneplay-pns.js';

const at = 1_900_000_000_000;
const catalog: ProductCatalog = {
  version: 'test',
  products: [
    {
      id: 'COINS',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: { oneplay: 'coins-sku' },
    },
    {
      id: 'THEME',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'theme' },
      platformProductIds: { oneplay: 'theme-sku' },
    },
    {
      id: 'SUB',
      type: 'subscription',
      grant: { type: 'entitlement', entitlement: 'sub' },
      platformProductIds: { oneplay: 'sub-sku' },
    },
  ],
};
class Intents implements OnePlayCheckoutIntentStore {
  readonly rows: OnePlayCheckoutIntent[] = [];
  async issue(intent: OnePlayCheckoutIntent) {
    const previous = this.rows.find(
      (row) => row.clientId === intent.clientId && row.environment === intent.environment && row.marketCode === intent.marketCode && row.deploymentTarget === intent.deploymentTarget && row.playerId === intent.playerId && row.idempotencyKey === intent.idempotencyKey,
    );
    if (previous !== undefined) {
      return previous;
    }
    if (this.rows.some(
      (row) => row.clientId === intent.clientId && row.environment === intent.environment && row.marketCode === intent.marketCode && row.developerPayload === intent.developerPayload,
    )) {
      throw new Error('Payload collision');
    }
    this.rows.push(intent);
    return intent;
  }
  async findByPayload(input: Parameters<OnePlayCheckoutIntentStore['findByPayload']>[0]) {
    return this.rows.find(
      (row) => row.clientId === input.clientId && row.environment === input.environment && row.marketCode === input.marketCode && row.developerPayload === input.developerPayload,
    );
  }
}
const store = new Intents();
const ledger = createInMemoryGameServicesStore();
const calls: string[] = [];
let failConsume = true;
let state = {
  consumptionState: 0,
  developerPayload: 'payload-1',
  purchaseState: 0,
  purchaseTime: at + 1000,
  purchaseId: 'purchase-1',
  acknowledgeState: 0,
  quantity: 1,
};
const client: OnePlayPurchaseClient = {
  clientId: 'client',
  environment: 'SANDBOX',
  marketCode: 'MKT_ONE',
  async getPurchaseDetails() {
    calls.push('query');
    return { ...state };
  },
  async consumePurchase(input) {
    assert.equal(
      (await ledger.listEntitlementTransactions()).length,
      1,
      'ledger must commit before consume',
    );
    assert.equal(input.developerPayload, state.developerPayload);
    calls.push('consume');
    if (failConsume) {
      throw new Error('Transient API outage');
    }
    state = { ...state, consumptionState: 1, acknowledgeState: 1 };
  },
  async acknowledgePurchase() {
    calls.push('acknowledge');
    state = { ...state, acknowledgeState: 1 };
  },
};
let nonce = 0;
const issuer = createOnePlayCheckoutIntentIssuer({
  client,
  catalog,
  store,
  now: () => at,
  createPayload: () => `payload-${++nonce}`,
});
const issued = await issuer.issue({
  playerId: 'server-player',
  productId: 'COINS',
  idempotencyKey: 'checkout',
});
assert.equal(
  (await issuer.issue({ playerId: 'server-player', productId: 'COINS', idempotencyKey: 'checkout' })).developerPayload,
  issued.developerPayload,
);
await assert.rejects(
  () => issuer.issue({ playerId: 'server-player', productId: 'THEME', idempotencyKey: 'checkout' }),
  /conflict/u,
);
await assert.rejects(
  () => issuer.issue({ playerId: 'server-player', productId: 'SUB', idempotencyKey: 'sub' }),
  /managed/u,
);
const boundary = createOnePlayPurchaseBoundary({ client, store, now: () => at + 2000 });
const backend = createGameServicesBackend({
  catalog,
  placements: { version: 'test', placements: [] },
  store: ledger,
  evidenceVerifier: {
    verifyPurchase: boundary.verifyPurchase,
    verifyAdReward: async () => ({ status: 'rejected', reason: 'unsupported' }),
  },
  purchaseGrantFinalizer: boundary,
});
const request = {
  target: 'oneplay' as const,
  playerId: 'server-player',
  productId: 'COINS',
  platformTransactionId: 'purchase-1',
  idempotencyKey: 'checkout',
  purchasedAt: new Date(at).toISOString(),
  evidence: {
    schema: onePlayManagedPurchaseEvidenceSchema,
    payload: {
      purchaseToken: 'token-1',
      purchaseId: 'purchase-1',
      productId: 'coins-sku',
      developerPayload: issued.developerPayload,
    },
  },
};
const verify = {
  request,
  product: catalog.products[0]!,
  platformProductId: 'coins-sku',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};
assert.equal((await boundary.verifyPurchase(verify)).status, 'verified');
assert.equal(
  (await createOnePlayPurchaseBoundary({ client: { ...client, environment: 'COMMERCIAL' }, store, now: () => at + 2000 }).verifyPurchase(verify)).status,
  'rejected',
);
for (const alteration of [
  { playerId: 'other-player' },
  { idempotencyKey: 'other-checkout' },
  { productId: 'THEME' },
  { platformTransactionId: 'forged-order' },
  { deploymentTarget: 'other' },
]) {
  assert.equal(
    (await boundary.verifyPurchase({ ...verify, request: { ...request, ...alteration } })).status,
    'rejected',
  );
}
for (const alteration of [
  { developerPayload: 'unissued' },
  { quantity: 2 },
  { purchaseState: 1 },
  { consumptionState: 1 },
  { purchaseTime: at - 300_001 },
  { purchaseTime: at + 90_000_000 },
]) {
  const previous = state;
  state = { ...state, ...alteration };
  assert.equal((await boundary.verifyPurchase(verify)).status, 'rejected');
  state = previous;
}
const beforeClockTest = state;
state = { ...state, purchaseTime: at - 1 };
assert.equal((await boundary.verifyPurchase(verify)).status, 'verified');
state = beforeClockTest;
assert.equal((await ledger.listEntitlementTransactions()).length, 0);
const first = await backend.purchases.verifyPurchase(request);
assert.equal(first.verified, true);
assert.equal(first.finalization?.status, 'pending');
assert.equal((await ledger.listEntitlementTransactions()).length, 1);
failConsume = false;
const retry = await backend.purchases.verifyPurchase(request);
assert.equal(retry.alreadyProcessed, true);
assert.equal(retry.finalization?.status, 'completed');
assert.equal(retry.finalization?.action, 'consume');
assert.equal(
  (await backend.purchases.verifyPurchase(request)).finalization?.alreadyCompleted,
  true,
);
assert.equal((await ledger.listEntitlementTransactions()).length, 1);
assert.equal(calls.filter((call) => call === 'consume').length, 2);
const theme = await issuer.issue({
  playerId: 'server-player',
  productId: 'THEME',
  idempotencyKey: 'theme',
});
state = { ...state, developerPayload: theme.developerPayload, consumptionState: 0, acknowledgeState: 0, purchaseId: 'purchase-theme' };
const themeRequest = {
  ...request,
  productId: 'THEME',
  idempotencyKey: 'theme',
  platformTransactionId: 'purchase-theme',
  evidence: {
    ...request.evidence,
    payload: {
      ...request.evidence.payload,
      productId: 'theme-sku',
      purchaseId: 'purchase-theme',
      purchaseToken: 'token-theme',
      developerPayload: theme.developerPayload,
    },
  },
};
const themed = await backend.purchases.verifyPurchase(themeRequest);
assert.equal(themed.finalization?.action, 'acknowledge');
assert.equal(themed.finalization?.status, 'completed');
assert.equal((await ledger.listEntitlementTransactions()).length, 2);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const licenseKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
function notification(overrides: Record<string, unknown> = {}) {
  const message = {
    msgVersion: '3.1.0D',
    clientId: client.clientId,
    productId: 'theme-sku',
    messageType: 'SINGLE_PAYMENT_TRANSACTION',
    purchaseId: state.purchaseId,
    developerPayload: theme.developerPayload,
    purchaseTimeMillis: state.purchaseTime,
    purchaseState: 'COMPLETED',
    purchaseToken: 'token-theme',
    environment: 'SANDBOX',
    marketCode: 'MKT_ONE',
    productName: '한글 상품',
    ...overrides,
  };
  const signature = sign('RSA-SHA512', Buffer.from(JSON.stringify(message)), privateKey).toString(
    'base64',
  );
  return new TextEncoder().encode(JSON.stringify({ ...message, signature }));
}
const valid = notification();
assert.notEqual(
  await verifyOnePlayPns({ rawBody: valid, publicKey: licenseKey, client }),
  undefined,
);
assert.equal(
  await verifyOnePlayPns({ rawBody: notification({ clientId: 'wrong' }), publicKey: licenseKey, client }),
  undefined,
);
assert.equal(
  await verifyOnePlayPns({ rawBody: notification({ environment: 'COMMERCIAL' }), publicKey: licenseKey, client }),
  undefined,
);
assert.equal(
  await verifyOnePlayPns({ rawBody: notification({ marketCode: 'MKT_GLB' }), publicKey: licenseKey, client }),
  undefined,
);
assert.equal(
  await verifyOnePlayPns({ rawBody: new TextEncoder().encode(new TextDecoder().decode(valid).replace('한글 상품', 'modified')), publicKey: licenseKey, client }),
  undefined,
);
const missingFinalizerBackend = createGameServicesBackend({
  catalog,
  placements: { version: 'test', placements: [] },
  store: ledger,
  evidenceVerifier: {
    verifyPurchase: boundary.verifyPurchase,
    verifyAdReward: async () => ({ status: 'rejected', reason: 'unsupported' }),
  },
});
const missingFinalizer = createOnePlayPnsReceiver({
  publicKey: licenseKey,
  client,
  boundary,
  backend: missingFinalizerBackend,
  onCancelled: async () => {
    throw new Error('Unexpected cancellation');
  },
});
assert.deepEqual(await missingFinalizer.receive(valid), {
  status: 'pending',
  reason: 'ONEPLAY_FINALIZATION_REQUIRED',
});
const cancellations = new Set<string>();
const pns = createOnePlayPnsReceiver({
  publicKey: licenseKey,
  client,
  boundary,
  backend,
  onCancelled: async (purchase) => {
    cancellations.add(purchase.verificationId);
  },
});
assert.equal((await pns.receive(valid)).status, 'processed');
assert.equal((await ledger.listEntitlementTransactions()).length, 2);
assert.equal(
  (await pns.receive(notification({ purchaseState: 'CANCELED' }))).status,
  'pending',
  'notification alone cannot revoke',
);
assert.equal(cancellations.size, 0);
state = { ...state, purchaseState: 1 };
assert.equal((await pns.receive(notification({ purchaseState: 'CANCELED' }))).status, 'processed');
assert.equal((await pns.receive(notification({ purchaseState: 'CANCELED' }))).status, 'processed');
assert.equal(cancellations.size, 1);
assert.equal(
  (await boundary.verifyPurchase({ ...verify, request: themeRequest, product: catalog.products[1]!, platformProductId: 'theme-sku' })).status,
  'rejected',
);
const orphan = await issuer.issue({
  playerId: 'server-player',
  productId: 'THEME',
  idempotencyKey: 'orphan',
});
state = { ...state, purchaseState: 0, consumptionState: 0, acknowledgeState: 0, purchaseId: 'orphan-purchase', developerPayload: orphan.developerPayload };
assert.equal(
  (await pns.receive(notification({ purchaseId: 'orphan-purchase', developerPayload: orphan.developerPayload, purchaseToken: 'orphan-token' }))).status,
  'processed',
);
assert.equal(
  (await ledger.listEntitlementTransactions()).length,
  3,
  'PNS recovers a purchase without a client callback',
);

const httpCalls: { url: string; init?: RequestInit }[] = [];
const transport = createOnePlayPurchaseClient({
  clientId: 'client',
  clientSecret: 'server-only-secret',
  environment: 'SANDBOX',
  now: () => at,
  fetch: async (url, init) => {
    httpCalls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
    return new Response(
      JSON.stringify(
        String(url).endsWith('/oauth/token')
          ? {
              client_id: 'client',
              access_token: 'access-token',
              token_type: 'bearer',
              expires_in: 3600,
            }
          : String(url).endsWith('/consume') || String(url).endsWith('/acknowledge')
            ? { result: { code: 'Success' } }
            : state,
      ),
      { status: 200 },
    );
  },
});
await transport.getPurchaseDetails({
  productId: 'sku/encoded',
  purchaseToken: 'secret-token',
  signal: new AbortController().signal,
});
await transport.consumePurchase({
  productId: 'sku/encoded',
  purchaseToken: 'secret-token',
  developerPayload: 'payload',
  signal: new AbortController().signal,
});
assert.equal(httpCalls.filter((call) => call.url.endsWith('/oauth/token')).length, 1);
assert.equal(httpCalls[0]?.url, 'https://sbpp.onestore.net/v7/oauth/token');
assert.match(String(httpCalls[0]?.init?.body), /grant_type=client_credentials/u);
assert.match(httpCalls[1]?.url ?? '', /products\/sku%2Fencoded\/secret-token$/u);
assert.equal(new Headers(httpCalls[1]?.init?.headers).get('authorization'), 'Bearer access-token');
assert.equal(httpCalls[2]?.init?.body, '{"developerPayload":"payload"}');
assert.equal(httpCalls[2]?.init?.redirect, 'manual');
assert.ok(httpCalls.every((call) => call.init?.redirect === 'manual'));
await assert.rejects(
  () =>
    transport.consumePurchase({
      productId: 'sku',
      purchaseToken: 'secret-token',
      developerPayload: '한'.repeat(70),
      signal: new AbortController().signal,
    }),
  /too long/u,
);
// Workers only support manual redirects; a 3xx with a plausible OAuth or purchase body must fail.
const redirectCalls: { url: string; init?: RequestInit }[] = [];
const redirected = createOnePlayPurchaseClient({
  clientId: 'client',
  clientSecret: 'server-only-secret',
  environment: 'SANDBOX',
  now: () => at,
  fetch: async (url, init) => {
    redirectCalls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
    return Response.json(
      String(url).endsWith('/oauth/token')
        ? {
            client_id: 'client',
            access_token: 'access-token',
            token_type: 'bearer',
            expires_in: 3600,
          }
        : state,
      { status: 302, headers: { Location: 'https://attacker.example/v7/oauth/token' } },
    );
  },
});
await assert.rejects(
  () =>
    redirected.getPurchaseDetails({
      productId: 'sku',
      purchaseToken: 'secret-token',
      signal: new AbortController().signal,
    }),
  /ONE play purchase API request failed/u,
);
assert.equal(redirectCalls.length, 1, 'a redirected OAuth response must not yield a token');
assert.equal(redirectCalls[0]?.init?.redirect, 'manual');
const followedResponse = Response.json({
  client_id: 'client',
  access_token: 'access-token',
  token_type: 'bearer',
  expires_in: 3600,
});
Object.defineProperty(followedResponse, 'redirected', { value: true });
const followed = createOnePlayPurchaseClient({
  clientId: 'client',
  clientSecret: 'server-only-secret',
  environment: 'SANDBOX',
  now: () => at,
  fetch: async () => followedResponse,
});
await assert.rejects(
  () =>
    followed.getPurchaseDetails({
      productId: 'sku',
      purchaseToken: 'secret-token',
      signal: new AbortController().signal,
    }),
  /ONE play purchase API request failed/u,
);
const failed = createOnePlayPurchaseClient({
  clientId: 'client',
  clientSecret: 'server-only-secret',
  environment: 'COMMERCIAL',
  fetch: async () => {
    throw new Error('server-only-secret secret-token');
  },
});
await assert.rejects(
  () =>
    failed.getPurchaseDetails({
      productId: 'sku',
      purchaseToken: 'secret-token',
      signal: new AbortController().signal,
    }),
  (error: unknown) => error instanceof Error && !error.message.includes('server-only-secret') && !error.message.includes('secret-token'),
);
console.log(
  'ONE play checkout binding, API verification, ledger-before-consume recovery, acknowledge, signed PNS, cancellation and orphan purchase recovery passed.',
);
