import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bridgeNotificationsV2Methods,
  bridgeStorageLoadProtocol,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import {
  createUnsupportedCapabilities,
  PlatformOperationError,
  type PlatformProviderAvailability,
} from '@mpgd/platform';
import { createUnsupportedCommerceCapabilities } from '@mpgd/platform/commerce';
import { runPlatformGatewayCapabilityConformance } from '@mpgd/platform/capability-conformance';
import {
  createUnsupportedNotificationCapabilities,
  NotificationError,
  type NotificationEvent,
  type NotificationProvider,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import { createFakeNotificationSdks } from '../test/notifications-sdk-fixture.js';
import type { CapacitorAppEventsApi } from './app-events.js';
import { createCapacitorPlatformGateway } from './index.js';
import {
  createBridgeNotificationProvider,
  createNotificationProviderBridge,
  createNotificationServiceProvider,
} from './notifications-bridge.js';
import { createCapacitorNotificationProvider } from './notifications-provider.js';
import { createCapacitorNotificationServiceProvider } from './notifications.js';
import {
  assertProviderResponseData,
  createCapacitorProviderRegistry,
  createDegradedNotificationCapabilities,
  type CapacitorServiceProvider,
} from './providers.js';

const topics: readonly NotificationTopicDeclaration[] = [
  {
    id: 'energy-full',
    purpose: 'requested',
    channels: ['local', 'remote'],
    route: '/?entry=continue',
    mapping: { channelId: 'reminders' },
  },
  {
    id: 'friend-challenge',
    purpose: 'service',
    channels: ['remote'],
    route: '/?entry=friend-challenge',
    mapping: {},
  },
];

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function createApp(): CapacitorAppEventsApi {
  return {
    async addListener() {
      return { remove: async () => undefined };
    },
    async getState() {
      return { isActive: true };
    },
    async getLaunchUrl() {
      return undefined;
    },
    async exitApp() {},
  } as unknown as CapacitorAppEventsApi;
}

function baseBridge(requests: BridgeRequest[], native: Record<string, unknown> = {}) {
  return {
    async request(input: BridgeRequest): Promise<BridgeResponse> {
      requests.push(input);
      const data = input.method === 'runtime.getCapabilities'
        ? { ...createUnsupportedCapabilities(), ...native }
        : input.method === 'storage.load'
          ? { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false }
          : null;
      return { id: input.id, ok: true, data };
    },
  };
}

function setup(options: {
  readonly native?: NotificationProvider;
  readonly openSettings?: () => Promise<void>;
} = {}) {
  const sdks = createFakeNotificationSdks({ platform: 'android' });
  const native = options.native ?? createCapacitorNotificationProvider({
    platform: 'android',
    topics,
    ...(sdks.push === undefined ? {} : { push: sdks.push }),
    ...(sdks.local === undefined ? {} : { local: sdks.local }),
    app: sdks.app,
    timeZone: () => 'Asia/Seoul',
    locale: () => undefined,
    now: () => Date.parse('2026-10-12T03:00:00Z'),
    ...(options.openSettings === undefined ? {} : { openSettings: options.openSettings }),
  });
  const requests: BridgeRequest[] = [];
  const gateway = createCapacitorPlatformGateway({
    target: 'android',
    appVersion: '1',
    buildId: 'notifications',
    app: createApp(),
    visibility: null,
    bridge: baseBridge(requests, { notifications: { availability: 'available' } }),
    providers: [
      createNotificationServiceProvider({ id: 'notifications', notifications: native, topics }),
    ],
  });
  return { sdks, native, gateway, requests };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Capacitor gateway with a notifications v2 service', () => {
  it('exposes notificationsV2 and the capability block, with push readiness equal to it', async () => {
    const { gateway, requests } = setup();
    expect(gateway.notificationsV2?.provider).toBe('fcm');
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.notifications).toEqual(await gateway.notificationsV2?.getCapabilities());
    expect(capabilities.notifications?.availability).toBe('available');
    expect(capabilities.providerAvailability?.pushNotifications).toBe('available');
    expect(requests.map((request) => request.method)).toEqual(['runtime.getCapabilities']);
    // A fresh block on every read.
    expect((await gateway.getCapabilities()).notifications)
      .not.toBe((await gateway.getCapabilities()).notifications);
  });

  it('passes capability conformance, live across a provider change', async () => {
    const native = createCapacitorNotificationProvider({ platform: 'android', topics, app: null });
    let availability: PlatformProviderAvailability = 'available';
    const { gateway } = setup({
      native: {
        ...native,
        getCapabilities: async () => ({ ...(await native.getCapabilities()), availability }),
      },
    });
    const notifications = await native.getCapabilities();
    const expected = (state: PlatformProviderAvailability) => ({
      ...createUnsupportedCapabilities(),
      bannerAds: false,
      commerce: createUnsupportedCommerceCapabilities(),
      providerAvailability: {
        rewardedAds: 'unsupported',
        interstitialAds: 'unsupported',
        bannerAds: 'unsupported',
        nativeLeaderboard: 'unsupported',
        identityUpgrade: 'unsupported',
        pushNotifications: state,
      },
      notifications: { ...notifications, availability: state },
    } as const);
    const report = await runPlatformGatewayCapabilityConformance({
      fixtures: [{
        name: 'android:notifications',
        gateway,
        expectedTarget: 'android',
        expectedCapabilities: expected('available'),
        transition: {
          update() {
            availability = 'temporarily-unavailable';
          },
          expectedCapabilities: expected('temporarily-unavailable'),
        },
      }],
    });
    expect(report.passedFixtures).toEqual(['android:notifications']);
  });

  it('leaves out a native notifications block without a service', async () => {
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1',
      buildId: 'no-notifications',
      app: createApp(),
      visibility: null,
      bridge: baseBridge([], { notifications: { availability: 'available' } }),
    });
    expect(gateway.notificationsV2).toBeUndefined();
    const capabilities = await gateway.getCapabilities();
    expect('notifications' in capabilities).toBe(false);
    expect(capabilities.providerAvailability?.pushNotifications).toBe('unsupported');
  });

  it('reports an unsupported provider as unsupported readiness', async () => {
    const { gateway } = setup({
      native: createCapacitorNotificationProvider({ platform: 'ios', topics, app: null }),
    });
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.notifications?.availability).toBe('unsupported');
    expect(capabilities.providerAvailability?.pushNotifications).toBe('unsupported');
    expect(gateway.notificationsV2?.register).toBeUndefined();
    expect(gateway.notificationsV2?.scheduleLocal).toBeUndefined();
  });

  it('degrades the block when the service read fails', async () => {
    const failing: NotificationProvider = {
      provider: 'fcm',
      getCapabilities: async () => Promise.reject(new Error('down')),
      getPermission: async () => ({ topics: {} }),
      requestPermission: async () => ({ snapshot: { topics: {} }, outcomes: {} }),
      subscribe: () => () => undefined,
    };
    const { gateway } = setup({ native: failing });
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.notifications).toMatchObject({
      availability: 'temporarily-unavailable',
      remote: { supported: false, addressing: 'none' },
      local: { supported: false },
      open: 'none',
    });
    expect(capabilities.providerAvailability?.pushNotifications).toBe('temporarily-unavailable');
    // The base entry writes the block out instead of importing it; it stays
    // the unsupported block with another availability.
    expect(capabilities.notifications).toEqual(createDegradedNotificationCapabilities());
    expect(createDegradedNotificationCapabilities()).toEqual({
      ...createUnsupportedNotificationCapabilities(),
      availability: 'temporarily-unavailable',
    });
  });

  it('serves v1 from v2 without the base plugin', async () => {
    const { gateway, sdks, requests } = setup();
    expect(await gateway.notifications?.getStatus('daily-ready')).toBe('configuration-required');
    expect(await gateway.notifications?.requestSubscription('daily-ready')).toBe('unavailable');
    const v1 = gateway.notifications as unknown as {
      getStatus(topic: string): Promise<string>;
      requestSubscription(topic: string): Promise<string>;
    };
    expect(await v1.getStatus('energy-full')).toBe('not-subscribed');
    sdks.queuePrompt('granted');
    expect(await v1.requestSubscription('energy-full')).toBe('subscribed');
    expect(await v1.getStatus('energy-full')).toBe('subscribed');
    sdks.osState = 'denied';
    expect(await v1.requestSubscription('energy-full')).toBe('rejected');
    expect(requests).toEqual([]);
  });

  it('pauses the game under the permission dialog and until the player is back from settings', async () => {
    let opened = 0;
    const { gateway, sdks } = setup({ openSettings: async () => { opened += 1; } });
    const pauses: string[] = [];
    gateway.lifecycle.onPause(() => pauses.push('pause'));
    gateway.lifecycle.onResume(() => pauses.push('resume'));
    await settle();
    sdks.queuePrompt('granted');
    await gateway.notificationsV2?.requestPermission({ topics: ['energy-full'] });
    expect(pauses).toEqual(['pause', 'resume']);
    let answer: string | undefined;
    const call = gateway.notificationsV2?.openSettings?.().then((value) => {
      answer = value;
    });
    await settle();
    expect(opened).toBe(1);
    expect(pauses).toEqual(['pause', 'resume', 'pause']);
    sdks.app.setActive(false);
    await settle();
    expect(answer).toBeUndefined();
    sdks.app.setActive(true);
    await call;
    expect(answer).toBe('opened');
    expect(pauses).toEqual(['pause', 'resume', 'pause', 'resume']);
    // Reads do not pause.
    await gateway.notificationsV2?.getPermission({ topics: ['energy-full'] });
    expect(pauses).toHaveLength(4);
    await gateway.lifecycle.dispose?.();
  });

  it('keeps an open that arrives between two game subscribers, through the bridge', () => {
    const { gateway, sdks } = setup();
    const scene1: NotificationEvent[] = [];
    const leave = gateway.notificationsV2?.subscribe((event) => scene1.push(event));
    leave?.();
    sdks.tap({ channel: 'remote', topic: 'friend-challenge', route: '/?entry=friend-challenge' });
    const scene2: NotificationEvent[] = [];
    gateway.notificationsV2?.subscribe((event) => scene2.push(event));
    expect(scene1).toEqual([]);
    expect(scene2).toEqual([{
      type: 'opened', channel: 'remote', source: 'warm', topic: 'friend-challenge', route: '/?entry=friend-challenge',
    }]);
  });

  it('reports a push-only shell with an advertising topic as configuration-required', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'ios', local: false });
    const advertising: NotificationTopicDeclaration = {
      id: 'weekend-event', purpose: 'advertising', channels: ['remote'], route: '/events',
      optOutRoute: '/settings/notifications', mapping: {},
    };
    const native = createCapacitorNotificationProvider({
      platform: 'ios', topics: [...topics, advertising], push: sdks.push!, app: null,
    });
    const { gateway } = setup({ native });
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.notifications?.availability).toBe('configuration-required');
    expect(capabilities.providerAvailability?.pushNotifications).toBe('configuration-required');
    expect(await gateway.notifications?.getStatus('friend-challenge')).toBe('configuration-required');
    await expect(gateway.notificationsV2?.getPermission({ topics: ['friend-challenge'] }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false });
  });

  it('delivers a cold-start open to the first game subscriber through the bridge', () => {
    const { gateway, sdks } = setup();
    sdks.tap({ channel: 'remote', topic: 'friend-challenge', route: '/?entry=friend-challenge' });
    const events: NotificationEvent[] = [];
    gateway.notificationsV2?.subscribe((event) => events.push(event));
    expect(events).toEqual([{
      type: 'opened',
      channel: 'remote',
      source: 'cold',
      topic: 'friend-challenge',
      route: '/?entry=friend-challenge',
    }]);
  });

  it('round-trips local reminders and registrations with validation on both sides', async () => {
    const { gateway, sdks } = setup();
    const provider = gateway.notificationsV2;
    sdks.osState = 'granted';
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    expect(await provider?.register?.()).toEqual({
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
      timeZone: 'Asia/Seoul',
    });
    const reminder = {
      key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z', title: 'Energy', body: 'Full',
    };
    expect(await provider?.scheduleLocal?.(reminder)).toEqual({ status: 'scheduled' });
    expect(await provider?.listLocal?.()).toEqual([
      { key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' },
    ]);
    await provider?.cancelLocal?.({ keys: ['energy'] });
    expect(await provider?.listLocal?.()).toEqual([]);
    await expect(provider?.scheduleLocal?.({ ...reminder, route: '//evil.example' }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT', retryable: false });
    await expect(provider?.requestPermission({ topics: [] }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
  });

  it('answers an invalid provider answer as configuration-required, not retried', async () => {
    const broken: NotificationProvider = {
      provider: 'fcm',
      getCapabilities: async () => createCapacitorNotificationProvider({
        platform: 'android', topics, app: null,
      }).getCapabilities(),
      getPermission: async () => ({ app: 'granted', topics: { 'energy-full': 'maybe' } }) as never,
      requestPermission: async () => ({ snapshot: { topics: {} }, outcomes: {} }),
      subscribe: () => () => undefined,
    };
    const { gateway } = setup({ native: broken });
    await expect(gateway.notificationsV2?.getPermission({ topics: ['energy-full'] }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false });
  });

  it.each(['getPermission', 'requestPermission', 'revokePermission'] as const)(
    '%s rejects instead of throwing, before any pause, for input a caller gets wrong',
    async (method) => {
      const native = createCapacitorNotificationProvider({ platform: 'android', topics, app: null });
      const { gateway } = setup({
        native: { ...native, revokePermission: async () => native.requestPermission({ topics: [] }) },
      });
      const pauses: string[] = [];
      gateway.lifecycle.onPause(() => pauses.push('pause'));
      await settle();
      const call = gateway.notificationsV2?.[method]?.(undefined as never);
      expect(call).toBeInstanceOf(Promise);
      await expect(call).rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT', retryable: false });
      expect(pauses).toEqual([]);
      await gateway.lifecycle.dispose?.();
    },
  );

  it('rejects cancelLocal without keys as invalid input', async () => {
    const { gateway } = setup();
    await expect(gateway.notificationsV2?.cancelLocal?.(undefined as never)).rejects.toMatchObject({
      code: 'NOTIFICATIONS_INVALID_INPUT',
      retryable: false,
    });
  });

  it('keeps its own copy of the v1 topics', async () => {
    const native = createCapacitorNotificationProvider({ platform: 'android', topics, app: null });
    const v1Topics: { id: string; targets?: unknown }[] = [{ id: 'friend-challenge' }];
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1',
      buildId: 'copied-topics',
      app: createApp(),
      visibility: null,
      bridge: baseBridge([]),
      providers: [createNotificationServiceProvider({
        id: 'notifications',
        notifications: native,
        topics: v1Topics as never,
      })],
    });
    // Changed after the gateway was created: an entry with `targets` would count as outside.
    v1Topics[0]!.targets = { android: {} };
    v1Topics.length = 0;
    // Still declared, so the provider answers (unsupported, without plugins)
    // instead of the adapter answering configuration-required.
    expect(await gateway.notifications?.getStatus('friend-challenge')).toBe('unsupported');
  });

  it('releases the pause when the request fails', async () => {
    const { gateway, sdks } = setup();
    const pauses: string[] = [];
    gateway.lifecycle.onPause(() => pauses.push('pause'));
    gateway.lifecycle.onResume(() => pauses.push('resume'));
    await settle();
    sdks.failNext('push.requestPermissions', new Error('native'));
    await expect(gateway.notificationsV2?.requestPermission({ topics: ['energy-full'] }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true });
    expect(pauses).toEqual(['pause', 'resume']);
    await gateway.lifecycle.dispose?.();
  });

  it('serves a game-rendered revocation through the bridge', async () => {
    const revoke = vi.fn(async ({ topics: requested }: { readonly topics: readonly string[] }) => ({
      snapshot: { app: 'prompt' as const, topics: Object.fromEntries(requested.map((topic) => [topic, 'prompt' as const])) },
      outcomes: Object.fromEntries(requested.map((topic) => [topic, 'denied' as const])),
    }));
    const native = createCapacitorNotificationProvider({ platform: 'android', topics, app: null });
    const { gateway } = setup({ native: { ...native, revokePermission: revoke } });
    expect(await gateway.notificationsV2?.revokePermission?.({ topics: ['energy-full'] })).toEqual({
      snapshot: { app: 'prompt', topics: { 'energy-full': 'prompt' } },
      outcomes: { 'energy-full': 'denied' },
    });
    expect(revoke).toHaveBeenCalledWith({ topics: ['energy-full'] });
  });

  it('keeps the code of a PlatformOperationError that is not a NotificationError', async () => {
    const native = createCapacitorNotificationProvider({ platform: 'android', topics, app: null });
    const { gateway, requests } = setup({
      native: {
        ...native,
        getPermission: async () => Promise.reject(new PlatformOperationError({
          code: 'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED',
          message: 'old host',
        })),
      },
    });
    await expect(gateway.notificationsV2?.getPermission({ topics: [] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED',
      retryable: false,
    });
    // A v2 failure never falls back to the base plugin.
    expect(requests).toEqual([]);
  });

  it('maps a PlatformOperationError with another code to temporarily unavailable, keeping its flag', async () => {
    for (const retryable of [true, false]) {
      const native = createCapacitorNotificationProvider({ platform: 'android', topics, app: null });
      const { gateway } = setup({
        native: {
          ...native,
          getPermission: async () => Promise.reject(new PlatformOperationError({
            code: 'HOST_SOMETHING',
            message: 'gone',
            retryable,
          })),
        },
      });
      await expect(gateway.notificationsV2?.getPermission({ topics: [] })).rejects.toMatchObject({
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        retryable,
      });
    }
  });

  it('names only a host code that reads as one', async () => {
    const failing = (hostCode: string) => {
      const native = createCapacitorNotificationProvider({ platform: 'android', topics, app: null });
      return setup({
        native: {
          ...native,
          getPermission: async () => Promise.reject(new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
            message: 'plugin missing',
            hostCode,
          })),
        },
      }).gateway;
    };
    const readable = await failing('UNIMPLEMENTED').notificationsV2?.getPermission({ topics: [] })
      .catch((error: unknown) => error);
    expect(readable).toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      message: 'plugin missing (host code UNIMPLEMENTED)',
    });
    const unreadable = await failing('not a code').notificationsV2?.getPermission({ topics: [] })
      .catch((error: unknown) => error);
    expect(unreadable).toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      message: 'plugin missing',
    });
  });

  it('treats unresolved catalog entries as outside the v1 catalog', async () => {
    const native = createCapacitorNotificationProvider({ platform: 'android', topics, app: null });
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1',
      buildId: 'unresolved',
      app: createApp(),
      visibility: null,
      bridge: baseBridge([]),
      providers: [createNotificationServiceProvider({
        id: 'notifications',
        notifications: native,
        topics: [{ id: 'friend-challenge', targets: { android: {} } } as never],
      })],
    });
    expect(await gateway.notifications?.getStatus('friend-challenge')).toBe('configuration-required');
  });

  it('keeps the provider error code across the bridge', async () => {
    const { gateway, sdks } = setup();
    sdks.failNext('local.checkPermissions', { code: 'UNIMPLEMENTED', message: 'missing' });
    const failure = await gateway.notificationsV2?.getPermission({ topics: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotificationError);
    expect(failure).toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      retryable: false,
      message: expect.stringContaining('host code UNIMPLEMENTED'),
    });
  });
});

describe('notifications provider bridge', () => {
  const request = (method: string, payload: unknown): BridgeRequest => ({
    id: `r-${method}`,
    method: method as BridgeRequest['method'],
    payload,
    meta: { target: 'android', appVersion: '1', buildId: 'b', sentAt: '2026-10-12T00:00:00Z' },
  });
  const minimal: NotificationProvider = {
    provider: 'fixture',
    getCapabilities: async () => createCapacitorNotificationProvider({
      platform: 'ios', topics, app: null,
    }).getCapabilities(),
    getPermission: async ({ topics: requested }) => ({
      app: 'unsupported',
      topics: Object.fromEntries(requested.map((topic) => [topic, 'unsupported' as const])),
    }),
    requestPermission: async () => ({ snapshot: { topics: {} }, outcomes: {} }),
    subscribe: () => () => undefined,
  };

  it('answers unsupported for a method the provider does not implement, and unavailable settings', async () => {
    const bridge = createNotificationProviderBridge({ provider: minimal });
    expect(await bridge.request(request('notifications.v2.revokePermission', { topics: ['a'] })))
      .toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_UNSUPPORTED', retryable: false } });
    expect(await bridge.request(request('notifications.v2.register', { protocol: 'mpgd.notifications.v2' })))
      .toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_UNSUPPORTED' } });
    expect(await bridge.request(request('notifications.v2.openSettings', { protocol: 'mpgd.notifications.v2' })))
      .toMatchObject({ ok: true, data: { status: 'unavailable' } });
    expect(await bridge.request(request('storage.load', {})))
      .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_METHOD' } });
  });

  it('refuses a payload the contract rejects before reaching the provider', async () => {
    const getPermission = vi.fn(minimal.getPermission);
    const bridge = createNotificationProviderBridge({ provider: { ...minimal, getPermission } });
    for (const payload of [{ topics: 'a' }, { topics: ['a'], extra: true }, null]) {
      expect(await bridge.request(request('notifications.v2.getPermission', payload)))
        .toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_INVALID_INPUT', retryable: false } });
    }
    expect(getPermission).not.toHaveBeenCalled();
    expect(await bridge.request(request('notifications.v2.getPermission', { topics: ['a'] })))
      .toMatchObject({ ok: true, data: { app: 'unsupported', topics: { a: 'unsupported' } } });
  });

  it('answers a thrown non-platform error as temporarily unavailable', async () => {
    const bridge = createNotificationProviderBridge({
      provider: { ...minimal, getPermission: async () => Promise.reject(new Error('native')) },
    });
    expect(await bridge.request(request('notifications.v2.getPermission', { topics: ['a'] })))
      .toMatchObject({
        ok: false,
        error: { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true },
      });
  });

  it('numbers events from 0 and attaches to the provider only for the first listener', () => {
    const listeners: ((event: NotificationEvent) => void)[] = [];
    const subscribe = vi.fn((listener: (event: NotificationEvent) => void) => {
      listeners.push(listener);
      return () => undefined;
    });
    const bridge = createNotificationProviderBridge({ provider: { ...minimal, subscribe } });
    const received: BridgeEvent[] = [];
    bridge.subscribe((event) => received.push(event));
    bridge.subscribe(() => undefined);
    expect(subscribe).toHaveBeenCalledOnce();
    listeners[0]?.({ type: 'received', channel: 'remote' });
    listeners[0]?.({ type: 'received', channel: 'local' });
    expect(received).toEqual([
      { protocol: 'mpgd.notifications.v2', sequence: 0, event: { type: 'received', channel: 'remote' } },
      { protocol: 'mpgd.notifications.v2', sequence: 1, event: { type: 'received', channel: 'local' } },
    ]);
  });
});

describe('bridge notifications client', () => {
  it('skips other protocols, drops a malformed envelope, and validates the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let deliver: ((envelope: never) => void) | undefined;
    const client = createBridgeNotificationProvider({
      provider: 'fcm',
      serves: { revokePermission: false, register: false, local: false },
      request: async () => Promise.reject(new Error('unused')),
      subscribe: (listener) => {
        deliver = listener as (envelope: never) => void;
        return () => undefined;
      },
    });
    const events: NotificationEvent[] = [];
    client.subscribe((event) => events.push(event));
    deliver?.({ protocol: 'mpgd.commerce.v2', sequence: 0, event: {} } as never);
    deliver?.({ sequence: 0, event: { type: 'received', channel: 'remote' } } as never);
    deliver?.({ protocol: 'mpgd.notifications.v2', sequence: 0, event: { type: 'nope' } } as never);
    deliver?.({
      protocol: 'mpgd.notifications.v2', sequence: 1, event: { type: 'received', channel: 'local' },
    } as never);
    expect(events).toEqual([{ type: 'received', channel: 'local' }]);
    // The envelope without a protocol and the bad event reached the validator.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(client.revokePermission).toBeUndefined();
    expect(client.register).toBeUndefined();
    expect(client.scheduleLocal).toBeUndefined();
    expect(typeof client.openSettings).toBe('function');
  });

  it('answers an answer its own validator rejects as configuration-required', async () => {
    const client = createBridgeNotificationProvider({
      provider: 'fcm',
      serves: { revokePermission: false, register: false, local: false },
      request: async <TData>() => ({ app: 'granted', topics: { a: 'maybe' } }) as TData,
      subscribe: () => () => undefined,
    });
    await expect(client.getPermission({ topics: ['a'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      retryable: false,
    });
  });

  it('keeps a notifications error code and maps anything else to temporarily unavailable', async () => {
    const failing = (error: unknown) => createBridgeNotificationProvider({
      provider: 'fcm',
      serves: { revokePermission: false, register: false, local: false },
      request: async () => Promise.reject(error),
      subscribe: () => () => undefined,
    });
    await expect(failing({ code: 'NOTIFICATIONS_USER_GESTURE_REQUIRED', message: 'x' })
      .getPermission({ topics: [] })).rejects.toMatchObject({ code: 'NOTIFICATIONS_USER_GESTURE_REQUIRED' });
    await expect(failing(new Error('NATIVE_BRIDGE_INVALID_RESPONSE'))
      .getPermission({ topics: [] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
  });

  it('reads a hostile thrown value without throwing, keeping a readable code', async () => {
    const failing = (error: unknown) => createBridgeNotificationProvider({
      provider: 'fcm',
      serves: { revokePermission: false, register: false, local: false },
      request: async () => Promise.reject(error),
      subscribe: () => () => undefined,
    });
    const hostile = (): never => {
      throw new Error('hostile read');
    };
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const thrown of [new Proxy({}, { get: hostile, getPrototypeOf: hostile }), revocable.proxy]) {
      const failure = await failing(thrown).getPermission({ topics: [] }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NotificationError);
      expect(failure).toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true });
    }
    const unreadable = Object.assign(new Error('hidden'), { code: 'NOTIFICATIONS_UNSUPPORTED' });
    Object.defineProperty(unreadable, 'message', { get: hostile });
    await expect(failing(unreadable).getPermission({ topics: [] }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_UNSUPPORTED' });
  });
});

describe('Capacitor registry with a notifications v2 service', () => {
  const service = () => createNotificationServiceProvider({
    id: 'notifications',
    notifications: createCapacitorNotificationProvider({ platform: 'android', topics, app: null }),
    topics,
  });

  it('owns the nine v2 methods and passes them through readiness', async () => {
    const entry = service();
    const registry = createCapacitorProviderRegistry([entry]);
    expect(registry.notifications).toBe(registry.byMethod.get('notifications.v2.getPermission'));
    for (const method of bridgeNotificationsV2Methods) {
      expect(registry.byMethod.get(method)?.id).toBe('notifications');
      await expect(registry.assertMethodReady(method, {})).resolves.toBeUndefined();
    }
  });

  it('validates the v2 answers with the service and rejects them without one', () => {
    const entry = service();
    expect(() => assertProviderResponseData('notifications.v2.getPermission', {
      app: 'granted', topics: {},
    }, entry)).not.toThrow();
    expect(() => assertProviderResponseData('notifications.v2.listLocal', { pending: [] }, entry))
      .not.toThrow();
    expect(() => assertProviderResponseData('notifications.v2.openSettings', { status: 'maybe' }, entry))
      .toThrow(/returned invalid data/u);
    // A provider that broke the contract is a configuration error, not retried.
    expect(() => assertProviderResponseData('notifications.v2.openSettings', { status: 'maybe' }, entry))
      .toThrow(expect.objectContaining({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false }));
    expect(() => assertProviderResponseData('ads.showInterstitial', { status: 'maybe' }))
      .toThrow(expect.objectContaining({ code: 'NATIVE_PROVIDER_INVALID_RESPONSE' }));
    expect(() => assertProviderResponseData('notifications.v2.listLocal', {
      pending: [{ key: 'a', topic: 't', fireAt: '2026-10-12T06:00:00' }],
    }, entry)).toThrow(/returned invalid data/u);
    for (const method of bridgeNotificationsV2Methods) {
      expect(() => assertProviderResponseData(method, { pending: [] })).toThrow(/returned invalid data/u);
    }
  });

  it('refuses a second service, a v1 push provider next to it, and a service without events', () => {
    expect(() => createCapacitorProviderRegistry([service(), { ...service(), id: 'second' }]))
      .toThrow(/notifications\.v2\.getCapabilities has multiple providers/u);
    const v1: CapacitorServiceProvider = {
      id: 'push',
      features: ['pushNotifications'],
      methods: ['notifications.getStatus', 'notifications.requestSubscription'],
      async getAvailability() {
        return { pushNotifications: 'available' };
      },
      bridge: { async request() { throw new Error('unused'); } },
    };
    expect(() => createCapacitorProviderRegistry([service(), v1]))
      .toThrow(/push declares pushNotifications, which the notifications v2 provider notifications serves/u);
    const { subscribe: _subscribe, ...bridge } = service().bridge;
    expect(() => createCapacitorProviderRegistry([{ ...service(), bridge }]))
      .toThrow(/declares a notifications service but its bridge has no subscribe/u);
  });

  it('copies every capability field, optional ones included', async () => {
    const native = createCapacitorNotificationProvider({ platform: 'ios', topics, app: null });
    const full = {
      availability: 'available',
      permission: {
        scope: 'app',
        prompt: 'os',
        readable: true,
        serverReadable: false,
        allowance: 'persistent',
        userGesture: false,
        promptLimit: 1,
        maxTopicsPerPrompt: 3,
        settings: true,
      },
      remote: { supported: true, purposes: ['service'], addressing: 'device', content: 'free-form' },
      local: { supported: true, maxPending: 64 },
      open: 'payload',
    } as const;
    const entry = createNotificationServiceProvider({
      id: 'notifications',
      notifications: { ...native, getCapabilities: async () => full },
      topics,
    });
    const copy = await entry.notificationsV2.getCapabilities();
    expect(copy).toEqual(full);
    expect(copy.remote.purposes).not.toBe(full.remote.purposes);
  });

  it('builds the provider and its entry in one call', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'ios' });
    const entry = createCapacitorNotificationServiceProvider({
      platform: 'ios',
      topics,
      ...(sdks.push === undefined ? {} : { push: sdks.push }),
      app: sdks.app,
    });
    expect(entry.id).toBe('capacitor-notifications');
    expect(await entry.notificationsV2.getCapabilities()).toMatchObject({
      availability: 'available',
      local: { supported: false },
      permission: { promptLimit: 1 },
    });
  });
});
