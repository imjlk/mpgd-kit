import { describe, expect, it, vi } from 'vitest';

import {
  createBridgeError,
  createNotificationsV2UnavailableBridgeError,
  isBridgeNotificationsV2Method,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { createUnsupportedNotificationCapabilities } from '@mpgd/platform/notifications';

import {
  createFakeDevvitNotifications,
  type FakeDevvitNotifications,
} from '../test/fake-devvit-notifications.js';
import { createDevvitPlatformGateway, type DevvitGatewayNotificationsOptions } from './index.js';
import {
  createDevvitDegradedNotificationCapabilities,
  createDevvitNotificationCapabilities,
} from './notifications-contract.js';
import { createDevvitNotificationsV2BridgeHandler } from './server/notifications-bridge.js';

const user = 't2_alice';

/** A Devvit server bridge: the v2 handler when `serves`, the kit's other answers otherwise. */
function createServer(plugin: FakeDevvitNotifications, serves = true) {
  const handler = createDevvitNotificationsV2BridgeHandler({
    notifications: plugin,
    currentUserId: () => plugin.currentUserId,
    topics: ['friend-challenge'],
  });
  const methods: string[] = [];
  return {
    methods,
    bridge: {
      async request(input: BridgeRequest): Promise<BridgeResponse> {
        methods.push(input.method);
        if (isBridgeNotificationsV2Method(input.method)) {
          return serves
            ? handler.request(input)
            : createNotificationsV2UnavailableBridgeError(input, 'test server');
        }
        switch (input.method) {
          case 'runtime.getCapabilities':
            return {
              id: input.id,
              ok: true,
              // A server snapshot with its own notifications block: the gateway
              // owns the block and never passes this one through.
              data: {
                cloudSave: true,
                providerAvailability: { pushNotifications: 'approval-required' },
                notifications: createDevvitNotificationCapabilities(),
              },
            };
          case 'identity.requestUpgrade':
            return {
              id: input.id,
              ok: true,
              data: {
                status: plugin.currentUserId === undefined ? 'unavailable' : 'completed',
                reloadExpected: false,
              },
            };
          case 'notifications.getStatus':
            return { id: input.id, ok: true, data: 'approval-required' };
          default:
            return createBridgeError(input.id, 'UNSUPPORTED_METHOD', input.method);
        }
      },
    },
  };
}

function gateway(
  plugin: FakeDevvitNotifications,
  notifications: Partial<DevvitGatewayNotificationsOptions> | null = {},
  serves = true,
) {
  const server = createServer(plugin, serves);
  return {
    server,
    gateway: createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: server.bridge,
      ...(notifications === null
        ? {}
        : {
            notifications: {
              topics: ['friend-challenge'],
              load: () => import('./notifications-client.js'),
              ...notifications,
            },
          }),
    }),
  };
}

describe('createDevvitPlatformGateway notifications', () => {
  it('offers no notificationsV2 and keeps the server v1 answers without the option', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    const { gateway: devvit } = gateway(plugin, null);
    expect(devvit.notificationsV2).toBeUndefined();
    await expect(devvit.notifications?.getStatus('friend-challenge')).resolves.toBe('approval-required');
    const capabilities = await devvit.getCapabilities();
    expect(capabilities.notifications).toBeUndefined();
    expect(capabilities.providerAvailability?.pushNotifications).toBe('approval-required');
  });

  it('exposes notificationsV2 with its block, and serves v1 from it', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    const { gateway: devvit, server } = gateway(plugin);
    const provider = devvit.notificationsV2;
    expect(provider?.provider).toBe('devvit');
    const capabilities = await devvit.getCapabilities();
    expect(capabilities.notifications).toEqual(createDevvitNotificationCapabilities());
    expect(capabilities.providerAvailability?.pushNotifications).toBe('available');
    await expect(devvit.notifications?.getStatus('friend-challenge')).resolves.toBe('not-subscribed');
    await expect(devvit.notifications?.getStatus('streak-at-risk')).resolves.toBe('configuration-required');
    await expect(devvit.notifications?.requestSubscription('friend-challenge')).resolves.toBe('subscribed');
    await expect(devvit.notifications?.getStatus('friend-challenge')).resolves.toBe('subscribed');
    await expect(provider?.revokePermission?.({ topics: ['friend-challenge'] })).resolves.toMatchObject({
      outcomes: { 'friend-challenge': 'denied' },
    });
    await expect(devvit.notifications?.getStatus('friend-challenge')).resolves.toBe('not-subscribed');
    // v1 never reaches the server's v1 methods while v2 is exposed.
    expect(server.methods.filter((method) => method.startsWith('notifications.') && !method.startsWith('notifications.v2.')))
      .toEqual([]);
    expect(provider?.subscribe(() => {})).toBeTypeOf('function');
  });

  it('reports action-required while the viewer is logged out', async () => {
    const plugin = createFakeDevvitNotifications();
    const { gateway: devvit } = gateway(plugin);
    const capabilities = await devvit.getCapabilities();
    expect(capabilities.notifications?.availability).toBe('action-required');
    expect(capabilities.providerAvailability?.pushNotifications).toBe('action-required');
  });

  it('reads a server without the handler as unsupported, offering nothing', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    const { gateway: devvit } = gateway(plugin, {}, false);
    const capabilities = await devvit.getCapabilities();
    expect(capabilities.notifications).toEqual(createDevvitDegradedNotificationCapabilities('unsupported'));
    expect(capabilities.providerAvailability?.pushNotifications).toBe('unsupported');
    await expect(devvit.notificationsV2?.getPermission({ topics: ['friend-challenge'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_V2_UNAVAILABLE',
    });
  });

  it('keeps the degraded block equal to the platform unsupported block', () => {
    expect(createDevvitDegradedNotificationCapabilities('unsupported')).toEqual(
      createUnsupportedNotificationCapabilities(),
    );
  });

  it('registers the platform user with the webview locale and a known zone', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    const known = gateway(plugin, { timeZone: () => 'Asia/Seoul', locale: () => 'ko-KR' }).gateway;
    await expect(known.notificationsV2?.register?.()).resolves.toEqual({
      provider: 'devvit',
      address: { kind: 'platform-user' },
      locale: 'ko-KR',
      timeZone: 'Asia/Seoul',
    });
    const unknown = gateway(plugin, {
      timeZone: () => 'Mars/Olympus',
      locale: () => {
        throw new Error('no navigator');
      },
    }).gateway;
    await expect(unknown.notificationsV2?.register?.()).resolves.toEqual({
      provider: 'devvit',
      address: { kind: 'platform-user' },
    });
  });

  it('loads the client chunk on first use and again after a failed load', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    let attempts = 0;
    const { gateway: devvit } = gateway(plugin, {
      load: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('chunk 404');
        }
        return import('./notifications-client.js');
      },
    });
    // The game opted in: the chunk starts loading with the gateway.
    expect(attempts).toBe(1);
    await expect(devvit.notificationsV2?.getPermission({ topics: ['friend-challenge'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
    await expect(devvit.notificationsV2?.getPermission({ topics: ['friend-challenge'] })).resolves.toMatchObject({
      app: 'prompt',
    });
    await devvit.notificationsV2?.getPermission({ topics: ['friend-challenge'] });
    expect(attempts).toBe(2);
  });
});

describe('createDevvitPlatformGateway notification chunk retries', () => {
  it('loads the chunk once for concurrent first calls', async () => {
    let attempts = 0;
    const devvit = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: createServer(createFakeDevvitNotifications({ currentUserId: user })).bridge,
      notifications: {
        topics: ['friend-challenge'],
        load: () => {
          attempts += 1;
          return import('./notifications-client.js');
        },
      },
    });
    await Promise.all([
      devvit.notificationsV2?.getPermission({ topics: ['friend-challenge'] }),
      devvit.notificationsV2?.getPermission({ topics: ['friend-challenge'] }),
      devvit.notifications?.getStatus('friend-challenge'),
    ]);
    expect(attempts).toBe(1);
  });

  it('retries a loader that threw synchronously', async () => {
    let attempts = 0;
    const devvit = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: createServer(createFakeDevvitNotifications({ currentUserId: user })).bridge,
      notifications: {
        topics: ['friend-challenge'],
        load: () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('synchronous loader failure');
          }
          return import('./notifications-client.js');
        },
      },
    });
    await expect(devvit.notificationsV2?.getPermission({ topics: ['friend-challenge'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
    await expect(devvit.notificationsV2?.getPermission({ topics: ['friend-challenge'] })).resolves.toMatchObject({
      app: 'prompt',
    });
    expect(attempts).toBe(2);
  });
});

describe('createDevvitPlatformGateway notification capability reads', () => {
  const failingGateway = (getCapabilities: () => Promise<never>) =>
    createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: createServer(createFakeDevvitNotifications({ currentUserId: user })).bridge,
      notifications: {
        topics: ['friend-challenge'],
        load: async () => {
          const module = await import('./notifications-client.js');
          return {
            ...module,
            createDevvitBridgeNotificationProvider: (input) => ({
              ...module.createDevvitBridgeNotificationProvider(input),
              getCapabilities,
            }),
          };
        },
      },
    });

  it('reads a configuration failure as configuration-required', async () => {
    const devvit = failingGateway(() =>
      Promise.reject(
        Object.assign(new Error('bad'), {
          code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
          retryable: false,
        }),
      ),
    );
    expect((await devvit.getCapabilities()).notifications?.availability).toBe(
      'configuration-required',
    );
  });

  it('reads a retryable failure as temporarily-unavailable, whatever its code', async () => {
    const devvit = failingGateway(() =>
      Promise.reject(
        Object.assign(new Error('flaky'), {
          code: 'NOTIFICATIONS_V2_UNAVAILABLE',
          retryable: true,
        }),
      ),
    );
    expect((await devvit.getCapabilities()).notifications).toEqual(
      createDevvitDegradedNotificationCapabilities('temporarily-unavailable'),
    );
  });

  it('reads a chunk that does not load as temporarily-unavailable', async () => {
    const devvit = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: createServer(createFakeDevvitNotifications({ currentUserId: user })).bridge,
      notifications: {
        topics: ['friend-challenge'],
        load: () => {
          throw new Error('synchronous loader failure');
        },
      },
    });
    expect((await devvit.getCapabilities()).notifications?.availability).toBe(
      'temporarily-unavailable',
    );
    await expect(devvit.notifications?.requestSubscription('friend-challenge')).resolves.toBe('unavailable');
  });

  it('bounds a read that stalls', async () => {
    vi.useFakeTimers();
    try {
      const devvit = failingGateway(() => new Promise<never>(() => {}));
      const read = devvit.getCapabilities();
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await read).notifications?.availability).toBe('temporarily-unavailable');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createDevvitPlatformGateway identity.requestUpgrade', () => {
  const upgrade = (plugin: FakeDevvitNotifications, loginPrompt?: { showLoginPrompt(): void }) =>
    createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: createServer(plugin).bridge,
      ...(loginPrompt === undefined ? {} : { loginPrompt }),
    }).identity.requestUpgrade?.({ reason: 'notifications' });

  it('shows the login prompt to a logged-out viewer and expects a reload', async () => {
    let shown = 0;
    await expect(upgrade(createFakeDevvitNotifications(), { showLoginPrompt: () => { shown += 1; } }))
      .resolves.toEqual({ status: 'completed', reloadExpected: true });
    expect(shown).toBe(1);
  });

  it('answers the server for a logged-in viewer, or without a prompt', async () => {
    let shown = 0;
    const prompt = { showLoginPrompt: () => { shown += 1; } };
    await expect(upgrade(createFakeDevvitNotifications({ currentUserId: user }), prompt))
      .resolves.toEqual({ status: 'completed', reloadExpected: false });
    await expect(upgrade(createFakeDevvitNotifications()))
      .resolves.toEqual({ status: 'unavailable', reloadExpected: false });
    expect(shown).toBe(0);
  });

  it('passes a server answer other than unavailable through without a prompt', async () => {
    let shown = 0;
    const plugin = createFakeDevvitNotifications();
    const server = createServer(plugin);
    const devvit = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: {
        async request(input) {
          return input.method === 'identity.requestUpgrade'
            ? { id: input.id, ok: true, data: { status: 'cancelled', reloadExpected: false } }
            : server.bridge.request(input);
        },
      },
      loginPrompt: { showLoginPrompt: () => { shown += 1; } },
    });
    await expect(devvit.identity.requestUpgrade?.({ reason: 'notifications' }))
      .resolves.toEqual({ status: 'cancelled', reloadExpected: false });
    expect(shown).toBe(0);
  });

  it('answers unavailable when the prompt cannot open', async () => {
    await expect(upgrade(createFakeDevvitNotifications(), {
      showLoginPrompt: () => {
        throw new Error('not in a webview');
      },
    })).resolves.toEqual({ status: 'unavailable', reloadExpected: false });
  });
});
