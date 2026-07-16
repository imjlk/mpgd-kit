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
  decodeBridgeStorageLoadData({ found: false }),
  null,
  'a missing storage bridge value should decode as null',
);
assertEqual(
  decodeBridgeStorageLoadData({ found: true, value: null })?.value,
  null,
  'a stored top-level JSON null should remain present',
);
assertThrows(
  () => decodeBridgeStorageLoadData({ found: true }),
  'a present storage bridge response without a value should fail closed',
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
