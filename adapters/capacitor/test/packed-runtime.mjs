import assert from 'node:assert/strict';

import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
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
