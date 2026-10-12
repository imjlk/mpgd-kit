import {
  assertCommerceBridgeFetchProductsPayload,
  assertCommerceBridgeFinishTransactionPayload,
  assertCommerceBridgeFinishTransactionResult,
  assertCommerceBridgeGetAvailablePurchasesPayload,
  assertCommerceBridgeGetAvailablePurchasesResult,
  assertCommerceBridgeGetCapabilitiesPayload,
  assertCommerceBridgeRequestPurchasePayload,
  assertCommerceBridgeRequestPurchaseResult,
  assertCommerceBridgeRestorePurchasesPayload,
  assertCommerceEventEnvelope,
  commerceBridgeMethods,
  commerceProtocol,
} from '@mpgd/platform/commerce';

import {
  invalidBridgeEvents,
  invalidBridgeRequests,
  validBridgeErrorResponse,
  validBridgeEvents,
  validBridgeOkResponse,
  validBridgeRequest,
  validCommerceV2BridgeRequests,
  validCommerceV2BridgeResponses,
  validNewBridgeRequests,
} from './fixtures';
import {
  assertBridgeEvent,
  assertBridgeRequest,
  assertBridgeResponse,
  bridgeCommerceV2Methods,
  bridgeEventProtocol,
  bridgeStorageLoadProtocol,
  commerceV2UnavailableBridgeErrorCode,
  createBridgeError,
  createCommerceV2UnavailableBridgeError,
  decodeBridgeStorageLoadData,
  isBridgeCommerceV2Method,
  type BridgeEvent,
  type BridgeEventSource,
  type BridgeMethod,
} from './index';

assertDoesNotThrow(() => assertBridgeRequest(validBridgeRequest), 'valid request should pass');
assertDoesNotThrow(() => assertBridgeResponse(validBridgeOkResponse), 'ok response should pass');
assertDoesNotThrow(
  () => assertBridgeResponse(validBridgeErrorResponse),
  'error response should pass',
);

for (const validRequest of validNewBridgeRequests) {
  assertDoesNotThrow(
    () => assertBridgeRequest(validRequest),
    `${validRequest.method} request should pass`,
  );
}

for (const invalidRequest of invalidBridgeRequests) {
  assertThrows(() => assertBridgeRequest(invalidRequest), 'invalid request should fail');
}

// Commerce v2: the bridge method list is the platform contract's list.
const expectedCommerceV2Methods: readonly BridgeMethod[] = [
  'commerce.v2.getCapabilities',
  'commerce.v2.fetchProducts',
  'commerce.v2.requestPurchase',
  'commerce.v2.getAvailablePurchases',
  'commerce.v2.finishTransaction',
  'commerce.v2.restorePurchases',
];
assertEqual(
  JSON.stringify(bridgeCommerceV2Methods),
  JSON.stringify(expectedCommerceV2Methods),
  'bridge commerce v2 methods should be the six RFC methods',
);
assertEqual(
  JSON.stringify(bridgeCommerceV2Methods),
  JSON.stringify(commerceBridgeMethods),
  'bridge commerce v2 methods should equal @mpgd/platform/commerce commerceBridgeMethods',
);
for (const method of commerceBridgeMethods) {
  assertEqual(isBridgeCommerceV2Method(method), true, `${method} should be a v2 method`);
}
// The v1 commerce methods were removed in C4: they are neither v2 methods nor bridge methods.
for (const removed of [
  'commerce.getProducts',
  'commerce.purchase',
  'commerce.restore',
  'commerce.getEntitlements',
]) {
  assertEqual(isBridgeCommerceV2Method(removed), false, `${removed} was removed in C4`);
  assertThrows(
    () => assertBridgeRequest({ ...validCommerceV2BridgeRequests[0], method: removed }),
    `${removed} is no longer a bridge method`,
  );
}
assertEqual(isBridgeCommerceV2Method('commerce.v2.unknown'), false, 'unknown v2 names fail closed');
assertEqual(
  validCommerceV2BridgeRequests.length,
  commerceBridgeMethods.length,
  'every v2 method should have a request fixture',
);

const commerceV2PayloadAsserts = {
  'commerce.v2.getCapabilities': assertCommerceBridgeGetCapabilitiesPayload,
  'commerce.v2.fetchProducts': assertCommerceBridgeFetchProductsPayload,
  'commerce.v2.requestPurchase': assertCommerceBridgeRequestPurchasePayload,
  'commerce.v2.getAvailablePurchases': assertCommerceBridgeGetAvailablePurchasesPayload,
  'commerce.v2.finishTransaction': assertCommerceBridgeFinishTransactionPayload,
  'commerce.v2.restorePurchases': assertCommerceBridgeRestorePurchasesPayload,
} as const satisfies Record<(typeof commerceBridgeMethods)[number], (input: unknown) => unknown>;

for (const request of validCommerceV2BridgeRequests) {
  assertDoesNotThrow(() => assertBridgeRequest(request), `${request.method} request should pass`);
  const assertPayload = isBridgeCommerceV2Method(request.method)
    ? commerceV2PayloadAsserts[request.method]
    : undefined;
  if (assertPayload === undefined) {
    throw new Error(`${request.method} should be a commerce v2 method.`);
  }
  assertDoesNotThrow(
    () => assertPayload(request.payload),
    `${request.method} payload should satisfy the platform contract`,
  );
}

const commerceV2ResultAsserts: readonly ((input: unknown) => unknown)[] = [
  assertCommerceBridgeRequestPurchaseResult,
  assertCommerceBridgeGetAvailablePurchasesResult,
  assertCommerceBridgeFinishTransactionResult,
];
for (const [index, response] of validCommerceV2BridgeResponses.entries()) {
  assertDoesNotThrow(() => assertBridgeResponse(response), `${response.id} response should pass`);
  const assertResult = commerceV2ResultAsserts[index];
  if (assertResult === undefined || !response.ok) {
    throw new Error(`${response.id} should have an ok result assert.`);
  }
  assertDoesNotThrow(
    () => assertResult(response.data),
    `${response.id} data should satisfy the platform contract`,
  );
}

const unavailable = createCommerceV2UnavailableBridgeError(
  { id: 'v2-request', method: 'commerce.v2.requestPurchase' },
  'Test transport',
);
assertEqual(unavailable.ok, false, 'a v2 request without a provider should fail');
if (!unavailable.ok) {
  assertEqual(unavailable.error.code, commerceV2UnavailableBridgeErrorCode, 'v2 unavailable code');
  assertEqual(unavailable.error.code, 'COMMERCE_V2_UNAVAILABLE', 'v2 unavailable literal');
  assertEqual(unavailable.error.retryable, false, 'v2 unavailable should not be retryable');
  assertEqual(
    unavailable.error.message.includes('commerce.v2.requestPurchase'),
    true,
    'v2 unavailable message should name the method',
  );
}
assertDoesNotThrow(() => assertBridgeResponse(unavailable), 'v2 unavailable response should pass');

// Events.
assertEqual(
  bridgeEventProtocol,
  commerceProtocol,
  'bridge event protocol is the commerce protocol',
);
assertEqual(bridgeEventProtocol, 'mpgd.commerce.v2', 'bridge event protocol literal');
for (const event of validBridgeEvents) {
  assertDoesNotThrow(() => assertBridgeEvent(event), `${event.event.type} event should pass`);
  assertDoesNotThrow(
    () => assertCommerceEventEnvelope(event),
    `${event.event.type} event should satisfy the platform envelope`,
  );
  assertEqual(
    assertBridgeEvent(JSON.parse(JSON.stringify(event))) !== undefined,
    true,
    'events should survive a JSON round trip',
  );
}
for (const [index, event] of invalidBridgeEvents.entries()) {
  assertThrows(() => assertBridgeEvent(event), `invalid event ${String(index)} should fail`);
}

const delivered: BridgeEvent[] = [];
const listeners = new Set<(event: BridgeEvent) => void>();
const source: BridgeEventSource = {
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
const [firstEvent, secondEvent] = validBridgeEvents;
const unsubscribe = source.subscribe((event) => delivered.push(event));
for (const listener of listeners) {
  listener(firstEvent);
}
unsubscribe();
for (const listener of listeners) {
  listener(secondEvent);
}
assertEqual(delivered.length, 1, 'unsubscribe should stop delivery');
assertEqual(delivered[0]?.sequence, 0, 'the subscribed listener should receive the first event');

const error = createBridgeError('request-2', 'TEMPORARY_UNAVAILABLE', 'Try again later.', true);
assertEqual(error.ok, false, 'createBridgeError should create an error response');
assertEqual(error.id, 'request-2', 'createBridgeError should preserve id');

if (!error.ok) {
  assertEqual(error.error.retryable, true, 'createBridgeError should preserve retryable flag');
}

assertEqual(
  decodeBridgeStorageLoadData({
    __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
    found: false,
  }),
  null,
  'a missing storage bridge value should decode as null',
);
assertEqual(
  decodeBridgeStorageLoadData({
    __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
    found: true,
    value: null,
  })?.value,
  null,
  'a stored top-level JSON null should remain present',
);
assertEqual(
  decodeBridgeStorageLoadData(null),
  null,
  'a legacy null response should remain a missing value',
);
assertEqual(
  decodeBridgeStorageLoadData('legacy-value')?.value,
  'legacy-value',
  'a legacy raw primitive should remain a stored value',
);
assertEqual(
  JSON.stringify(decodeBridgeStorageLoadData({ coins: 7 })?.value),
  JSON.stringify({ coins: 7 }),
  'a legacy raw object should remain a stored value',
);
assertEqual(
  JSON.stringify(decodeBridgeStorageLoadData({ found: false, coins: 7 })?.value),
  JSON.stringify({ found: false, coins: 7 }),
  'a legacy raw object may use a false found field',
);
assertEqual(
  JSON.stringify(decodeBridgeStorageLoadData({ found: true })?.value),
  JSON.stringify({ found: true }),
  'a legacy raw object may use a true found field without a value field',
);
assertThrows(
  () =>
    decodeBridgeStorageLoadData({
      __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
      found: true,
    }),
  'a present storage bridge response without a value should fail closed',
);
assertThrows(
  () => decodeBridgeStorageLoadData(undefined),
  'an absent bridge response should fail closed',
);

console.log('Bridge protocol fixture validation passed.');

function assertDoesNotThrow(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch (error) {
    throw new Error(`${message}: ${(error as Error).message}`);
  }
}

function assertThrows(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch {
    return;
  }

  throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
