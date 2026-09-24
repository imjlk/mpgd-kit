import assert from 'node:assert/strict';

import {
  createCapacitorNativeJsonTransport,
  createCapacitorPlatformGateway,
  createCapacitorViewport,
} from '@mpgd/adapter-capacitor';
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
