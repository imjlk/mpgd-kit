import { describe, expect, it } from 'vitest';

import {
  runPlatformGatewayCapabilityConformance,
  type PlatformGatewayCapabilityConformanceFixture,
} from './capability-conformance';
import { createUnsupportedCommerceCapabilities, type CommerceCapabilities } from './commerce';
import {
  createUnsupportedCapabilities,
  type PlatformCapabilities,
  type PlatformGateway,
} from './index';

describe('platform gateway capability conformance', () => {
  it('rejects an empty fixture set', rejectsEmptyFixtureSet);

  it('accepts fresh snapshots and observes provider transitions', acceptsFreshSnapshotsAndTransitions);

  it('rejects incomplete or unknown capability fields', rejectsMalformedSnapshots);

  it.each([
    [],
    '',
    null,
    { unknownFeature: 'available' },
    { rewardedAds: 'ready' },
  ])('rejects malformed provider availability %j', async (providerAvailability) => {
    const fixture = createFixture(() => ({
      ...createUnsupportedCapabilities(),
      providerAvailability: providerAvailability as NonNullable<
        PlatformCapabilities['providerAvailability']
      >,
    }));
    await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
      .rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
  });

  it('rejects gateways that leak a shared capability object', rejectsSharedSnapshot);

  it('rejects a provider mutation hidden by an aliased fixture expectation', rejectsAliasedExpectation);

  it('rejects a snapshot recycled after a provider transition', rejectsEarlierSnapshotAfterTransition);

  it('rejects duplicate fixture names', async () => {
    const fixture = createFixture(() => createUnsupportedCapabilities());

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture, fixture] }),
    ).rejects.toThrow('Duplicate platform capability conformance fixture: test-gateway.');
  });

  it('accepts transitions that only change provider readiness', async () => {
    let readiness: 'configuration-required' | 'temporarily-unavailable' = 'configuration-required';
    const base = createUnsupportedCapabilities();
    const fixture = {
      ...createFixture(() => ({
        ...fresh(base),
        providerAvailability: { rewardedAds: readiness },
      }), {
        update() { readiness = 'temporarily-unavailable'; },
        expectedCapabilities: {
          ...base,
          providerAvailability: { rewardedAds: 'temporarily-unavailable' },
        },
      }),
      expectedCapabilities: {
        ...base,
        providerAvailability: { rewardedAds: 'configuration-required' as const },
      },
    };
    await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
      .resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it('rejects a provider-owned readiness record shared across snapshots', async () => {
    const readiness = { rewardedAds: 'unsupported' as const };
    const base = createUnsupportedCapabilities();
    const fixture = {
      ...createFixture(() => ({ ...fresh(base), providerAvailability: readiness })),
      expectedCapabilities: {
        ...base,
        providerAvailability: { rewardedAds: 'unsupported' as const },
      },
    };
    await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
      .rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
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

  it('accepts a fresh commerce block that matches the expected provider state', async () => {
    const expected = withCommerce(createAvailableCommerce());
    const fixture = createFixture(() => withCommerce(createAvailableCommerce()));
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...fixture, expectedCapabilities: expected }],
    })).resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it('observes a transition that only changes the commerce block', async () => {
    let finish: CommerceCapabilities['lifecycle']['finish'] = 'client';
    const snapshot = () => withCommerce({
      ...createAvailableCommerce(),
      lifecycle: { ...createAvailableCommerce().lifecycle, finish },
    });
    const fixture = createFixture(snapshot, {
      update() {
        finish = 'server';
      },
      expectedCapabilities: withCommerce({
        ...createAvailableCommerce(),
        lifecycle: { ...createAvailableCommerce().lifecycle, finish: 'server' },
      }),
    });
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...fixture, expectedCapabilities: snapshot() }],
    })).resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it.each([
    ['a shared nested commerce object', (shared: CommerceCapabilities) => shared],
    ['a shared purchase block', (shared: CommerceCapabilities) => sharingOnly(shared, 'purchase')],
    ['a shared catalog block', (shared: CommerceCapabilities) => sharingOnly(shared, 'catalog')],
    ['a shared lifecycle block', (shared: CommerceCapabilities) => sharingOnly(shared, 'lifecycle')],
    ['a shared authority block', (shared: CommerceCapabilities) => sharingOnly(shared, 'authority')],
  ])('rejects %s across reads', async (_name, read) => {
    const shared = createAvailableCommerce();
    const fixture = createFixture(() => withCommerce(read(shared)));
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...fixture, expectedCapabilities: withCommerce(createAvailableCommerce()) }],
    })).rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
  });

  it.each([
    ['an unknown commerce key', { ...createAvailableCommerce(), bundles: true }],
    ['an unknown purchase key', {
      ...createAvailableCommerce(),
      purchase: { ...createAvailableCommerce().purchase, gifting: false },
    }],
    ['a missing lifecycle key', {
      ...createAvailableCommerce(),
      lifecycle: { availablePurchases: true, pending: true, restore: true, events: true },
    }],
    ['a non-boolean flag', {
      ...createAvailableCommerce(),
      catalog: { products: 'yes', offers: false, localizedPrice: false },
    }],
    ['an unknown finish owner', {
      ...createAvailableCommerce(),
      lifecycle: { ...createAvailableCommerce().lifecycle, finish: 'backend' },
    }],
    ['an unknown readiness state', { ...createAvailableCommerce(), availability: 'ready' }],
    ['an array', []],
  ])('rejects %s in the commerce block', async (_name, commerce) => {
    const fixture = createFixture(() => withCommerce(commerce as CommerceCapabilities));
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...fixture, expectedCapabilities: withCommerce(createAvailableCommerce()) }],
    })).rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
  });

  it('requires the commerce block: a snapshot without it fails, never defaults to unsupported', async () => {
    const withoutBlock = (): PlatformCapabilities => {
      const snapshot = { ...createUnsupportedCapabilities() };
      Reflect.deleteProperty(snapshot, 'commerce');
      return snapshot;
    };
    const fixture = createFixture(withoutBlock);
    await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
      .rejects.toMatchObject({
        cause: { message: expect.stringContaining('commerce capabilities are required') },
      });
  });

  it('rejects a commerce block that differs from the one the fixture expects', async () => {
    const present = createFixture(() => withCommerce(createAvailableCommerce()));
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...present, expectedCapabilities: createUnsupportedCapabilities() }],
    })).rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
    const absent = createFixture(() => createUnsupportedCapabilities());
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...absent, expectedCapabilities: withCommerce(createAvailableCommerce()) }],
    })).rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
  });
});

/** A fresh commerce block that reuses exactly one nested record from `shared`. */
function sharingOnly(
  shared: CommerceCapabilities,
  block: 'purchase' | 'catalog' | 'lifecycle' | 'authority',
): CommerceCapabilities {
  return {
    purchase: block === 'purchase' ? shared.purchase : { ...shared.purchase },
    catalog: block === 'catalog' ? shared.catalog : { ...shared.catalog },
    lifecycle: block === 'lifecycle' ? shared.lifecycle : { ...shared.lifecycle },
    authority: block === 'authority' ? shared.authority : { ...shared.authority },
    availability: shared.availability,
  };
}

function createAvailableCommerce(): CommerceCapabilities {
  return {
    ...createUnsupportedCommerceCapabilities(),
    purchase: { consumable: true, durable: true, subscription: false, quantity: false },
    availability: 'available',
  };
}

/** A copy that shares no nested record, as a conforming gateway returns on every read. */
function fresh(value: PlatformCapabilities): PlatformCapabilities {
  return {
    ...value,
    ...(value.providerAvailability === undefined
      ? {}
      : { providerAvailability: { ...value.providerAvailability } }),
    commerce: {
      purchase: { ...value.commerce.purchase },
      catalog: { ...value.commerce.catalog },
      lifecycle: { ...value.commerce.lifecycle },
      authority: { ...value.commerce.authority },
      availability: value.commerce.availability,
    },
  };
}

function withCommerce(commerce: CommerceCapabilities): PlatformCapabilities {
  return {
    ...createUnsupportedCapabilities(),
    commerce,
  };
}

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
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f566c58 Verified that the fixture returns a new object on every read, including optional readiness handling.
 * @evidence docs/specs/platform-capability-snapshots.md#provider-transitions Exercises a provider update and the expected post-update snapshot.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#provider-transitions #839c0c8 Verified that the fixture changes cloudSave and the runner rereads it.
 */
export async function acceptsFreshSnapshotsAndTransitions(): Promise<void> {
  let capabilities = createUnsupportedCapabilities();
  const fixture = createFixture(() => fresh(capabilities), {
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
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f566c58 Confirmed the runner rejects object reuse after its attempted mutation, including nested readiness records.
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
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Ensures the expected state cannot move with a provider-owned snapshot.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f566c58 Compared first and second reads against a detached expectation after mutation.
 */
export async function rejectsAliasedExpectation(): Promise<void> {
  const expected = { ...createUnsupportedCapabilities() };
  let reads = 0;
  const fixture = {
    ...createFixture(() => {
      reads += 1;
      return reads === 1 ? expected : fresh(expected);
    }),
    expectedCapabilities: expected,
  };

  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining('capability nativeAds must match the expected provider state'),
    },
  });
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Rejects reuse of a non-adjacent snapshot object.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f566c58 Verified reuse of the first top-level object after a transition remains invalid.
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
        Object.assign(first, { cloudSave: true });
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
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f566c58 Checked missing and unknown top-level fields against the runner's shape guard.
 */
export async function rejectsMalformedSnapshots(): Promise<void> {
  const missing = { ...createUnsupportedCapabilities() };
  Reflect.deleteProperty(missing, 'nativeAds');
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
