import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import {
  commerceConformanceAdaptiveSkipReason,
  compareCreditLotSpendOrder,
  createCommerceConformanceBackend,
  createCommerceConformanceCapabilities,
  createCommerceConformanceClock,
  createCommerceConformanceJournal,
  createCommerceConformanceRuntime,
  createCommerceConformanceStore,
  createCommerceConformanceWallet,
  createCommerceConformanceWalletProvider,
  isAdaptiveCommerceConformanceVector,
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

assert.ok(results.every((result) => result.status === 'passed' && result.adaptive === undefined));

const altered = {
  ...vectors[0],
  expect: { ...vectors[0].expect, purchaseUiOpened: 99 },
};
const negative = await runCommerceConformanceVector(altered);
assert.equal(negative.passed, false);
assert.equal(negative.status, 'failed');
assert.deepEqual(negative.failures, [{ path: 'purchaseUiOpened', expected: 99, actual: 1 }]);

// Adaptive vectors against a caller-supplied provider that finishes on the server.
const adaptiveVectors = vectors.filter(isAdaptiveCommerceConformanceVector);
assert.equal(adaptiveVectors.length, 9);
const serverFinish = await runCommerceConformanceVectors(adaptiveVectors, {
  createProvider(context) {
    const store = createCommerceConformanceStore({
      ...context,
      profile: {
        ...context.profile,
        store: 'dist.server-finish',
        lifecycle: {
          availablePurchases: true, pending: true, restore: false, events: true, finish: 'server',
        },
        authority: { evidence: 'client-token', accountBinding: 'required' },
      },
    });
    return { provider: store.provider, store };
  },
});
assert.deepEqual(
  serverFinish.map((result) => [result.vector, result.status, result.reason]),
  [
    ['cancelled-and-failed', 'passed', undefined],
    ['event-before-listener', 'passed', undefined],
    [
      'finish-failure-retry',
      'skipped',
      "queueFinish scripts a client finish; the provider declares finish: 'server'",
    ],
    ['purchase-client-finish', 'skipped', "duplicate of purchase-server-finish for finish='server'"],
    ['purchase-host-finish', 'skipped', "duplicate of purchase-server-finish for finish='server'"],
    ['purchase-pending-then-purchased', 'passed', undefined],
    ['purchase-server-finish', 'passed', undefined],
    ['restart-before-verify', 'passed', undefined],
    ['revoked-after-grant', 'passed', undefined],
  ],
);
const adapted = serverFinish.find((result) => result.vector === 'restart-before-verify');
assert.equal(adapted.adaptive.finish, 'server');
assert.deepEqual(adapted.adaptive.expect.finishCalls, []);
assert.equal(adapted.adaptive.expect.verifyRequests.length, 2);
assert.equal(adapted.adaptive.expect.verifyRequests[0].store, 'dist.server-finish');
assert.equal(
  commerceConformanceAdaptiveSkipReason(adaptiveVectors[2], createCommerceConformanceCapabilities({
    store: 'x',
    lifecycle: { availablePurchases: true, pending: true, restore: true, events: true, finish: 'none' },
  })),
  "queueFinish scripts a client finish; the provider declares finish: 'none'",
);

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
