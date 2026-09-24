import type { PlatformCapabilities, PlatformGateway, PlatformTarget } from './index.js';

export const platformCapabilityKeys = Object.freeze([
  'nativeIap',
  'nativeAds',
  'rewardedAds',
  'interstitialAds',
  'nativeLeaderboard',
  'remoteLeaderboard',
  'achievements',
  'cloudSave',
  'socialShare',
  'haptics',
  'localizedContent',
] as const satisfies readonly (keyof PlatformCapabilities)[]);

export const optionalPlatformCapabilityKeys = Object.freeze([
  'bannerAds',
  'subscriptionIap',
] as const satisfies readonly (keyof PlatformCapabilities)[]);
const allowedPlatformCapabilityKeys = Object.freeze([
  ...platformCapabilityKeys,
  ...optionalPlatformCapabilityKeys,
] as const satisfies readonly (keyof PlatformCapabilities)[]);
const allowedPlatformCapabilityKeySet = new Set<keyof PlatformCapabilities>([
  ...allowedPlatformCapabilityKeys,
  'providerAvailability',
]);
const optionalPlatformCapabilityKeySet = new Set<keyof PlatformCapabilities>(
  optionalPlatformCapabilityKeys,
);

export interface PlatformGatewayCapabilityConformanceTransition {
  readonly update: () => Promise<void> | void;
  readonly expectedCapabilities: PlatformCapabilities;
}

export interface PlatformGatewayCapabilityConformanceFixture {
  readonly name: string;
  readonly gateway: PlatformGateway;
  readonly expectedTarget: PlatformTarget;
  readonly expectedCapabilities: PlatformCapabilities;
  /**
   * Optional provider transition used to prove that capability reads are live
   * rather than permanently cached by an adapter or target-config wrapper.
   */
  readonly transition?: PlatformGatewayCapabilityConformanceTransition;
}

export interface RunPlatformGatewayCapabilityConformanceInput {
  readonly fixtures: readonly PlatformGatewayCapabilityConformanceFixture[];
}

export interface PlatformGatewayCapabilityConformanceReport {
  readonly passedFixtures: readonly string[];
}

/**
 * Runs provider-neutral capability checks against real adapter gateways or
 * target-configured wrappers. Every read must return a complete boolean
 * snapshot, a fresh object, and the provider's latest state.
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Checks each gateway read against the required boolean keys and expected provider state.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #a1834db Reviewed required booleans, optional banner/subscription defaults, ordered readiness comparison, and fresh nested rereads.
 * @evidence docs/specs/platform-capability-snapshots.md#provider-transitions Checks a fresh provider read after the optional transition update.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#provider-transitions #839c0c8 Reviewed the changed-state guard and post-update snapshot assertion.
 * @evidence docs/specs/platform-capability-snapshots.md#fixture-validation Rejects invalid fixture sets and returns the names of passing fixtures.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#fixture-validation #d566052 Checked the nonempty and unique name guards and target assertion.
 */
export async function runPlatformGatewayCapabilityConformance(
  input: RunPlatformGatewayCapabilityConformanceInput,
): Promise<PlatformGatewayCapabilityConformanceReport> {
  if (input.fixtures.length === 0) {
    throw new Error('Platform gateway capability conformance requires at least one fixture.');
  }

  const fixtureNames = new Set<string>();
  const passedFixtures: string[] = [];

  for (const fixture of input.fixtures) {
    if (fixture.name.trim().length === 0) {
      throw new Error('Platform capability conformance fixture names must not be empty.');
    }

    if (fixtureNames.has(fixture.name)) {
      throw new Error(`Duplicate platform capability conformance fixture: ${fixture.name}.`);
    }

    fixtureNames.add(fixture.name);

    try {
      await runFixture(fixture);
    } catch (error) {
      throw new Error(`Platform gateway capability conformance failed: ${fixture.name}.`, {
        cause: error,
      });
    }

    passedFixtures.push(fixture.name);
  }

  return { passedFixtures };
}

async function runFixture(
  fixture: PlatformGatewayCapabilityConformanceFixture,
): Promise<void> {
  // A fixture may accidentally share its expected object with the provider.
  // Keep the oracle independent before tryMutateSnapshot probes isolation.
  const initialExpected = cloneExpectedCapabilities(fixture.expectedCapabilities);
  const transitionExpected = fixture.transition === undefined
    ? undefined
    : cloneExpectedCapabilities(fixture.transition.expectedCapabilities);
  assertEqual(
    fixture.gateway.target,
    fixture.expectedTarget,
    'gateway target must match the fixture target',
  );

  const first = await fixture.gateway.getCapabilities();
  assertCapabilitySnapshot(first, initialExpected);

  tryMutateSnapshot(first);

  const second = await fixture.gateway.getCapabilities();
  assert(second !== first, 'getCapabilities must return a fresh snapshot object for every read');
  assertCapabilitySnapshot(second, initialExpected);

  if (fixture.transition === undefined || transitionExpected === undefined) {
    return;
  }

  assert(
    hasCapabilityDifference(initialExpected, transitionExpected),
    'a transition fixture must change at least one capability',
  );

  await fixture.transition.update();

  const updated = await fixture.gateway.getCapabilities();
  assert(
    updated !== second,
    'getCapabilities must return a fresh snapshot after a provider transition',
  );
  assert(
    updated !== first,
    'getCapabilities must not reuse an earlier snapshot after a provider transition',
  );
  assertCapabilitySnapshot(updated, transitionExpected);
}

function assertCapabilitySnapshot(
  actual: PlatformCapabilities,
  expected: PlatformCapabilities,
): void {
  const actualKeys = Object.keys(actual).sort();
  const missingKeys = platformCapabilityKeys.filter((key) => !Object.hasOwn(actual, key));
  const unexpectedKeys = actualKeys.filter(
    (key) => !allowedPlatformCapabilityKeySet.has(key as keyof PlatformCapabilities),
  );

  assertEqual(
    JSON.stringify({ missingKeys, unexpectedKeys }),
    JSON.stringify({ missingKeys: [], unexpectedKeys: [] }),
    'capability snapshots must contain all required keys and no unknown keys',
  );

  for (const key of allowedPlatformCapabilityKeys) {
    const optional = optionalPlatformCapabilityKeySet.has(key);
    if (!optional || Object.hasOwn(actual, key)) {
      assertEqual(typeof actual[key], 'boolean', `capability ${key} must be a boolean`);
    }
    assertEqual(
      optional ? (actual[key] ?? false) : actual[key],
      optional ? (expected[key] ?? false) : expected[key],
      `capability ${key} must match the expected provider state`,
    );
  }
  assertEqual(
    normalizedAvailability(actual.providerAvailability),
    normalizedAvailability(expected.providerAvailability),
    'provider availability must match the expected provider state',
  );
}

function cloneExpectedCapabilities(value: PlatformCapabilities): PlatformCapabilities {
  return {
    ...value,
    ...(value.providerAvailability === undefined
      ? {}
      : { providerAvailability: { ...value.providerAvailability } }),
  };
}

function normalizedAvailability(value: PlatformCapabilities['providerAvailability']): string {
  return JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function tryMutateSnapshot(snapshot: PlatformCapabilities): void {
  try {
    Reflect.set(snapshot, 'nativeIap', !snapshot.nativeIap);
  } catch {
    // Frozen snapshots already satisfy the isolation requirement.
  }
  if (snapshot.providerAvailability !== undefined) {
    try {
      const next = snapshot.providerAvailability.nativeIap === 'available'
        ? 'unsupported'
        : 'available';
      Reflect.set(snapshot.providerAvailability, 'nativeIap', next);
    } catch {
      // A frozen nested readiness record already satisfies isolation.
    }
  }
}

function hasCapabilityDifference(
  first: PlatformCapabilities,
  second: PlatformCapabilities,
): boolean {
  return allowedPlatformCapabilityKeys
    .some((key) => (first[key] ?? false) !== (second[key] ?? false))
    || normalizedAvailability(first.providerAvailability)
      !== normalizedAvailability(second.providerAvailability);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, received ${String(actual)}.`);
  }
}
