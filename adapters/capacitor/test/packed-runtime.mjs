import assert from 'node:assert/strict';

import {
  createCapacitorNativeJsonTransport,
  createCapacitorPlatformGateway,
} from '@mpgd/adapter-capacitor';
import { createUnsupportedCapabilities } from '@mpgd/platform';
import { getFeatureAvailability } from '@mpgd/target-config';

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

let sent;
const nativeJson = createCapacitorNativeJsonTransport({
  target: 'android',
  baseUrl: 'https://api.example.com',
  allowedOrigins: ['https://api.example.com'],
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
