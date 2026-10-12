import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createUnsupportedCapabilities,
  PlatformOperationError,
  type PlatformCapabilities,
  type PlatformGateway,
  type PlatformProviderAvailability,
} from '@mpgd/platform';
import { runPlatformGatewayCapabilityConformance } from '@mpgd/platform/capability-conformance';
import type { NotificationCapabilities, NotificationProvider } from '@mpgd/platform/notifications';

import { createBrowserPlatformGateway } from '../../../adapters/browser/src/index';
import {
  getTargetConfig,
  normalizeTargetIntegrationConfig,
  withTargetAvailability,
  type IntegrationAvailabilityState,
  type TargetConfig,
  type TargetConfigMatrix,
} from '../src/runtime';

// Notifications v2 gating (notifications RFC "Capabilities"): the target config
// exposes `notificationsV2` exactly as it exposes the v1 adapter, and the
// snapshot then carries the provider's block with
// `providerAvailability.pushNotifications` equal to its availability.

const matrix = JSON.parse(
  readFileSync('packages/target-config/targets.json', 'utf8'),
) as TargetConfigMatrix;
const android = getTargetConfig(matrix, 'android');

const osCapabilities: NotificationCapabilities = {
  availability: 'available',
  permission: {
    scope: 'app',
    prompt: 'os',
    readable: true,
    serverReadable: false,
    allowance: 'persistent',
    userGesture: false,
    promptLimit: 2,
    settings: true,
  },
  remote: {
    supported: true,
    purposes: ['service', 'requested', 'advertising'],
    addressing: 'device',
    content: 'free-form',
  },
  local: { supported: true, maxPending: 64 },
  open: 'payload',
};

interface FakeProvider {
  readonly provider: NotificationProvider;
  /** Capability answers so far. */
  readonly reads: () => number;
  readonly answer: (next: () => Promise<unknown>) => void;
}

function createProvider(initial: NotificationCapabilities = osCapabilities): FakeProvider {
  // One shared object, as a careless provider would hand out.
  let read: () => Promise<unknown> = async () => initial;
  let reads = 0;
  const provider: NotificationProvider = {
    provider: 'fcm',
    async getCapabilities() {
      reads += 1;
      return (await read()) as NotificationCapabilities;
    },
    async getPermission() {
      return { app: 'granted', topics: {} };
    },
    async requestPermission() {
      return { snapshot: { app: 'granted', topics: {} }, outcomes: {} };
    },
    subscribe() {
      return () => {};
    },
  };
  return {
    provider,
    reads: () => reads,
    answer(next) {
      read = next;
    },
  };
}

function createGateway(
  notificationsV2: NotificationProvider,
  options: {
    readonly v1?: boolean;
    readonly snapshot?: Partial<PlatformCapabilities>;
  } = {},
): PlatformGateway {
  // The browser gateway's own v1 adapter is replaced (or left out) below.
  const { notifications: _browserNotifications, ...browser } = createBrowserPlatformGateway();
  return {
    ...browser,
    target: 'android',
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        // The v1 subscription provider's own readiness.
        providerAvailability: { pushNotifications: 'configuration-required' },
        ...options.snapshot,
      };
    },
    ...(options.v1 === false
      ? {}
      : {
          notifications: {
            getStatus: async () => 'not-subscribed' as const,
            requestSubscription: async () => 'subscribed' as const,
          },
        }),
    notificationsV2,
  };
}

function configWith(notifications: IntegrationAvailabilityState): TargetConfig {
  return {
    ...android,
    integrations: {
      ...normalizeTargetIntegrationConfig(android.integrations),
      notifications,
    },
  };
}

// Hidden: every state but `available` and `action-required` keeps v2 away,
// whatever the gateway's own snapshot says.
for (const state of [
  'unsupported',
  'disabled',
  'approval-required',
  'configuration-required',
  'temporarily-unavailable',
] as const satisfies readonly IntegrationAvailabilityState[]) {
  const fake = createProvider();
  const gateway = withTargetAvailability(
    createGateway(fake.provider, { snapshot: { notifications: osCapabilities } }),
    configWith(state),
  );
  assert.equal(gateway.notificationsV2, undefined, `${state} hides notificationsV2`);
  assert.equal(gateway.notifications, undefined, `${state} hides the v1 adapter too`);
  const capabilities = await gateway.getCapabilities();
  assert.equal('notifications' in capabilities, false, `${state} leaves the v2 block out`);
  assert.equal(
    capabilities.providerAvailability?.pushNotifications,
    'configuration-required',
    `${state} keeps the gateway's own readiness`,
  );
  const runtime = await gateway.getTargetRuntime();
  assert.equal('notifications' in runtime.capabilities, false, `${state} runtime has no v2 block`);
  assert.equal(fake.reads(), 0, `${state} never reads the hidden provider`);
}

// The shipped target matrix gates every target: Android, iOS, and Apps in Toss
// need configuration, Reddit needs approval, and the web targets have none.
const expectedTargetStates: Readonly<Record<string, IntegrationAvailabilityState>> = {
  android: 'configuration-required',
  ios: 'configuration-required',
  ait: 'configuration-required',
  reddit: 'approval-required',
  'web-preview': 'unsupported',
};
for (const [target, state] of Object.entries(expectedTargetStates)) {
  const config = getTargetConfig(matrix, target);
  assert.equal(
    normalizeTargetIntegrationConfig(config.integrations).notifications,
    state,
    `${target} declares notifications as ${state}`,
  );
  const gateway = withTargetAvailability(createGateway(createProvider().provider), config, {
    configTarget: target,
  });
  assert.equal(gateway.notificationsV2, undefined, `${target} hides notificationsV2`);
}
for (const [target, config] of Object.entries(matrix.targets)) {
  const state = normalizeTargetIntegrationConfig(config.integrations).notifications;
  const gateway = withTargetAvailability(createGateway(createProvider().provider), config, {
    configTarget: target,
  });
  assert.equal(
    gateway.notificationsV2 !== undefined,
    state === 'available' || state === 'action-required',
    `${target} gates notificationsV2 on its ${state} notifications state`,
  );
}

// Exposed: the provider itself, and a fresh, exact block from it.
for (const state of ['available', 'action-required'] as const) {
  const fake = createProvider();
  const gateway = withTargetAvailability(createGateway(fake.provider), configWith(state));
  assert.equal(gateway.notificationsV2, fake.provider, `${state} exposes the provider itself`);
  assert.notEqual(gateway.notifications, undefined, `${state} exposes the v1 adapter as before`);
  const first = await gateway.getCapabilities();
  assert.deepEqual(first.notifications, osCapabilities, `${state} reports the provider's block`);
  assert.equal(
    first.providerAvailability?.pushNotifications,
    'available',
    `${state} reports the v2 availability as the push readiness`,
  );
  const block = first.notifications;
  assert.ok(block !== undefined);
  assert.notEqual(block, osCapabilities, 'the block is a copy');
  assert.notEqual(block.permission, osCapabilities.permission, 'permission is a copy');
  assert.notEqual(block.remote, osCapabilities.remote, 'remote is a copy');
  assert.notEqual(block.remote.purposes, osCapabilities.remote.purposes, 'purposes are a copy');
  assert.notEqual(block.local, osCapabilities.local, 'local is a copy');
  Reflect.set(block.remote.purposes, 'length', 0);
  Reflect.set(block.permission, 'readable', false);
  const second = await gateway.getCapabilities();
  assert.notEqual(second.notifications, block, 'every read is a fresh block');
  assert.deepEqual(second.notifications, osCapabilities, 'a mutated read changes nothing later');
  assert.deepEqual(osCapabilities.remote.purposes, ['service', 'requested', 'advertising']);
}

// An optional count present as `undefined` stays out of the copy, so the
// snapshot keeps exact keys.
{
  const fake = createProvider();
  fake.answer(async () => ({
    ...osCapabilities,
    permission: { ...osCapabilities.permission, maxTopicsPerPrompt: undefined },
    local: { supported: true, maxPending: undefined },
  }));
  const gateway = withTargetAvailability(createGateway(fake.provider), configWith('available'));
  const block = (await gateway.getCapabilities()).notifications;
  assert.equal(block?.availability, 'available');
  assert.equal(block !== undefined && Object.hasOwn(block.permission, 'maxTopicsPerPrompt'), false);
  assert.equal(block !== undefined && Object.hasOwn(block.local, 'maxPending'), false);
  assert.equal(block?.permission.promptLimit, 2, 'a present count is kept');
}

// The integration state follows the v2 availability.
for (const availability of [
  'available',
  'action-required',
  'temporarily-unavailable',
  'configuration-required',
  'unsupported',
] as const satisfies readonly PlatformProviderAvailability[]) {
  const fake = createProvider({ ...osCapabilities, availability });
  const gateway = withTargetAvailability(createGateway(fake.provider), configWith('available'));
  const capabilities = await gateway.getCapabilities();
  assert.equal(capabilities.notifications?.availability, availability);
  assert.equal(capabilities.providerAvailability?.pushNotifications, availability);
  const runtime = await gateway.getTargetRuntime();
  assert.equal(
    runtime.integrations.notifications.state,
    availability === 'available' ? 'available' : availability,
    `a provider reporting ${availability} sets the notifications integration state`,
  );
  assert.equal(runtime.capabilities.notifications?.availability, availability);
}

// A provider that fails, stalls, or answers outside the contract degrades the
// block instead of rejecting or stalling the capability read.
const degraded: readonly (readonly [string, () => Promise<unknown>, PlatformProviderAvailability])[] = [
  [
    'a transport without v2',
    async () => {
      throw new PlatformOperationError({ code: 'NOTIFICATIONS_V2_UNAVAILABLE' });
    },
    'unsupported',
  ],
  [
    'an unimplemented method',
    async () => {
      throw Object.assign(new Error('bridge'), { code: 'NOTIFICATIONS_UNSUPPORTED' });
    },
    'unsupported',
  ],
  [
    'a missing configuration',
    async () => {
      throw new PlatformOperationError({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    },
    'configuration-required',
  ],
  [
    'a passing failure',
    async () => {
      throw new PlatformOperationError({
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        retryable: true,
      });
    },
    'temporarily-unavailable',
  ],
  ['a thrown value', async () => Promise.reject('offline'), 'temporarily-unavailable'],
  ['an unknown key', async () => ({ ...osCapabilities, extra: true }), 'temporarily-unavailable'],
  [
    "remote addressing 'none' with remote delivery",
    async () => ({ ...osCapabilities, remote: { ...osCapabilities.remote, addressing: 'none' } }),
    'temporarily-unavailable',
  ],
  [
    'a zero prompt limit',
    async () => ({
      ...osCapabilities,
      permission: { ...osCapabilities.permission, promptLimit: 0 },
    }),
    'temporarily-unavailable',
  ],
  ['no block', async () => undefined, 'temporarily-unavailable'],
];
for (const [name, answer, availability] of degraded) {
  const fake = createProvider();
  fake.answer(answer);
  const gateway = withTargetAvailability(createGateway(fake.provider), configWith('available'));
  const capabilities = await gateway.getCapabilities();
  assert.deepEqual(
    capabilities.notifications,
    {
      availability,
      permission: {
        scope: 'app',
        prompt: 'os',
        readable: true,
        serverReadable: false,
        allowance: 'persistent',
        userGesture: false,
        settings: false,
      },
      remote: { supported: false, purposes: [], addressing: 'none', content: 'free-form' },
      local: { supported: false },
      open: 'none',
    },
    `${name} degrades the block to ${availability}`,
  );
  assert.equal(capabilities.providerAvailability?.pushNotifications, availability, name);
}

// A provider that never answers is bounded, like the Capacitor commerce read.
{
  const fake = createProvider();
  fake.answer(() => new Promise<never>(() => {}));
  const gateway = withTargetAvailability(createGateway(fake.provider), configWith('available'));
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  // Fire the bound at once instead of waiting it out.
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    return originalSetTimeout(callback, 0);
  }) as unknown as typeof setTimeout;
  try {
    const capabilities = await gateway.getCapabilities();
    assert.equal(capabilities.notifications?.availability, 'temporarily-unavailable');
    assert.equal(capabilities.providerAvailability?.pushNotifications, 'temporarily-unavailable');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.deepEqual(delays, [3_000], 'the read is bounded at three seconds');
}

// A gateway with only the v2 provider counts as supporting notifications.
{
  const fake = createProvider();
  const gateway = withTargetAvailability(
    createGateway(fake.provider, { v1: false }),
    configWith('available'),
  );
  assert.equal(gateway.notificationsV2, fake.provider);
  assert.equal(gateway.notifications, undefined);
  const runtime = await gateway.getTargetRuntime();
  assert.equal(runtime.integrations.notifications.adapterSupported, true);
  assert.equal(runtime.integrations.notifications.state, 'available');
}

// A partial v1 adapter stays hidden while v2 alone makes the integration callable.
{
  const fake = createProvider();
  const partial = {
    ...createGateway(fake.provider, { v1: false }),
    notifications: { getStatus: async () => 'not-subscribed' as const },
  } as unknown as PlatformGateway;
  const gateway = withTargetAvailability(partial, configWith('available'));
  assert.equal(gateway.notificationsV2, fake.provider);
  assert.equal(gateway.notifications, undefined);
}

// The wrapped snapshot passes the capability conformance runner, including a
// provider transition.
{
  const fake = createProvider();
  let availability: PlatformProviderAvailability = 'available';
  fake.answer(async () => ({ ...osCapabilities, availability }));
  const gateway = withTargetAvailability(createGateway(fake.provider), configWith('available'));
  const expected = (state: PlatformProviderAvailability): PlatformCapabilities => ({
    ...createUnsupportedCapabilities(),
    providerAvailability: { pushNotifications: state },
    notifications: { ...osCapabilities, availability: state },
  });
  const report = await runPlatformGatewayCapabilityConformance({
    fixtures: [
      {
        name: 'android:notifications-v2',
        gateway,
        expectedTarget: 'android',
        expectedCapabilities: expected('available'),
        transition: {
          update() {
            availability = 'action-required';
          },
          expectedCapabilities: expected('action-required'),
        },
      },
    ],
  });
  assert.deepEqual(report.passedFixtures, ['android:notifications-v2']);
}

console.log('Notifications v2 target-config gating smoke passed.');
