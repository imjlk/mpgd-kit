import type { PlatformCapabilities, PlatformGateway, PlatformTarget } from './index.js';

export const platformCapabilityKeys = Object.freeze([
  'nativeIap',
  'nativeAds',
  'rewardedAds',
  'interstitialAds',
  'nativeLeaderboard',
  'achievements',
  'cloudSave',
  'socialShare',
  'haptics',
  'localizedContent',
] as const satisfies readonly (keyof PlatformCapabilities)[]);

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
  assertEqual(
    fixture.gateway.target,
    fixture.expectedTarget,
    'gateway target must match the fixture target',
  );

  const first = await fixture.gateway.getCapabilities();
  assertCapabilitySnapshot(first, fixture.expectedCapabilities);

  tryMutateSnapshot(first);

  const second = await fixture.gateway.getCapabilities();
  assert(second !== first, 'getCapabilities must return a fresh snapshot object for every read');
  assertCapabilitySnapshot(second, fixture.expectedCapabilities);

  if (fixture.transition === undefined) {
    return;
  }

  assert(
    hasCapabilityDifference(fixture.expectedCapabilities, fixture.transition.expectedCapabilities),
    'a transition fixture must change at least one capability',
  );

  await fixture.transition.update();

  const updated = await fixture.gateway.getCapabilities();
  assert(
    updated !== second,
    'getCapabilities must return a fresh snapshot after a provider transition',
  );
  assertCapabilitySnapshot(updated, fixture.transition.expectedCapabilities);
}

function assertCapabilitySnapshot(
  actual: PlatformCapabilities,
  expected: PlatformCapabilities,
): void {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...platformCapabilityKeys].sort();

  assertEqual(
    JSON.stringify(actualKeys),
    JSON.stringify(expectedKeys),
    'capability snapshots must contain exactly the public capability keys',
  );

  for (const key of platformCapabilityKeys) {
    assertEqual(typeof actual[key], 'boolean', `capability ${key} must be a boolean`);
    assertEqual(
      actual[key],
      expected[key],
      `capability ${key} must match the expected provider state`,
    );
  }
}

function tryMutateSnapshot(snapshot: PlatformCapabilities): void {
  try {
    Reflect.set(snapshot, 'nativeIap', !snapshot.nativeIap);
  } catch {
    // Frozen snapshots already satisfy the isolation requirement.
  }
}

function hasCapabilityDifference(
  first: PlatformCapabilities,
  second: PlatformCapabilities,
): boolean {
  return platformCapabilityKeys.some((key) => first[key] !== second[key]);
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
