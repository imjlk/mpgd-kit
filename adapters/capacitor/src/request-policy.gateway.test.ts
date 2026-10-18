import { describe, expect, it, vi } from 'vitest';

import type { BridgeMethod, BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';

import type { CapacitorAppEventsApi } from './app-events.js';
import type { CapacitorServiceProvider } from './providers.js';

const guardCalls = vi.hoisted(() => [] as { method: string; served: boolean }[]);

// A gateway without a notifications service sends no notifications v2
// request, so the guard is made to refuse the v1 subscription request the way
// it refuses an unserved v2 method. That request is an external activity,
// which shows where the gateway asks the guard.
vi.mock('./request-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request-policy.js')>();
  return {
    ...actual,
    assertNotificationsV2Served: vi.fn((method: BridgeMethod, served: boolean) => {
      guardCalls.push({ method, served });
      if (method === 'notifications.requestSubscription' && !served) {
        throw new PlatformOperationError({
          code: 'NOTIFICATIONS_V2_UNAVAILABLE',
          retryable: false,
        });
      }
      actual.assertNotificationsV2Served(method, served);
    }),
  };
});

const { createCapacitorPlatformGateway } = await import('./index.js');

function createApp(): CapacitorAppEventsApi {
  const app = {
    async addListener() {
      return { remove: async () => {} };
    },
    async getState() {
      return { isActive: true };
    },
    async getLaunchUrl() {
      return undefined;
    },
    async exitApp() {},
  };
  return app as unknown as CapacitorAppEventsApi;
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('Capacitor request path guard', () => {
  it('fails closed before it pauses the game or reaches the base plugin', async () => {
    guardCalls.length = 0;
    const requests: BridgeRequest[] = [];
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1',
      buildId: 'guard',
      app: createApp(),
      visibility: null,
      bridge: {
        async request(input): Promise<BridgeResponse> {
          requests.push(input);
          return { id: input.id, ok: true, data: 'subscribed' };
        },
      },
    });
    let pauses = 0;
    gateway.lifecycle.onPause(() => {
      pauses += 1;
    });
    await settle();

    await expect(gateway.notifications?.requestSubscription('daily-ready')).rejects.toMatchObject({
      code: 'NOTIFICATIONS_V2_UNAVAILABLE',
      retryable: false,
    });
    expect(pauses).toBe(0);
    expect(requests).toEqual([]);
    expect(guardCalls).toEqual([{ method: 'notifications.requestSubscription', served: false }]);
    await gateway.lifecycle.dispose?.();
  });

  it('asks the guard whether a registered provider serves the method', async () => {
    guardCalls.length = 0;
    const provider: CapacitorServiceProvider = {
      id: 'push',
      features: ['pushNotifications'],
      methods: ['notifications.getStatus', 'notifications.requestSubscription'],
      async getAvailability() {
        return { pushNotifications: 'available' };
      },
      bridge: {
        async request(input) {
          return { id: input.id, ok: true, data: 'subscribed' };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1',
      buildId: 'guard-served',
      app: createApp(),
      visibility: null,
      providers: [provider],
      bridge: {
        async request(input) {
          return { id: input.id, ok: true, data: null };
        },
      },
    });
    let pauses = 0;
    gateway.lifecycle.onPause(() => {
      pauses += 1;
    });
    await settle();

    await expect(gateway.notifications?.requestSubscription('daily-ready')).resolves.toBe('subscribed');
    expect(pauses).toBe(1);
    await gateway.storage.load({ key: 'progress' });
    expect(guardCalls).toEqual([
      { method: 'notifications.requestSubscription', served: true },
      { method: 'storage.load', served: false },
    ]);
    await gateway.lifecycle.dispose?.();
  });
});
