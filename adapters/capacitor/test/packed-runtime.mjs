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
import {
  createCapacitorNotificationServiceProvider,
  loadCapacitorNotificationSdks,
  openCapacitorNotificationSettings,
} from '@mpgd/adapter-capacitor/notifications';
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
// The commerce block is the only commerce source: a gateway without a commerce
// provider reports the unsupported block and no removed boolean flag.
assert.equal(capabilities.commerce.availability, 'unsupported');
assert.equal(capabilities.commerce.purchase.consumable, false);
assert.equal('nativeIap' in capabilities, false);
assert.equal('subscriptionIap' in capabilities, false);
assert.equal('nativeIap' in capabilities.providerAvailability, false);
assert.equal('commerce' in gateway, false);
assert.equal(typeof getFeatureAvailability, 'function');
assert.equal(typeof createCapacitorAdMobRewardedProvider, 'function');
// The server-side App Store verifier lives in @mpgd/game-services only.
await assert.rejects(import('@mpgd/adapter-capacitor/app-store-server'));

// A native shell that still sends the removed boolean flags cannot leak them.
const staleShell = createCapacitorPlatformGateway({
  target: 'ios', appVersion: '1', buildId: 'packed-stale-shell',
  bridge: {
    async request(input) {
      return {
        id: input.id, ok: true,
        data: { ...createUnsupportedCapabilities(), nativeIap: true, subscriptionIap: true },
      };
    },
  },
});
const staleCapabilities = await staleShell.getCapabilities();
assert.equal('nativeIap' in staleCapabilities, false);
assert.equal('subscriptionIap' in staleCapabilities, false);
assert.equal(staleCapabilities.commerce.availability, 'unsupported');

const composed = createCapacitorPlatformGateway({
  target: 'android', appVersion: '1', buildId: 'packed-provider',
  bridge: {
    async request(input) {
      return { id: input.id, ok: true, data: createUnsupportedCapabilities() };
    },
  },
  providers: [{
    id: 'packed-leaderboard',
    features: ['nativeLeaderboard'],
    methods: ['leaderboard.submitScore', 'leaderboard.open'],
    async getAvailability() { return { nativeLeaderboard: 'available' }; },
    bridge: {
      async request(input) {
        return { id: input.id, ok: true, data: { submitted: true } };
      },
    },
  }],
});
const composedCapabilities = await composed.getCapabilities();
assert.equal(composedCapabilities.nativeLeaderboard, true);
assert.equal(composedCapabilities.providerAvailability.nativeLeaderboard, 'available');
assert.equal(composedCapabilities.commerce.availability, 'unsupported');

// A StoreSdk provider registered through the registry serves the commerce
// provider and the capability block from one declaration.
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
assert.equal(storeGateway.commerce.store, 'packed-store');
const storeCapabilities = await storeGateway.getCapabilities();
assert.equal('nativeIap' in storeCapabilities, false);
assert.equal(storeCapabilities.commerce.availability, 'available');
assert.equal(storeCapabilities.commerce.purchase.consumable, true);
assert.equal('nativeIap' in storeCapabilities.providerAvailability, false);
const storeEvents = [];
storeGateway.commerce.subscribe((event) => storeEvents.push(event));
assert.deepEqual(await storeGateway.commerce.requestPurchase({
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
assert.equal((await storeGateway.commerce.getAvailablePurchases())[0].transactionId, 'packed-tx');
assert.deepEqual(await storeGateway.commerce.finishTransaction({
  transactionId: 'packed-tx', ledgerEntryId: 'packed-ledger', isConsumable: true,
}), { finished: true });
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

// The notifications subpath loads without its optional plugins, which this
// consumer does not install: the loader leaves both out, the provider fails
// closed, and the gateway serves notifications v2 and v1 from it.
await openCapacitorNotificationSettings({ openNotificationSettings: async () => ({ opened: true }) });
await assert.rejects(
  openCapacitorNotificationSettings({ openNotificationSettings: async () => ({ opened: false }) }),
  /could not be opened/u,
);
assert.deepEqual(await loadCapacitorNotificationSdks({
  runtime: { isNativePlatform: () => true, isPluginAvailable: () => true },
}), {});
const notificationsGateway = createCapacitorPlatformGateway({
  target: 'android', appVersion: '1', buildId: 'packed-notifications',
  bridge: {
    async request(input) {
      return { id: input.id, ok: true, data: createUnsupportedCapabilities() };
    },
  },
  providers: [createCapacitorNotificationServiceProvider({
    platform: 'android',
    topics: [{
      id: 'friend-challenge', purpose: 'service', channels: ['remote'],
      route: '/?entry=friend-challenge', mapping: {},
    }],
    app: null,
  })],
});
const notificationCapabilities = await notificationsGateway.getCapabilities();
assert.equal(notificationCapabilities.notifications.availability, 'unsupported');
assert.equal(notificationCapabilities.providerAvailability.pushNotifications, 'unsupported');
assert.deepEqual(
  await notificationsGateway.notificationsV2.getPermission({ topics: ['friend-challenge'] }),
  { app: 'unsupported', topics: { 'friend-challenge': 'unsupported' } },
);
assert.equal(await notificationsGateway.notifications.getStatus('friend-challenge'), 'unsupported');
assert.equal('notificationsV2' in gateway, false);
