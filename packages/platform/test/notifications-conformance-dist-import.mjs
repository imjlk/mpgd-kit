import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { createUnsupportedNotificationCapabilities } from '@mpgd/platform/notifications';
import {
  createNotificationConformanceBackend,
  createNotificationConformanceClock,
  createNotificationConformanceHarness,
  createNotificationConformanceHost,
  createNotificationConformanceRuntime,
  notificationConformanceRegistryEntry,
  notificationConformanceSkipReason,
  runNotificationConformanceVector,
  runNotificationConformanceVectors,
} from '@mpgd/platform/notifications-conformance';
import { assertNotificationConformanceVector } from '@mpgd/platform/notifications-vectors';

const vectorsDir = new URL('../../../docs/specs/notifications/vectors/', import.meta.url);
const vectors = readdirSync(vectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => assertNotificationConformanceVector(
    JSON.parse(readFileSync(new URL(file, vectorsDir), 'utf8')),
  ));
assert.equal(vectors.length, 40);
const advertisingVector = vectors.find((vector) => vector.vector === 'advertising-needs-consent');
assert.ok(advertisingVector !== undefined);

const results = await runNotificationConformanceVectors(vectors);
assert.deepEqual(
  results.filter((result) => result.status !== 'passed')
    .map((result) => ({ vector: result.vector, reason: result.reason, failures: result.failures })),
  [],
);
assert.ok(results.every((result) => result.passed && result.failures.length === 0));

const altered = { ...advertisingVector, expect: { ...advertisingVector.expect, notices: [] } };
const negative = await runNotificationConformanceVector(altered);
assert.equal(negative.status, 'failed');
assert.equal(negative.passed, false);
assert.deepEqual(negative.failures, [{ path: 'notices.length', expected: 0, actual: 1 }]);

// A provider without notifications runs only the vector its capabilities satisfy.
const unsupported = await runNotificationConformanceVectors(vectors, {
  createProvider(context) {
    const host = createNotificationConformanceHost({
      profile: { ...context.profile, capabilities: createUnsupportedNotificationCapabilities() },
      catalog: context.catalog,
    });
    return { provider: host.provider, host };
  },
});
assert.deepEqual(
  unsupported.filter((result) => result.status === 'passed').map((result) => result.vector),
  ['unsupported-target'],
);
assert.equal(unsupported.filter((result) => result.status === 'skipped').length, 39);
assert.equal(
  notificationConformanceSkipReason(advertisingVector, createUnsupportedNotificationCapabilities()),
  'appliesTo remote.purposes includes "advertising"; the provider declares []',
);

for (const factory of [
  createNotificationConformanceBackend,
  createNotificationConformanceClock,
  createNotificationConformanceHarness,
  createNotificationConformanceHost,
  createNotificationConformanceRuntime,
  notificationConformanceRegistryEntry,
]) {
  assert.equal(typeof factory, 'function');
}

console.info('Notifications conformance dist entrypoint passed.');
