import assert from 'node:assert/strict';

import { commerceBridgeMethods } from '@mpgd/platform/commerce';
import { notificationBridgeMethods } from '@mpgd/platform/notifications';

import {
  assertBridgeEvent,
  assertBridgeNotificationsV2Payload,
  assertBridgeNotificationsV2Result,
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
assert.equal(bridgeNotificationsEventProtocol, 'mpgd.notifications.v2');
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

console.log('@mpgd/bridge Node ESM import passed.');
