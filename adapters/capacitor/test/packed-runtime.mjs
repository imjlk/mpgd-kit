import assert from 'node:assert/strict';

import {
  createCapacitorNativeJsonTransport,
  createCapacitorPlatformGateway,
  createCapacitorViewport,
  createCommerceServiceProvider,
  createStoreCommerceProvider,
  defaultStoreSdkErrorCodeMap,
  normalizeStoreSdkError,
} from '@mpgd/adapter-capacitor';
import { createCapacitorAdMobRewardedProvider } from '@mpgd/adapter-capacitor/admob';
import { createAppleSignedTransactionVerifier } from '@mpgd/adapter-capacitor/app-store-server';
import {
  createAppleSignedTransactionVerifier as createGameServicesAppleVerifier,
} from '@mpgd/game-services/app-store-server';
import { createUnsupportedCapabilities } from '@mpgd/platform';
import { getFeatureAvailability, resolveTargetViewportUsableArea } from '@mpgd/target-config';

const gateway = createCapacitorPlatformGateway({
  target: 'android',
  appVersion: '1',
  buildId: 'packed',
  bridge: {
    async request(input) {
      return { id: input.id, ok: true, data: createUnsupportedCapabilities() };
    },
  },
});
const capabilities = await gateway.getCapabilities();
assert.equal(capabilities.nativeIap, false);
assert.equal(capabilities.providerAvailability.nativeIap, 'unsupported');
assert.equal(typeof getFeatureAvailability, 'function');
assert.equal(typeof createCapacitorAdMobRewardedProvider, 'function');
assert.equal(typeof createAppleSignedTransactionVerifier, 'function');
// The deprecated adapter subpath is the game-services implementation.
assert.equal(createAppleSignedTransactionVerifier, createGameServicesAppleVerifier);

const composed = createCapacitorPlatformGateway({
  target: 'android', appVersion: '1', buildId: 'packed-provider',
  bridge: {
    async request(input) {
      return { id: input.id, ok: true, data: createUnsupportedCapabilities() };
    },
  },
  providers: [{
    id: 'packed-store',
    features: ['nativeIap'],
    methods: [
      'commerce.getProducts', 'commerce.purchase', 'commerce.restore',
      'commerce.getEntitlements',
    ],
    async getAvailability() { return { nativeIap: 'available' }; },
    bridge: {
      async request(input) {
        return {
          id: input.id, ok: true,
          data: input.method === 'commerce.purchase'
            ? { status: 'pending', entitlementIds: [] }
            : input.method === 'commerce.restore'
              ? { restoredEntitlements: [] }
              : [],
        };
      },
    },
  }],
});
assert.equal((await composed.getCapabilities()).nativeIap, true);
assert.equal((await composed.commerce.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'packed-order',
})).status, 'pending');

// Commerce v2: a StoreSdk provider registered through the registry serves the
// v2 surface, the v1 wrapper, and the capability block from one declaration.
const storeListeners = new Set();
const storePurchases = [];
const storeSdk = {
  store: 'packed-store',
  capabilities: {
    purchase: { consumable: true, durable: true, subscription: false, quantity: false },
    pending: true, restore: true, finish: 'client',
  },
  async fetchProducts({ skus }) {
    return skus.map((sku) => ({
      sku, kind: 'consumable', title: sku, description: sku,
      price: { formatted: '$0.99', currencyCode: 'USD' },
    }));
  },
  async requestPurchase() {
    return { outcome: 'launched' };
  },
  async getAvailablePurchases() {
    return storePurchases;
  },
  async finishTransaction({ transactionId }) {
    storePurchases.splice(storePurchases.findIndex((p) => p.transactionId === transactionId), 1);
    return { finished: true };
  },
  async restorePurchases() {},
  addListener(eventName, listener) {
    const entry = { eventName, listener };
    storeListeners.add(entry);
    return () => storeListeners.delete(entry);
  },
  async getAvailability() {
    return 'available';
  },
};
const storeProvider = createStoreCommerceProvider({
  sdk: storeSdk,
  products: [{ logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' }],
  evidenceSchema: 'packed.store.v1',
  authority: { evidence: 'client-token', accountBinding: 'optional' },
});
const storeGateway = createCapacitorPlatformGateway({
  target: 'android', appVersion: '1', buildId: 'packed-commerce-v2',
  bridge: {
    async request(input) {
      return { id: input.id, ok: true, data: createUnsupportedCapabilities() };
    },
  },
  providers: [createCommerceServiceProvider({ id: 'packed-store', commerce: storeProvider })],
});
assert.equal(storeGateway.commerceV2.store, 'packed-store');
const storeCapabilities = await storeGateway.getCapabilities();
assert.equal(storeCapabilities.nativeIap, true);
assert.equal(storeCapabilities.commerce.availability, 'available');
assert.equal(storeCapabilities.providerAvailability.nativeIap, 'available');
const storeEvents = [];
storeGateway.commerceV2.subscribe((event) => storeEvents.push(event));
assert.deepEqual(await storeGateway.commerceV2.requestPurchase({
  logicalId: 'gems_small', idempotencyKey: 'packed-v2', source: 'shop',
}), { outcome: 'launched' });
const storePurchase = {
  sku: 'gems.small', transactionId: 'packed-tx', state: 'purchased', token: 'packed-token',
  quantity: 1,
};
storePurchases.push(storePurchase);
for (const { eventName, listener } of storeListeners) {
  if (eventName === 'purchaseUpdated') listener({ type: 'purchaseUpdated', purchase: storePurchase });
}
assert.equal(storeEvents.length, 1);
assert.equal(storeEvents[0].purchase.logicalId, 'gems_small');
assert.equal(storeEvents[0].purchase.evidence.schema, 'packed.store.v1');
assert.equal('settlement' in storeEvents[0].purchase, false);
assert.equal((await storeGateway.commerceV2.getAvailablePurchases())[0].transactionId, 'packed-tx');
assert.deepEqual(await storeGateway.commerceV2.finishTransaction({
  transactionId: 'packed-tx', ledgerEntryId: 'packed-ledger', isConsumable: true,
}), { finished: true });
assert.equal((await storeGateway.commerce.purchase({
  productId: 'gems_small', source: 'shop', idempotencyKey: 'packed-v1',
})).status, 'pending');
assert.equal(normalizeStoreSdkError({ code: 'PLAY_BILLING_NETWORK_ERROR' }).code, 'NETWORK');
assert.equal(defaultStoreSdkErrorCodeMap.STOREKIT_UNAVAILABLE, 'STORE_UNAVAILABLE');

let sent;
const nativeJson = createCapacitorNativeJsonTransport({
  target: 'android',
  baseUrl: 'https://api.example.com',
  allowedOrigin: 'https://api.example.com',
  getPlatform: () => 'android',
  http: {
    async request(options) {
      sent = options;
      return { status: 200, url: options.url, headers: {}, data: { verified: true } };
    },
  },
});
assert.deepEqual(await nativeJson.send({
  method: 'POST', endpoint: '/game-services/purchases/verify',
  body: { idempotencyKey: 'packed-native' },
}), { status: 200, body: { verified: true } });
assert.equal(sent.disableRedirects, true);
assert.equal(sent.url, 'https://api.example.com/game-services/purchases/verify');

const viewport = createCapacitorViewport({
  host: {
    readState: () => ({
      width: 390, height: 844,
      safeAreaInsets: { top: 24, right: 0, bottom: 34, left: 0 },
      systemBarInsets: { top: 30, right: 0, bottom: 24, left: 0 },
      keyboardInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    }),
    onChange: () => () => undefined,
  },
});
viewport.setOccupiedSurface({
  surfaceId: 'packed-banner', edge: 'bottom', unit: 'css-px',
  bounds: { x: 0, y: 780, width: 390, height: 64 },
});
const state = viewport.getState();
assert.deepEqual(resolveTargetViewportUsableArea(state, state).contentBounds,
  { x: 0, y: 30, width: 390, height: 750 });
viewport.dispose();

const secureValues = new Map();
const credentialGateway = createCapacitorPlatformGateway({
  target: 'ios', appVersion: '1', buildId: 'packed-credentials',
  bridge: {
    async request(input) {
      const { key, value } = input.payload;
      if (input.method === 'credentials.load') {
        const stored = secureValues.get(key);
        return { id: input.id, ok: true, data: stored === undefined
          ? { __mpgdBridgeProtocol: 'mpgd.credentials.load.v1', found: false }
          : { __mpgdBridgeProtocol: 'mpgd.credentials.load.v1', found: true, value: stored } };
      }
      if (input.method === 'credentials.save') {
        secureValues.set(key, value);
        return { id: input.id, ok: true, data: { saved: true } };
      }
      if (input.method === 'credentials.remove') {
        secureValues.delete(key);
        return { id: input.id, ok: true, data: { removed: true } };
      }
      throw new Error(`Unexpected bridge method: ${input.method}`);
    },
  },
});
const credentials = credentialGateway.secureCredentials;
assert.ok(credentials);
await credentials.save({ key: 'packed.refresh', value: 'opaque-token' });
assert.equal(await credentials.load({ key: 'packed.refresh' }), 'opaque-token');
await credentials.remove({ key: 'packed.refresh' });
assert.equal(await credentials.load({ key: 'packed.refresh' }), null);
assert.equal(secureValues.size, 0);
