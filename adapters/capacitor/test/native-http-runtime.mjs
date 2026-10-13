import assert from 'node:assert/strict';

import { createCapacitorNativeJsonTransport } from '@mpgd/adapter-capacitor';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';

const baseUrl = 'https://api.example.com';
const sent = [];
const httpTransport = createCapacitorNativeJsonTransport({
  target: 'android',
  baseUrl,
  allowedOrigin: baseUrl,
  getPlatform: () => 'android',
  http: {
    async request(options) {
      if (options.url.endsWith('/game-services/purchases/capabilities')) {
        // This backend publishes no commerce capabilities: the reconciler
        // treats a missing endpoint as unpublished and goes on.
        return { status: 404, url: options.url, headers: {}, data: {} };
      }
      sent.push(options);
      return {
        status: 200,
        url: options.url,
        headers: { 'content-type': 'application/json' },
        data: { verified: true, ledgerEntryId: 'native-ledger', alreadyProcessed: false },
      };
    },
  },
});
let defaultFetchCalls = 0;
globalThis.fetch = async () => {
  defaultFetchCalls += 1;
  throw new Error('Default fetch must not run.');
};
// The reconciler is the only purchase path: the gateway sells through a commerce provider.
const commerce = {
  store: 'native-store',
  async getCapabilities() {
    return {
      purchase: { consumable: true, durable: false, subscription: false, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: false },
      lifecycle: {
        availablePurchases: false, pending: false, restore: false, events: false, finish: 'none',
      },
      authority: { evidence: 'client-token', accountBinding: 'optional' },
      availability: 'available',
    };
  },
  async fetchProducts() {
    return [{
      logicalId: 'COINS_100',
      store: 'native-store',
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
        store: 'native-store',
        transactionId: 'native-transaction',
        storeSku: 'coins_100',
        logicalId: input.logicalId,
        quantity: 1,
        state: 'purchased',
        token: 'native-token',
        evidence: { schema: 'native.purchase.v1', payload: { token: 'native-token' } },
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
const runtime = createGameServicesRuntime({
  gateway: {
    target: 'android',
    commerce,
  },
  playerId: 'native-player',
  authorityMode: 'production',
  baseUrl,
  transport: 'http',
  httpTransport,
  getHeaders: () => ({ authorization: 'Bearer current' }),
});
const result = await runtime.client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'native-operation',
});
assert.equal(result.status, 'granted');
assert.equal(result.ledgerEntryId, 'native-ledger');
// The reconciler also reads ledger status after a grant; the purchase itself is one verify request.
const verifyRequests = sent.filter((options) => options.url.endsWith('/game-services/purchases/verify'));
assert.equal(verifyRequests.length, 1);
assert.equal(verifyRequests[0].headers.authorization, 'Bearer current');
assert.equal(defaultFetchCalls, 0);
console.info('Public Capacitor native HTTP and Game Services runtime composition passed.');
