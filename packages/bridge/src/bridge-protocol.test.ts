import {
  invalidBridgeRequests,
  validBridgeErrorResponse,
  validBridgeOkResponse,
  validBridgeRequest,
  validNewBridgeRequests,
} from './fixtures';
import {
  assertBridgeRequest,
  assertBridgeResponse,
  bridgeStorageLoadProtocol,
  createBridgeError,
  decodeBridgeStorageLoadData,
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
  () => decodeBridgeStorageLoadData({
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
