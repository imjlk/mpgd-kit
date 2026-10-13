import type {
  CommerceCapabilities,
  PlatformCapabilities,
  PlatformGateway,
  PlatformProviderAvailability,
  PlatformProviderFeature,
  PlatformTarget,
} from './index.js';
import type { NotificationCapabilities } from './notifications-contract.js';

export const platformCapabilityKeys = Object.freeze([
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
] as const satisfies readonly (keyof PlatformCapabilities)[]);
const allowedPlatformCapabilityKeys = Object.freeze([
  ...platformCapabilityKeys,
  ...optionalPlatformCapabilityKeys,
] as const satisfies readonly (keyof PlatformCapabilities)[]);
const allowedPlatformCapabilityKeySet = new Set<keyof PlatformCapabilities>([
  ...allowedPlatformCapabilityKeys,
  'providerAvailability',
  'commerce',
  'notifications',
]);
const optionalPlatformCapabilityKeySet = new Set<keyof PlatformCapabilities>(
  optionalPlatformCapabilityKeys,
);
const providerFeatureSet = new Set<PlatformProviderFeature>([
  'rewardedAds',
  'interstitialAds',
  'bannerAds',
  'nativeLeaderboard',
  'identityUpgrade',
  'pushNotifications',
]);
const providerAvailabilitySet = new Set<PlatformProviderAvailability>([
  'unsupported',
  'configuration-required',
  'action-required',
  'temporarily-unavailable',
  'available',
]);
// The commerce block follows the same rules as the boolean snapshot: exact
// keys, typed values, and a fresh object on every read.
const commerceCapabilityBlockKeys = Object.freeze({
  purchase: ['consumable', 'durable', 'subscription', 'quantity'],
  catalog: ['products', 'offers', 'localizedPrice'],
  lifecycle: ['availablePurchases', 'pending', 'restore', 'events', 'finish'],
  authority: ['evidence', 'accountBinding'],
} as const);
const commerceCapabilityEnums = Object.freeze({
  'lifecycle.finish': ['client', 'server', 'host', 'none'],
  'authority.evidence': ['client-token', 'host-callback', 'adapter-settled', 'server-push'],
  'authority.accountBinding': ['required', 'optional', 'host'],
} as const);
// The optional notifications v2 block follows the same rules. Each nested
// field is a boolean, one of the listed values, or an optional positive
// integer; `remote.purposes` is a list of known purposes.
type NotificationCapabilityField =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'count' }
  | { readonly kind: 'purposes' };
const notificationCapabilityFields: Readonly<Record<
  'permission' | 'remote' | 'local',
  Readonly<Record<string, NotificationCapabilityField & { readonly optional?: true }>>
>> = Object.freeze({
  permission: {
    scope: { kind: 'enum', values: ['app', 'topic'] },
    prompt: { kind: 'enum', values: ['os', 'host', 'game'] },
    readable: { kind: 'boolean' },
    serverReadable: { kind: 'boolean' },
    allowance: { kind: 'enum', values: ['persistent', 'per-send'] },
    userGesture: { kind: 'boolean' },
    promptLimit: { kind: 'count', optional: true },
    maxTopicsPerPrompt: { kind: 'count', optional: true },
    settings: { kind: 'boolean' },
  },
  remote: {
    supported: { kind: 'boolean' },
    purposes: { kind: 'purposes' },
    addressing: { kind: 'enum', values: ['device', 'platform-user', 'none'] },
    content: { kind: 'enum', values: ['free-form', 'host-template'] },
  },
  local: {
    supported: { kind: 'boolean' },
    maxPending: { kind: 'count', optional: true },
  },
});
const notificationPurposes: readonly string[] = ['service', 'requested', 'advertising'];
const notificationOpenPaths: readonly string[] = ['payload', 'landing-url', 'host-link', 'none'];

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
 * target-configured wrappers. Every read must return every required boolean
 * key, known readiness states, the commerce and notifications blocks under
 * their own rules, a fresh object, and the provider's latest state.
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Checks each gateway read against the required boolean keys and expected provider state.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f566c58 Reviewed required booleans, the required commerce block, the optional banner default, ordered readiness comparison, and fresh nested rereads, including notification identity and dense purpose checks.
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
  assertCapabilitySnapshot(first, initialExpected, fixture.gateway);

  tryMutateSnapshot(first);

  const second = await fixture.gateway.getCapabilities();
  assert(second !== first, 'getCapabilities must return a fresh snapshot object for every read');
  assertCapabilitySnapshot(second, initialExpected, fixture.gateway);
  assertNotificationSnapshotFreshness(first, second);

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
  assertCapabilitySnapshot(updated, transitionExpected, fixture.gateway);
  assertNotificationSnapshotFreshness(first, updated);
  assertNotificationSnapshotFreshness(second, updated);
}

function assertNotificationSnapshotFreshness(
  previous: PlatformCapabilities,
  next: PlatformCapabilities,
): void {
  const first = previous.notifications;
  const second = next.notifications;
  if (first === undefined || second === undefined) {
    return;
  }
  assert(second !== first, 'notification capabilities must return a fresh block for every read');
  for (const key of ['permission', 'remote', 'local'] as const) {
    assert(
      second[key] !== first[key],
      `notification capabilities must return a fresh ${key} record`,
    );
  }
  assert(
    second.remote.purposes !== first.remote.purposes,
    'notification capabilities must return a fresh purposes list',
  );
}

function assertCapabilitySnapshot(
  actual: PlatformCapabilities,
  expected: PlatformCapabilities,
  gateway: PlatformGateway,
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
  assertProviderAvailabilityShape(actual.providerAvailability);
  assertEqual(
    normalizedAvailability(actual.providerAvailability),
    normalizedAvailability(expected.providerAvailability),
    'provider availability must match the expected provider state',
  );
  assertCommerceCapabilityBlock(actual, expected.commerce);
  assertNotificationCapabilityBlock(actual, expected.notifications, gateway);
}

function assertNotificationCapabilityBlock(
  snapshot: PlatformCapabilities,
  expected: NotificationCapabilities | undefined,
  gateway: PlatformGateway,
): void {
  const actual: unknown = snapshot.notifications;
  // The block describes the exposed provider (notifications RFC "Capabilities").
  assertEqual(
    actual !== undefined,
    gateway.notificationsV2 !== undefined,
    'notification capabilities must be present exactly when the gateway exposes notificationsV2',
  );
  if (actual === undefined) {
    assert(
      expected === undefined,
      'notification capabilities must be present when the fixture expects them',
    );
    return;
  }
  assert(
    expected !== undefined,
    'notification capabilities must be absent when the fixture omits them',
  );
  assert(isPlainRecord(actual), 'notification capabilities must be a non-array record');
  assertEqual(
    JSON.stringify(Object.keys(actual).sort()),
    JSON.stringify(['availability', 'local', 'open', 'permission', 'remote']),
    'notification capabilities must contain exactly availability, permission, remote, local, and open',
  );
  for (const [group, fields] of Object.entries(notificationCapabilityFields)) {
    const nested = actual[group];
    assert(isPlainRecord(nested), `notification ${group} capabilities must be a non-array record`);
    const unknownKeys = Object.keys(nested).filter((key) => !Object.hasOwn(fields, key));
    assertEqual(
      JSON.stringify(unknownKeys),
      '[]',
      `notification ${group} capabilities must contain no unknown keys`,
    );
    for (const [key, field] of Object.entries(fields)) {
      const path = `${group}.${key}`;
      if (!Object.hasOwn(nested, key)) {
        assert(field.optional === true, `notification capability ${path} is required`);
        continue;
      }
      assertNotificationCapabilityField(path, field, nested[key]);
    }
  }
  assert(
    providerAvailabilitySet.has(actual.availability as PlatformProviderAvailability),
    'notification availability must be a known readiness state',
  );
  assert(
    notificationOpenPaths.includes(actual.open as string),
    `notification open must be one of ${notificationOpenPaths.join(', ')}`,
  );
  const block = actual as unknown as NotificationCapabilities;
  assertEqual(
    block.remote.supported,
    block.remote.addressing !== 'none',
    "notification remote.addressing must be 'none' exactly when remote.supported is false",
  );
  assertEqual(
    normalizedNotifications(block),
    normalizedNotifications(expected),
    'notification capabilities must match the expected provider state',
  );
  assertEqual(
    snapshot.providerAvailability?.pushNotifications,
    block.availability,
    'providerAvailability.pushNotifications must equal the notification capabilities availability',
  );
}

function assertNotificationCapabilityField(
  path: string,
  field: NotificationCapabilityField,
  value: unknown,
): void {
  switch (field.kind) {
    case 'boolean':
      assertEqual(typeof value, 'boolean', `notification capability ${path} must be a boolean`);
      return;
    case 'enum':
      assert(
        field.values.includes(value as string),
        `notification capability ${path} must be one of ${field.values.join(', ')}`,
      );
      return;
    case 'count':
      assert(
        Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0xffff_ffff,
        `notification capability ${path} must be a positive integer`,
      );
      return;
    case 'purposes':
      assert(
        isDenseNotificationPurposeList(value),
        `notification capability ${path} must list only ${notificationPurposes.join(', ')}`,
      );
      return;
  }
}

function isDenseNotificationPurposeList(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !notificationPurposes.includes(value[index] as string)) {
      return false;
    }
  }
  return true;
}

function normalizedNotifications(value: NotificationCapabilities | undefined): string {
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify([
    ['availability', value.availability],
    ['permission', sortedEntries(value.permission)],
    ['remote', sortedEntries({ ...value.remote, purposes: [...value.remote.purposes].sort() })],
    ['local', sortedEntries(value.local)],
    ['open', value.open],
  ]);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCommerceCapabilityBlock(
  snapshot: PlatformCapabilities,
  expected: CommerceCapabilities,
): void {
  const actual: unknown = snapshot.commerce;
  assert(
    actual !== undefined,
    'commerce capabilities are required: a gateway without a commerce provider reports createUnsupportedCommerceCapabilities()',
  );
  assert(
    typeof actual === 'object' && actual !== null && !Array.isArray(actual),
    'commerce capabilities must be a non-array record',
  );
  const block = actual as Readonly<Record<string, unknown>>;
  const blockKeys = Object.keys(block).sort();
  assertEqual(
    JSON.stringify(blockKeys),
    JSON.stringify([...Object.keys(commerceCapabilityBlockKeys), 'availability'].sort()),
    'commerce capabilities must contain exactly purchase, catalog, lifecycle, authority, and availability',
  );
  for (const [group, keys] of Object.entries(commerceCapabilityBlockKeys)) {
    const nested = block[group];
    assert(
      typeof nested === 'object' && nested !== null && !Array.isArray(nested),
      `commerce ${group} capabilities must be a non-array record`,
    );
    const record = nested as Readonly<Record<string, unknown>>;
    assertEqual(
      JSON.stringify(Object.keys(record).sort()),
      JSON.stringify([...keys].sort()),
      `commerce ${group} capabilities must contain exactly ${keys.join(', ')}`,
    );
    for (const key of keys) {
      const path = `${group}.${key}` as keyof typeof commerceCapabilityEnums;
      const allowed = commerceCapabilityEnums[path] as readonly string[] | undefined;
      if (allowed === undefined) {
        assertEqual(typeof record[key], 'boolean', `commerce capability ${path} must be a boolean`);
      } else {
        assert(
          allowed.includes(record[key] as string),
          `commerce capability ${path} must be one of ${allowed.join(', ')}`,
        );
      }
    }
  }
  assert(
    providerAvailabilitySet.has(block.availability as PlatformProviderAvailability),
    'commerce availability must be a known readiness state',
  );
  assertEqual(
    normalizedCommerce(block as unknown as CommerceCapabilities),
    normalizedCommerce(expected),
    'commerce capabilities must match the expected provider state',
  );
}

function normalizedCommerce(value: CommerceCapabilities | undefined): string {
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify([
    ['purchase', sortedEntries(value.purchase)],
    ['catalog', sortedEntries(value.catalog)],
    ['lifecycle', sortedEntries(value.lifecycle)],
    ['authority', sortedEntries(value.authority)],
    ['availability', value.availability],
  ]);
}

function sortedEntries(value: object): readonly (readonly [string, unknown])[] {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

function assertProviderAvailabilityShape(value: unknown): void {
  if (value === undefined) {
    return;
  }
  assert(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'provider availability must be a non-array record',
  );
  for (const [feature, state] of Object.entries(value)) {
    assert(
      providerFeatureSet.has(feature as PlatformProviderFeature)
        && providerAvailabilitySet.has(state as PlatformProviderAvailability),
      'provider availability must contain only known features and readiness states',
    );
  }
}

// A deep copy of the plain records and lists, whatever their shape: the
// oracle stays independent of the provider even when a fixture expects a
// malformed block to be reported as is.
function cloneExpectedCapabilities(value: PlatformCapabilities): PlatformCapabilities {
  return clonePlainData(value);
}

function clonePlainData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => clonePlainData(entry)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clonePlainData(entry)]),
    ) as T;
  }
  return value;
}

function normalizedAvailability(value: PlatformCapabilities['providerAvailability']): string {
  return JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function tryMutateSnapshot(snapshot: PlatformCapabilities): void {
  try {
    Reflect.set(snapshot, 'nativeAds', !snapshot.nativeAds);
  } catch {
    // Frozen snapshots already satisfy the isolation requirement.
  }
  if (snapshot.providerAvailability !== undefined) {
    try {
      const next = snapshot.providerAvailability.rewardedAds === 'available'
        ? 'unsupported'
        : 'available';
      Reflect.set(snapshot.providerAvailability, 'rewardedAds', next);
    } catch {
      // A frozen nested readiness record already satisfies isolation.
    }
  }
  if (snapshot.commerce !== undefined) {
    tryMutateCommerceSnapshot(snapshot.commerce);
  }
  if (snapshot.notifications !== undefined) {
    tryMutateNotificationSnapshot(snapshot.notifications);
  }
}

// Every nested record and the purposes list are probed, as for commerce.
function tryMutateNotificationSnapshot(notifications: NotificationCapabilities): void {
  const { purposes } = notifications.remote;
  const probes: readonly (readonly [object, string, unknown])[] = [
    [notifications.permission, 'readable', !notifications.permission.readable],
    [
      notifications.remote,
      'content',
      notifications.remote.content === 'free-form' ? 'host-template' : 'free-form',
    ],
    // A reused list shows on the next read: emptied when it lists purposes,
    // or holding one when it was empty.
    purposes.length === 0 ? [purposes, '0', 'service'] : [purposes, 'length', 0],
    [notifications.local, 'supported', !notifications.local.supported],
    [
      notifications,
      'availability',
      notifications.availability === 'available' ? 'unsupported' : 'available',
    ],
    [notifications, 'open', notifications.open === 'none' ? 'payload' : 'none'],
  ];
  for (const [target, key, next] of probes) {
    try {
      Reflect.set(target, key, next);
    } catch {
      // Frozen values still need distinct references, checked across snapshots.
    }
  }
}

// Every nested block is probed: a gateway may rebuild the outer object while
// reusing one mutable nested record across reads.
function tryMutateCommerceSnapshot(commerce: CommerceCapabilities): void {
  const probes: readonly (readonly [object, string, unknown])[] = [
    [commerce.purchase, 'consumable', !commerce.purchase.consumable],
    [commerce.catalog, 'products', !commerce.catalog.products],
    [commerce.lifecycle, 'events', !commerce.lifecycle.events],
    [
      commerce.authority,
      'accountBinding',
      commerce.authority.accountBinding === 'host' ? 'optional' : 'host',
    ],
    [commerce, 'availability', commerce.availability === 'available' ? 'unsupported' : 'available'],
  ];
  for (const [target, key, next] of probes) {
    try {
      Reflect.set(target, key, next);
    } catch {
      // A frozen nested commerce block already satisfies isolation.
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
      !== normalizedAvailability(second.providerAvailability)
    || normalizedCommerce(first.commerce) !== normalizedCommerce(second.commerce)
    || normalizedNotifications(first.notifications)
      !== normalizedNotifications(second.notifications);
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
