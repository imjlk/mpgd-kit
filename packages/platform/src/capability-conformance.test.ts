import { describe, expect, it } from 'vitest';

import {
  runPlatformGatewayCapabilityConformance,
  type PlatformGatewayCapabilityConformanceFixture,
} from './capability-conformance';
import {
  createUnsupportedCapabilities,
  type PlatformCapabilities,
  type PlatformGateway,
} from './index';

describe('platform gateway capability conformance', () => {
  it('rejects an empty fixture set', rejectsEmptyFixtureSet);

  it('accepts fresh snapshots and observes provider transitions', acceptsFreshSnapshotsAndTransitions);

  it('rejects incomplete or unknown capability fields', rejectsMalformedSnapshots);

  it('rejects gateways that leak a shared capability object', rejectsSharedSnapshot);

  it('rejects a snapshot recycled after a provider transition', rejectsEarlierSnapshotAfterTransition);

  it('rejects duplicate fixture names', async () => {
    const fixture = createFixture(() => createUnsupportedCapabilities());

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture, fixture] }),
    ).rejects.toThrow('Duplicate platform capability conformance fixture: test-gateway.');
  });

  it('rejects empty fixture names', async () => {
    const fixture = {
      ...createFixture(() => createUnsupportedCapabilities()),
      name: ' ',
    };

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
    ).rejects.toThrow('Platform capability conformance fixture names must not be empty.');
  });
});

/**
 * @evidence docs/specs/platform-capability-snapshots.md#fixture-validation An empty fixture list is rejected before a gateway is read.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#fixture-validation #d566052 Verified the empty-input assertion and related fixture-name cases in this suite.
 */
export async function rejectsEmptyFixtureSet(): Promise<void> {
  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [] }),
  ).rejects.toThrow(
    'Platform gateway capability conformance requires at least one fixture.',
  );
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Exercises fresh boolean snapshots against expected values.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f83948b Verified that the fixture returns a new object on every read.
 * @evidence docs/specs/platform-capability-snapshots.md#provider-transitions Exercises a provider update and the expected post-update snapshot.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#provider-transitions #839c0c8 Verified that the fixture changes cloudSave and the runner rereads it.
 */
export async function acceptsFreshSnapshotsAndTransitions(): Promise<void> {
  let capabilities = createUnsupportedCapabilities();
  const fixture = createFixture(() => ({ ...capabilities }), {
    update() {
      capabilities = {
        ...capabilities,
        cloudSave: true,
      };
    },
    expectedCapabilities: {
      ...createUnsupportedCapabilities(),
      cloudSave: true,
    },
  });

  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
  ).resolves.toEqual({ passedFixtures: ['test-gateway'] });
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Rejects a provider that returns the same snapshot object twice.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f83948b Confirmed the runner rejects object reuse after its attempted mutation.
 */
export async function rejectsSharedSnapshot(): Promise<void> {
  const capabilities = Object.freeze(createUnsupportedCapabilities());
  const fixture = createFixture(() => capabilities);

  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
  ).rejects.toMatchObject({
    cause: { message: expect.stringContaining('getCapabilities must return a fresh snapshot') },
  });
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Rejects reuse of a non-adjacent snapshot object.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f83948b Verified the third read returns the first object after restoring its expected values.
 * @evidence docs/specs/platform-capability-snapshots.md#provider-transitions Covers identity reuse after an otherwise valid provider transition.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#provider-transitions #839c0c8 Checked the update changes cloudSave before the third read.
 */
export async function rejectsEarlierSnapshotAfterTransition(): Promise<void> {
  const first = { ...createUnsupportedCapabilities() };
  const second = { ...createUnsupportedCapabilities() };
  let reads = 0;
  const fixture = createFixture(
    () => {
      reads += 1;
      return reads === 2 ? second : first;
    },
    {
      update() {
        Object.assign(first, { nativeIap: false, cloudSave: true });
      },
      expectedCapabilities: { ...createUnsupportedCapabilities(), cloudSave: true },
    },
  );

  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining('must not reuse an earlier snapshot'),
    },
  });
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Rejects a missing required key and an unknown key.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f83948b Checked both malformed snapshots against the runner's shape guard.
 */
export async function rejectsMalformedSnapshots(): Promise<void> {
  const missing = { ...createUnsupportedCapabilities() };
  Reflect.deleteProperty(missing, 'nativeIap');
  const unknown = { ...createUnsupportedCapabilities(), unknownCapability: true };

  for (const capabilities of [missing, unknown]) {
    const fixture = createFixture(() => capabilities);
    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
    ).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining(
          'capability snapshots must contain all required keys and no unknown keys',
        ),
      },
    });
  }
}

function createFixture(
  getCapabilities: () => Promise<PlatformCapabilities> | PlatformCapabilities,
  transition?: PlatformGatewayCapabilityConformanceFixture['transition'],
): PlatformGatewayCapabilityConformanceFixture {
  const gateway: PlatformGateway = {
    target: 'browser',
    async getCapabilities() {
      return getCapabilities();
    },
    identity: {
      async getPlayer() {
        return null;
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        return { status: 'cancelled', entitlementIds: [] };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded() {
        return { status: 'unavailable', rewardGranted: false };
      },
    },
    leaderboard: {
      async submitScore() {
        return { submitted: false };
      },
      async open() {},
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  };

  return {
    name: 'test-gateway',
    gateway,
    expectedTarget: 'browser',
    expectedCapabilities: createUnsupportedCapabilities(),
    ...(transition === undefined ? {} : { transition }),
  };
}
