import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import {
  compareCreditLotSpendOrder,
  createCommerceConformanceBackend,
  createCommerceConformanceCapabilities,
  createCommerceConformanceClock,
  createCommerceConformanceJournal,
  createCommerceConformanceRuntime,
  createCommerceConformanceStore,
  createCommerceConformanceWallet,
  createCommerceConformanceWalletProvider,
  runCommerceConformanceVector,
  runCommerceConformanceVectors,
} from '@mpgd/platform/commerce-conformance';
import { assertCommerceConformanceVector } from '@mpgd/platform/commerce-vectors';

const vectorsDir = new URL('../../../docs/specs/commerce/vectors/', import.meta.url);
const vectors = readdirSync(vectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => assertCommerceConformanceVector(
    JSON.parse(readFileSync(new URL(file, vectorsDir), 'utf8')),
  ));
assert.equal(vectors.length, 14);

const results = await runCommerceConformanceVectors(vectors);
const failed = results.filter((result) => !result.passed);
assert.deepEqual(
  failed.map((result) => ({ vector: result.vector, failures: result.failures })),
  [],
);

const altered = {
  ...vectors[0],
  expect: { ...vectors[0].expect, purchaseUiOpened: 99 },
};
const negative = await runCommerceConformanceVector(altered);
assert.equal(negative.passed, false);
assert.deepEqual(negative.failures, [{ path: 'purchaseUiOpened', expected: 99, actual: 1 }]);

for (const factory of [
  compareCreditLotSpendOrder,
  createCommerceConformanceBackend,
  createCommerceConformanceCapabilities,
  createCommerceConformanceClock,
  createCommerceConformanceJournal,
  createCommerceConformanceRuntime,
  createCommerceConformanceStore,
  createCommerceConformanceWallet,
  createCommerceConformanceWalletProvider,
]) {
  assert.equal(typeof factory, 'function');
}

console.info('Commerce conformance dist entrypoint passed.');
