import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { commerceBridgeMethods } from '@mpgd/platform/commerce';
import { notificationBridgeMethods, notificationsProtocol } from '@mpgd/platform/notifications';

import {
  assertBridgeEvent,
  bridgeCommerceEventProtocol,
  bridgeCommerceV2Methods,
  bridgeEventProtocol,
  bridgeNotificationsEventProtocol,
  bridgeNotificationsV2Methods,
  createBridgeEventSource,
  createCommerceV2UnavailableBridgeError,
  createNotificationsV2UnavailableBridgeError,
  isBridgeCommerceV2Method,
  isBridgeNotificationsV2Method,
} from '../dist/index.js';
import {
  assertBridgeNotificationsV2Payload,
  assertBridgeNotificationsV2Result,
  createNotificationsV2BridgeHandler,
  readBridgeNotificationsHostCode,
} from '../dist/notifications.js';

// The main entry loads no notifications code; only `./notifications` does.
const mainEntry = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
assert.doesNotMatch(mainEntry, /(?:from|import)\s*\(?\s*['"]@mpgd\/platform\/notifications['"]/u);
const notificationsEntry = readFileSync(new URL('../dist/notifications.js', import.meta.url), 'utf8');
assert.match(notificationsEntry, /from\s*['"]@mpgd\/platform\/notifications['"]/u);

assert.deepEqual([...bridgeCommerceV2Methods], [...commerceBridgeMethods]);
assert.equal(bridgeEventProtocol, 'mpgd.commerce.v2');
assert.equal(bridgeCommerceEventProtocol, 'mpgd.commerce.v2');
assert.equal(isBridgeCommerceV2Method('commerce.v2.fetchProducts'), true);
assert.equal(isBridgeCommerceV2Method('commerce.getProducts'), false);
const unavailable = createCommerceV2UnavailableBridgeError(
  { id: 'dist-1', method: 'commerce.v2.getCapabilities' },
  'dist smoke',
);
assert.equal(unavailable.ok, false);
assert.equal(unavailable.error.code, 'COMMERCE_V2_UNAVAILABLE');
assert.equal(unavailable.error.retryable, false);
assert.throws(() => assertBridgeEvent({ protocol: 'mpgd.commerce.v2', sequence: 0 }));
assert.doesNotThrow(() => assertBridgeEvent({
  protocol: 'mpgd.commerce.v2',
  sequence: 0,
  event: {
    type: 'purchaseError',
    error: { code: 'STORE_UNAVAILABLE', retryable: true },
  },
}));

assert.deepEqual([...bridgeNotificationsV2Methods], [...notificationBridgeMethods]);
assert.equal(bridgeNotificationsEventProtocol, notificationsProtocol);
assert.equal(isBridgeNotificationsV2Method('notifications.v2.requestPermission'), true);
assert.equal(isBridgeNotificationsV2Method('notifications.requestSubscription'), false);
const notificationsUnavailable = createNotificationsV2UnavailableBridgeError(
  { id: 'dist-2', method: 'notifications.v2.getCapabilities' },
  'dist smoke',
);
assert.equal(notificationsUnavailable.ok, false);
assert.equal(notificationsUnavailable.error.code, 'NOTIFICATIONS_V2_UNAVAILABLE');
assert.equal(notificationsUnavailable.error.retryable, false);
assert.deepEqual(
  assertBridgeNotificationsV2Payload('notifications.v2.requestPermission', { topics: ['daily'] }),
  { topics: ['daily'] },
);
assert.throws(() => assertBridgeNotificationsV2Payload('notifications.v2.requestPermission', {
  topics: [],
}));
assert.deepEqual(
  assertBridgeNotificationsV2Result('notifications.v2.openSettings', { status: 'unavailable' }),
  { status: 'unavailable' },
);
assert.throws(() => assertBridgeNotificationsV2Payload('constructor', {}));
const opened = { type: 'opened', channel: 'local', source: 'cold', topic: 'daily' };
assert.doesNotThrow(() => assertBridgeEvent({
  protocol: 'mpgd.notifications.v2',
  sequence: 0,
  event: opened,
}));
assert.throws(() => assertBridgeEvent({
  protocol: 'mpgd.commerce.v2',
  sequence: 0,
  event: opened,
}));
const envelopes = [];
let emit;
const session = createBridgeEventSource('mpgd.notifications.v2', {
  subscribe(listener) {
    emit = listener;
    return () => {
      emit = undefined;
    };
  },
});
const stop = session.subscribe((envelope) => envelopes.push(envelope));
emit?.(opened);
emit?.(opened);
stop();
assert.equal(emit, undefined);
assert.deepEqual(envelopes.map((envelope) => envelope.sequence), [0, 1]);
for (const envelope of envelopes) {
  assert.doesNotThrow(() => assertBridgeEvent(envelope));
}

// The host handler from the published entry serves a provider end to end.
const handler = createNotificationsV2BridgeHandler({
  provider: {
    provider: 'fixture',
    getCapabilities: async () => ({}),
    getPermission: async ({ topics }) => ({
      topics: Object.fromEntries(topics.map((topic) => [topic, 'unsupported'])),
    }),
    requestPermission: async () => ({ snapshot: { topics: {} }, outcomes: {} }),
    subscribe: () => () => {},
  },
});
assert.deepEqual(
  await handler.request({
    id: 'dist-3',
    method: 'notifications.v2.getPermission',
    payload: { topics: ['daily'] },
  }),
  { id: 'dist-3', ok: true, data: { topics: { daily: 'unsupported' } } },
);
const brokenAnswer = await handler.request({
  id: 'dist-4',
  method: 'notifications.v2.getCapabilities',
  payload: { protocol: 'mpgd.notifications.v2' },
});
assert.equal(brokenAnswer.ok, false);
assert.equal(brokenAnswer.error.code, 'NOTIFICATIONS_CONFIGURATION_REQUIRED');
const unsupported = await handler.request({
  id: 'dist-5',
  method: 'notifications.v2.listLocal',
  payload: { protocol: 'mpgd.notifications.v2' },
});
assert.equal(unsupported.ok, false);
assert.equal(unsupported.error.code, 'NOTIFICATIONS_UNSUPPORTED');
assert.equal(readBridgeNotificationsHostCode('refused (host code HOST_1)'), 'HOST_1');
assert.equal(readBridgeNotificationsHostCode('refused'), undefined);

console.log('@mpgd/bridge Node ESM import passed.');
