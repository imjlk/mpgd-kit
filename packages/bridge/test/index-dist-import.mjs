import assert from 'node:assert/strict';

import { commerceBridgeMethods } from '@mpgd/platform/commerce';

import {
  assertBridgeEvent,
  bridgeCommerceV2Methods,
  bridgeEventProtocol,
  createCommerceV2UnavailableBridgeError,
  isBridgeCommerceV2Method,
} from '../dist/index.js';

assert.deepEqual([...bridgeCommerceV2Methods], [...commerceBridgeMethods]);
assert.equal(bridgeEventProtocol, 'mpgd.commerce.v2');
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

console.log('@mpgd/bridge Node ESM import passed.');
