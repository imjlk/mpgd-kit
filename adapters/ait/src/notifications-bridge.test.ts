import { describe, expect, it, vi } from 'vitest';

import type { BridgeNotificationsEvent, BridgeRequest } from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';
import {
  NotificationError,
  type NotificationEvent,
  type NotificationProvider,
} from '@mpgd/platform/notifications';

import { createFakeAitHostDependencies, createFakeAitIapHost } from '../test/ait-iap-fixture.js';
import { createFakeAitNotificationHost } from '../test/ait-notification-fixture.js';
import { createAitHostBridge } from './host.js';
import {
  createAitPlatformGateway,
  createAitSandboxBridge,
  type GamePlatformBridge,
} from './index.js';
// A static import: the gateway's dynamic import of the same client chunk is
// then served from the module cache, so no test here races a cold import
// against the 3-second capability read bound.
import {
  createAitBridgeNotificationProvider,
  createAitNotificationsV2BridgeHandler,
} from './notifications-bridge.js';
import { createAitNotificationCapabilities } from './notifications-provider.js';

function hostBridge(initialUrl?: string): {
  readonly bridge: GamePlatformBridge;
  readonly fake: ReturnType<typeof createFakeAitNotificationHost>;
} {
  const fake = createFakeAitNotificationHost(initialUrl === undefined ? {} : { initialUrl });
  const bridge = createAitHostBridge({
    notificationTopics: {
      'energy-full': { templateSetCode: 'my-game-energy-full', agreement: 'required' },
    },
    dependencies: createFakeAitHostDependencies(createFakeAitIapHost({ products: [] }), {
      requestNotificationAgreement: fake.sdk.requestAgreement,
      readInitialUrl: fake.sdk.readInitialUrl,
    }),
  });
  return { bridge, fake };
}

function gatewayOver(bridge: GamePlatformBridge) {
  return createAitPlatformGateway({ appVersion: '1.0.0', buildId: 'test', bridge });
}

function request(method: BridgeRequest['method'], payload: unknown): BridgeRequest {
  return {
    id: `${method}:test`,
    method,
    payload,
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'test',
      sentAt: '2026-10-19T00:00:00.000Z',
    },
  };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error instanceof NotificationError
      ? { code: error.code, retryable: error.retryable, message: error.message }
      : error;
  }
  throw new Error('Expected the call to fail.');
}

describe('Apps in Toss notifications v2 over the game bridge', () => {
  it('exposes notificationsV2 and its capability block when the host offers the channel', async () => {
    const { bridge, fake } = hostBridge();
    const gateway = gatewayOver(bridge);
    const provider = gateway.notificationsV2;
    expect(provider?.provider).toBe('apps-in-toss');

    const capabilities = await gateway.getCapabilities();
    expect(capabilities.notifications).toEqual(createAitNotificationCapabilities());
    expect(capabilities.providerAvailability?.pushNotifications).toBe('available');

    fake.queue({ kind: 'event', type: 'newAgreement' });
    await expect(provider?.requestPermission({ topics: ['energy-full'] })).resolves.toMatchObject({
      outcomes: { 'energy-full': 'granted' },
      evidence: { schema: 'apps-in-toss.notification-agreement.v1' },
    });
    await expect(provider?.getPermission({ topics: ['energy-full'] }))
      .resolves.toEqual({ topics: { 'energy-full': 'unknown' } });
    await expect(provider?.register?.()).resolves.toMatchObject({
      provider: 'apps-in-toss',
      address: { kind: 'platform-user' },
    });
    await expect(provider?.openSettings?.()).resolves.toBe('unavailable');
    expect(provider?.scheduleLocal).toBeUndefined();
    expect(provider?.revokePermission).toBeUndefined();
  });

  it('keeps the v1 and v2 readiness on one provider', async () => {
    const { bridge } = hostBridge();
    const gateway = gatewayOver(bridge);
    await expect(gateway.notifications?.getStatus('daily-ready')).resolves.toBe('configuration-required');
    await expect(gateway.notificationsV2?.getPermission({ topics: ['daily-ready'] }))
      .resolves.toEqual({ topics: { 'daily-ready': 'unsupported' } });
  });

  it('delivers the cold open of a push launch to the game once', async () => {
    const { bridge } = hostBridge('intoss://my-game/daily?referrer=push');
    const provider = gatewayOver(bridge).notificationsV2 as NotificationProvider;
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    provider.subscribe((event) => events.push(event));
    // The bridge client loads first; the host keeps its cold open for the
    // first listener, which attaches once the client has loaded. A call
    // through the provider resolves only after that load, and the waiting
    // subscribers attach in the load's own handler, which runs first.
    await provider.getPermission({ topics: [] });
    expect(events).toEqual([
      { type: 'opened', channel: 'remote', source: 'cold', referrer: 'push', route: '/daily' },
    ]);
  });

  it('offers no notificationsV2 over the sandbox bridge, which has no channel', async () => {
    const gateway = gatewayOver(createAitSandboxBridge({ storage: null, buildId: 'ait-sandbox' }));
    expect(gateway.notificationsV2).toBeUndefined();
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.notifications).toBeUndefined();
    expect(capabilities.providerAvailability?.pushNotifications).toBeUndefined();
  });

  it('bounds the capability read and maps a missing configuration', async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = hostBridge();
      const stalled: GamePlatformBridge = {
        ...bridge,
        request: (input) => input.method === 'notifications.v2.getCapabilities'
          ? new Promise(() => {})
          : bridge.request(input),
      };
      const pending = gatewayOver(stalled).getCapabilities();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toMatchObject({
        notifications: { availability: 'temporarily-unavailable' },
        providerAvailability: { pushNotifications: 'temporarily-unavailable' },
      });
    } finally {
      vi.useRealTimers();
    }
    const unconfigured = createAitHostBridge({
      dependencies: createFakeAitHostDependencies(createFakeAitIapHost({ products: [] }), {
        requestNotificationAgreement: createFakeAitNotificationHost().sdk.requestAgreement,
      }),
    });
    // Without a mapped topic the host offers no channel, so the gateway
    // exposes no notificationsV2 and loads no bridge client.
    expect(unconfigured.notificationsV2).toBeUndefined();
    const gateway = gatewayOver(unconfigured);
    expect(gateway.notificationsV2).toBeUndefined();
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.notifications).toBeUndefined();
    // The host still answers the v2 methods for a caller that asks anyway.
    await expect(unconfigured.request(request('notifications.v2.getCapabilities', {
      protocol: 'mpgd.notifications.v2',
    }))).resolves.toMatchObject({
      ok: true,
      data: { capabilities: { availability: 'configuration-required' } },
    });
  });

  it('reports a failed capability read as a block that offers nothing', async () => {
    const { bridge } = hostBridge();
    const failing: GamePlatformBridge = {
      ...bridge,
      request: async (input) => input.method === 'notifications.v2.getCapabilities'
        ? { id: input.id, ok: false, error: { code: 'NOTIFICATIONS_V2_UNAVAILABLE', message: 'old host', retryable: false } }
        : bridge.request(input),
    };
    const capabilities = await gatewayOver(failing).getCapabilities();
    expect(capabilities.notifications).toMatchObject({
      availability: 'unsupported',
      remote: { supported: false, addressing: 'none' },
    });
    expect(capabilities.providerAvailability?.pushNotifications).toBe('unsupported');
  });
});

describe('createAitBridgeNotificationProvider', () => {
  const answering = (handler: (method: string, payload: unknown) => unknown) =>
    createAitBridgeNotificationProvider({
      provider: 'apps-in-toss',
      request: async (method, payload) => handler(method, payload),
      subscribe: () => () => {},
    });

  it('keeps notifications codes and normalizes every other bridge failure', async () => {
    const failWith = (code: string, retryable = false) => answering(() => {
      throw new PlatformOperationError({ code, message: `${code} message`, retryable });
    });
    await expect(failureOf(failWith('NOTIFICATIONS_HOST_VERSION_UNSUPPORTED').requestPermission({
      topics: ['a'],
    }))).resolves.toMatchObject({ code: 'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED', retryable: false });
    await expect(failureOf(failWith('UNSUPPORTED_METHOD').getPermission({ topics: ['a'] })))
      .resolves.toMatchObject({ code: 'NOTIFICATIONS_V2_UNAVAILABLE', retryable: false });
    await expect(failureOf(failWith('AIT_BRIDGE_REQUEST_FAILED', true).getPermission({ topics: ['a'] })))
      .resolves.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true });
  });

  it('keeps the host code and the host retryability across the bridge', async () => {
    const { bridge, fake } = hostBridge();
    const provider = gatewayOver(bridge).notificationsV2 as NotificationProvider;
    fake.queue({ kind: 'error', error: { code: 'NOTIFICATION_AGREEMENT_FAILED' } });
    let failure: unknown;
    try {
      await provider.requestPermission({ topics: ['energy-full'] });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(NotificationError);
    expect(failure).toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      hostCode: 'NOTIFICATION_AGREEMENT_FAILED',
      retryable: false,
    });

    const notInstalled = answering(() => {
      throw new PlatformOperationError({ code: 'AIT_BRIDGE_NOT_INSTALLED', retryable: false });
    });
    await expect(failureOf(notInstalled.getPermission({ topics: ['a'] })))
      .resolves.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: false });
    const transport = answering(() => {
      throw new TypeError('postMessage failed');
    });
    await expect(failureOf(transport.getPermission({ topics: ['a'] })))
      .resolves.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true });
    const old = answering(() => {
      throw new PlatformOperationError({ code: 'INVALID_BRIDGE_REQUEST' });
    });
    await expect(failureOf(old.getPermission({ topics: ['a'] })))
      .resolves.toMatchObject({ code: 'NOTIFICATIONS_V2_UNAVAILABLE' });
  });

  it('refuses an answer the contract rejects or another provider id', async () => {
    await expect(failureOf(answering(() => ({ topics: { a: 'maybe' } })).getPermission({ topics: ['a'] })))
      .resolves.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    await expect(failureOf(answering(() => ({
      protocolVersion: '2.0.0-draft.1',
      provider: 'fcm',
      capabilities: createAitNotificationCapabilities(),
    })).getCapabilities())).resolves.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
  });

  it('ignores another protocol and drops an invalid notifications envelope', () => {
    let deliver: ((event: BridgeNotificationsEvent) => void) | undefined;
    const provider = createAitBridgeNotificationProvider({
      provider: 'apps-in-toss',
      request: async () => undefined,
      subscribe: (listener) => {
        deliver = listener;
        return () => {};
      },
    });
    const events: NotificationEvent[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      provider.subscribe((event) => events.push(event));
      deliver?.({ protocol: 'mpgd.commerce.v2', sequence: 0, event: {} } as never);
      deliver?.({ protocol: 'mpgd.notifications.v2', sequence: 0, event: { type: 'opened' } } as never);
      deliver?.({
        protocol: 'mpgd.notifications.v2',
        sequence: 1,
        event: { type: 'opened', channel: 'remote', source: 'cold', referrer: 'push' },
      });
      expect(events).toEqual([{ type: 'opened', channel: 'remote', source: 'cold', referrer: 'push' }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('createAitNotificationsV2BridgeHandler', () => {
  const base: NotificationProvider = {
    provider: 'apps-in-toss',
    getCapabilities: async () => createAitNotificationCapabilities(),
    getPermission: async () => ({ topics: {} }),
    requestPermission: async () => ({ snapshot: { topics: {} }, outcomes: {} }),
    subscribe: () => () => {},
  };

  it('answers an invalid provider answer as NOTIFICATIONS_CONFIGURATION_REQUIRED', async () => {
    const handler = createAitNotificationsV2BridgeHandler({
      ...base,
      getPermission: async () => ({ topics: { a: 'maybe' as never } }),
    });
    await expect(handler.request(request('notifications.v2.getPermission', { topics: ['a'] })))
      .resolves.toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' } });
  });

  it('keeps a host code in the message and makes an unnormalized failure retryable', async () => {
    const handler = createAitNotificationsV2BridgeHandler({
      ...base,
      requestPermission: async () => {
        throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
          hostCode: 'NOTIFICATION_AGREEMENT_FAILED',
        });
      },
      getPermission: async () => {
        throw new Error('boom');
      },
    });
    await expect(handler.request(request('notifications.v2.requestPermission', { topics: ['a'] })))
      .resolves.toMatchObject({
        ok: false,
        error: {
          code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
          message: expect.stringContaining('NOTIFICATION_AGREEMENT_FAILED'),
          retryable: false,
        },
      });
    await expect(handler.request(request('notifications.v2.getPermission', { topics: ['a'] })))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true },
      });
  });

  it('refuses a method outside notifications v2 and keeps a host failure non-retryable', async () => {
    const handler = createAitNotificationsV2BridgeHandler({
      ...base,
      getPermission: async () => {
        throw new PlatformOperationError({ code: 'AIT_SOMETHING', message: 'gone', retryable: false });
      },
    });
    await expect(handler.request(request('identity.getPlayer', {})))
      .resolves.toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_METHOD' } });
    await expect(handler.request(request('notifications.v2.getPermission', { topics: ['a'] })))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: false },
      });
  });

  it('names only a readable host code in the message', async () => {
    const throwing = (hostCode: string) =>
      createAitNotificationsV2BridgeHandler({
        ...base,
        requestPermission: async () => {
          throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', { hostCode });
        },
      });
    const readable = await throwing('CODE_1').request(
      request('notifications.v2.requestPermission', { topics: ['a'] }),
    );
    expect(readable).toMatchObject({ ok: false, error: { message: expect.stringMatching(/\(host code CODE_1\)$/u) } });
    const unreadable = await throwing('bad code (x)').request(
      request('notifications.v2.requestPermission', { topics: ['a'] }),
    );
    expect(unreadable).toMatchObject({ ok: false });
    expect(unreadable.ok ? '' : unreadable.error.message).not.toContain('host code');
  });

  it('refuses an empty request and answers null for a provider without registration', async () => {
    const handler = createAitNotificationsV2BridgeHandler(base);
    await expect(handler.request(request('notifications.v2.requestPermission', { topics: [] })))
      .resolves.toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_INVALID_INPUT' } });
    await expect(handler.request(request('notifications.v2.register', { protocol: 'mpgd.notifications.v2' })))
      .resolves.toEqual({ id: 'notifications.v2.register:test', ok: true, data: { registration: null } });
    await expect(handler.request(request('notifications.v2.openSettings', { protocol: 'mpgd.notifications.v2' })))
      .resolves.toMatchObject({ ok: true, data: { status: 'unavailable' } });
  });

  it('carries a host code to the game-side provider', async () => {
    const handler = createAitNotificationsV2BridgeHandler({
      ...base,
      requestPermission: async () => {
        throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
          message: 'Toss refused the agreement.',
          hostCode: 'NOTIFICATION_AGREEMENT_FAILED',
        });
      },
    });
    const provider = createAitBridgeNotificationProvider({
      provider: 'apps-in-toss',
      request: async (method, payload) => {
        const response = await handler.request(request(method, payload));
        if (!response.ok) {
          throw new PlatformOperationError(response.error);
        }
        return response.data;
      },
      subscribe: () => () => {},
    });
    const failure = await provider.requestPermission({ topics: ['a'] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotificationError);
    expect(failure).toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      hostCode: 'NOTIFICATION_AGREEMENT_FAILED',
      retryable: false,
    });
  });

  it('numbers the provider events per handler from 0', () => {
    let emit: ((event: NotificationEvent) => void) | undefined;
    const handler = createAitNotificationsV2BridgeHandler({
      ...base,
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
    });
    const envelopes: BridgeNotificationsEvent[] = [];
    handler.subscribe((envelope) => envelopes.push(envelope));
    const event: NotificationEvent = { type: 'opened', channel: 'remote', source: 'cold' };
    emit?.(event);
    emit?.(event);
    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
    expect(envelopes[0]).toEqual({ protocol: 'mpgd.notifications.v2', sequence: 0, event });
  });
});
