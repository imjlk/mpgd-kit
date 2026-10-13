import assert from 'node:assert/strict';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';
import { GameServicesBackendError } from '@mpgd/game-services/client';
import { createGuestSessionCoordinator } from '@mpgd/game-services/guest-session';
import { createRecoverableMonetizationClient } from '@mpgd/game-services';
import { createAppleSignedTransactionVerifier } from '@mpgd/game-services/app-store-server';

assert.equal(typeof createRecoverableMonetizationClient, 'function');
assert.equal(typeof createAppleSignedTransactionVerifier, 'function');
assert.throws(
  () => createAppleSignedTransactionVerifier({
    rootCertificates: [], environment: 'Sandbox', bundleId: 'dev.mpgd.packed',
  }),
  /Apple root certificates are required/u,
);

let defaultFetchCalls = 0;
globalThis.fetch = async () => {
  defaultFetchCalls += 1;
  throw new Error('Default fetch must not run for an injected transport.');
};

const requests = [];
// The reconciler is the only purchase path: the gateway sells through a commerce provider.
const commerce = {
  store: 'packed-store',
  async getCapabilities() {
    return {
      purchase: { consumable: true, durable: false, subscription: false, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: true },
      lifecycle: {
        availablePurchases: true, pending: false, restore: false, events: false, finish: 'none',
      },
      authority: { evidence: 'client-token', accountBinding: 'optional' },
      availability: 'available',
    };
  },
  async fetchProducts() {
    return [{
      logicalId: 'COINS_100',
      store: 'packed-store',
      storeSku: 'coins_100',
      kind: 'consumable',
      title: '100 Coins',
      description: 'Adds 100 coins.',
      price: { formatted: '$0.99', currencyCode: 'USD' },
    }];
  },
  async requestPurchase(input) {
    return {
      outcome: 'purchased',
      purchase: {
        store: 'packed-store',
        transactionId: `native-${input.idempotencyKey}`,
        storeSku: 'coins_100',
        logicalId: 'COINS_100',
        quantity: 1,
        state: 'purchased',
        token: `token-${input.idempotencyKey}`,
        evidence: { schema: 'packed.purchase.v1', payload: { token: `token-${input.idempotencyKey}` } },
      },
    };
  },
  async getAvailablePurchases() {
    return [];
  },
  subscribe() {
    return () => {};
  },
};
const gateway = {
  target: 'android',
  commerce,
  ads: {
    async preload() {},
    async showRewarded() {
      return { status: 'completed', rewardGranted: true, ledgerEntryId: 'packed-impression' };
    },
  },
};
const verifyEndpoint = '/game-services/purchases/verify';
let authorization = 'Bearer first';
const runtime = createGameServicesRuntime({
  gateway,
  playerId: 'packed-player',
  authorityMode: 'production',
  baseUrl: 'https://api.example.com',
  httpTransport: {
    async send(request) {
      requests.push(request);
      return {
        status: request.body.idempotencyKey === 'failed' ? 503 : 200,
        body: request.endpoint === '/game-services/ad-rewards/claim'
          ? { granted: true, ledgerEntryId: 'packed-reward-ledger', alreadyProcessed: false }
          : { verified: true, ledgerEntryId: 'packed-ledger', alreadyProcessed: false },
      };
    },
  },
  getHeaders: () => ({ authorization }),
});
assert.equal(runtime.mode, 'http');
assert.ok(runtime.client);

const first = await runtime.client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'first',
});
assert.equal(first.status, 'granted');
authorization = 'Bearer refreshed';
const second = await runtime.client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'second',
});
assert.equal(second.status, 'granted');
assert.deepEqual(
  requests
    .filter((request) => request.endpoint === verifyEndpoint)
    .map((request) => request.headers.authorization),
  ['Bearer first', 'Bearer refreshed'],
);
assert.equal(defaultFetchCalls, 0);

// A backend outage leaves the reconciler's purchase pending instead of throwing or granting.
const outage = await runtime.client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'failed',
});
assert.equal(outage.status, 'pending');
await assert.rejects(runtime.client.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'failed',
}), (error) => error instanceof GameServicesBackendError && error.status === 503);
assert.equal(defaultFetchCalls, 0);

const onePlayModules = await Promise.all([
  import('@mpgd/game-services/oneplay-purchase-client'),
  import('@mpgd/game-services/oneplay-purchase'),
  import('@mpgd/game-services/oneplay-pns'),
]);
assert.equal(typeof onePlayModules[0].createOnePlayPurchaseClient, 'function');
assert.equal(typeof onePlayModules[1].createOnePlayCheckoutIntentIssuer, 'function');
assert.equal(typeof onePlayModules[1].createOnePlayPurchaseBoundary, 'function');
assert.equal(typeof onePlayModules[2].verifyOnePlayPns, 'function');
const onePlayRuntime = createGameServicesRuntime({
  gateway: { ...gateway, target: 'oneplay' },
  playerId: 'packed-player', authorityMode: 'production', baseUrl: 'https://api.example.com',
  getHeaders: () => ({ authorization: 'Bearer own-session' }),
  httpTransport: { async send(request) {
    assert.equal(request.headers.authorization, 'Bearer own-session');
    if (request.endpoint === verifyEndpoint) {
      assert.equal(request.body.target, 'oneplay');
    }
    return { status: 200, body: { verified: true, ledgerEntryId: 'oneplay-ledger', alreadyProcessed: false } };
  } },
});
assert.equal((await onePlayRuntime.client.purchase({ productId: 'COINS_100', source: 'shop', idempotencyKey: 'oneplay' })).status, 'granted');
assert.equal(defaultFetchCalls, 0);

const secureValues = new Map();
const guest = createGuestSessionCoordinator({
  installationId: 'packed-installation',
  credentials: {
    async load({ key }) { return secureValues.get(key) ?? null; },
    async save({ key, value }) { secureValues.set(key, value); },
    async remove({ key }) { secureValues.delete(key); },
  },
  backend: {
    async issueGuest() {
      return {
        serverUserId: 'packed-server-user', sessionId: 'packed-session',
        identityLevel: 'guest', accessToken: 'packed-access',
        refreshToken: 'packed-refresh', accessExpiresAt: '2030-01-01T00:00:00Z',
      };
    },
    async refresh() { throw new Error('Unexpected refresh'); },
    async revoke() {},
    async bindAccount() { return { status: 'conflict' }; },
  },
  now: () => Date.parse('2029-01-01T00:00:00Z'),
});
const session = await guest.start();
assert.equal(secureValues.get('mpgd.guest.refresh'), 'packed-refresh');
assert.equal(session.serverUserId, 'packed-server-user');
assert.equal(Object.hasOwn(session, 'accessToken'), false);
assert.deepEqual(guest.getHeaders(), { authorization: 'Bearer packed-access' });
assert.deepEqual(await guest.bindAccount({
  externalProof: 'packed-proof', idempotencyKey: 'packed-bind',
}), { status: 'conflict' });
assert.deepEqual(guest.getHeaders(), { authorization: 'Bearer packed-access' });
await guest.logout();
assert.equal(secureValues.size, 0);
console.info('Packed @mpgd/game-services custom runtime transport passed.');
