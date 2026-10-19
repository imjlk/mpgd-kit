import { describe, expect, it } from 'vitest';

import type { BridgeRequest } from '@mpgd/bridge';
import { NotificationError } from '@mpgd/platform/notifications';

import { createFakeDevvitNotifications } from '../../test/fake-devvit-notifications.js';
import {
  createDevvitNotificationsV2BridgeHandler,
  createDevvitServerNotificationProvider,
  devvitNotificationHostCodes,
} from './notifications-bridge.js';

const user = 't2_alice';
const topics = ['friend-challenge', 'daily-puzzle'];

function request(method: string, payload: unknown): BridgeRequest {
  return {
    id: 'req-1',
    method: method as BridgeRequest['method'],
    payload,
    meta: { target: 'reddit', appVersion: '1', buildId: 'test', sentAt: '2026-10-19T00:00:00Z' },
  };
}

describe('createDevvitServerNotificationProvider', () => {
  it('answers action-required (login) for a logged-out viewer without reaching the plugin', async () => {
    const plugin = createFakeDevvitNotifications();
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    expect((await provider.getCapabilities()).availability).toBe('action-required');
    await expect(provider.getPermission({ topics: ['friend-challenge'] })).resolves.toEqual({
      app: 'action-required',
      topics: { 'friend-challenge': 'action-required' },
      requiredAction: 'login',
    });
    await expect(provider.requestPermission({ topics: ['friend-challenge'] })).resolves.toMatchObject({
      outcomes: { 'friend-challenge': 'action-required' },
      requiredAction: 'login',
    });
    await expect(provider.revokePermission?.({ topics: ['friend-challenge'] })).resolves.toMatchObject({
      outcomes: { 'friend-challenge': 'action-required' },
    });
    await expect(provider.register?.()).resolves.toBeNull();
    expect([plugin.optInCalls, plugin.optOutCalls]).toEqual([0, 0]);
  });

  it('ignores a context user id that is not a t2_ id', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: 'anonymous' });
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    expect((await provider.getCapabilities()).availability).toBe('action-required');
  });

  it('opts the request user in and out, reading isOptedIn each time', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    expect(await provider.getCapabilities()).toMatchObject({
      availability: 'available',
      permission: { scope: 'app', prompt: 'game', serverReadable: true, userGesture: true, settings: false },
      remote: { addressing: 'platform-user', purposes: ['service', 'requested'] },
      open: 'host-link',
    });
    await expect(provider.getPermission({ topics })).resolves.toMatchObject({ app: 'prompt' });
    await expect(provider.requestPermission({ topics: ['friend-challenge', 'unmapped'] })).resolves.toEqual({
      snapshot: { app: 'granted', topics: { 'friend-challenge': 'granted', unmapped: 'granted' } },
      outcomes: { 'friend-challenge': 'granted', unmapped: 'unavailable' },
    });
    await expect(provider.requestPermission({ topics: ['daily-puzzle'] })).resolves.toMatchObject({
      outcomes: { 'daily-puzzle': 'already-granted' },
    });
    expect(plugin.optInCalls).toBe(1);
    await expect(provider.revokePermission?.({ topics })).resolves.toEqual({
      snapshot: { app: 'prompt', topics: { 'friend-challenge': 'prompt', 'daily-puzzle': 'prompt' } },
      outcomes: { 'friend-challenge': 'denied', 'daily-puzzle': 'denied' },
    });
    expect(plugin.optedIn.has(user)).toBe(false);
    await expect(provider.register?.()).resolves.toEqual({
      provider: 'devvit',
      address: { kind: 'platform-user' },
    });
  });

  it('does not opt in for a request with only unmapped topics', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    await expect(provider.requestPermission({ topics: ['other'] })).resolves.toEqual({
      snapshot: { app: 'prompt', topics: { other: 'prompt' } },
      outcomes: { other: 'unavailable' },
    });
    expect(plugin.optInCalls).toBe(0);
  });

  it('normalizes a refused opt-in and a failing plugin', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    plugin.optInAnswers.push({ success: false, message: 'App is not approved for notifications' });
    const refused = await provider.requestPermission({ topics: ['friend-challenge'] }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotificationError);
    expect(refused).toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      hostCode: devvitNotificationHostCodes.optInRefused,
      retryable: false,
    });
    plugin.isOptedIn = () => Promise.reject(new Error('plugin down'));
    await expect(provider.getPermission({ topics })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      hostCode: devvitNotificationHostCodes.pluginFailed,
      retryable: true,
    });
  });

  it('refuses an opt-out Devvit refused', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    plugin.optOutCurrentUser = () => Promise.resolve({ success: false });
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    await expect(provider.revokePermission?.({ topics })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      hostCode: devvitNotificationHostCodes.optOutRefused,
    });
  });
});

describe('createDevvitNotificationsV2BridgeHandler', () => {
  const handler = (currentUserId: string | null = user) => {
    const plugin = createFakeDevvitNotifications(currentUserId === null ? {} : { currentUserId });
    return {
      plugin,
      bridge: createDevvitNotificationsV2BridgeHandler({
        notifications: plugin,
        currentUserId: () => plugin.currentUserId,
        topics,
      }),
    };
  };

  it('serves the profile methods with validated answers', async () => {
    const { bridge } = handler();
    await expect(bridge.request(request('notifications.v2.getCapabilities', { protocol: 'mpgd.notifications.v2' })))
      .resolves.toMatchObject({ ok: true, data: { provider: 'devvit', protocolVersion: '2.0.0-draft.1' } });
    await expect(bridge.request(request('notifications.v2.requestPermission', { topics: ['friend-challenge'] })))
      .resolves.toMatchObject({ ok: true, data: { outcomes: { 'friend-challenge': 'granted' } } });
    await expect(bridge.request(request('notifications.v2.register', { protocol: 'mpgd.notifications.v2' })))
      .resolves.toMatchObject({ ok: true, data: { registration: { provider: 'devvit', address: { kind: 'platform-user' } } } });
    await expect(bridge.request(request('notifications.v2.openSettings', { protocol: 'mpgd.notifications.v2' })))
      .resolves.toMatchObject({ ok: true, data: { status: 'unavailable' } });
  });

  it('answers the dedicated codes for bad payloads, local methods, other methods, and host failures', async () => {
    const { bridge, plugin } = handler();
    await expect(bridge.request(request('notifications.v2.requestPermission', { topics: [] })))
      .resolves.toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_INVALID_INPUT' } });
    await expect(bridge.request(request('notifications.v2.listLocal', { protocol: 'mpgd.notifications.v2' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_UNSUPPORTED', retryable: false } });
    await expect(bridge.request(request('storage.load', {})))
      .resolves.toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_METHOD' } });
    plugin.optInAnswers.push({ success: false });
    await expect(bridge.request(request('notifications.v2.requestPermission', { topics: ['friend-challenge'] })))
      .resolves.toMatchObject({
        ok: false,
        error: {
          code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
          message: expect.stringContaining('(host code DEVVIT_OPT_IN_REFUSED)'),
          retryable: false,
        },
      });
  });

  it('reports a logged-out viewer through the validated snapshot', async () => {
    const { bridge } = handler(null);
    await expect(bridge.request(request('notifications.v2.getPermission', { topics: ['friend-challenge'] })))
      .resolves.toMatchObject({ ok: true, data: { app: 'action-required', requiredAction: 'login' } });
  });
});
