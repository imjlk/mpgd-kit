import { describe, expect, it } from 'vitest';

import type { BridgeRequest } from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';
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

  it('answers an unmapped topic unsupported and unavailable for a logged-out viewer too', async () => {
    const plugin = createFakeDevvitNotifications();
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    await expect(provider.getPermission({ topics: ['friend-challenge', 'unmapped'] })).resolves.toEqual({
      app: 'action-required',
      topics: { 'friend-challenge': 'action-required', unmapped: 'unsupported' },
      requiredAction: 'login',
    });
    for (const call of [provider.requestPermission, provider.revokePermission]) {
      await expect(call?.call(provider, { topics: ['friend-challenge', 'unmapped'] })).resolves.toMatchObject({
        outcomes: { 'friend-challenge': 'action-required', unmapped: 'unavailable' },
        requiredAction: 'login',
      });
    }
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
      snapshot: { app: 'granted', topics: { 'friend-challenge': 'granted', unmapped: 'unsupported' } },
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

  it('reads unmapped topics as unsupported and revokes only mapped ones', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    plugin.optedIn.add(user);
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    await expect(provider.getPermission({ topics: ['friend-challenge', 'unmapped'] })).resolves.toEqual({
      app: 'granted',
      topics: { 'friend-challenge': 'granted', unmapped: 'unsupported' },
    });
    // Only unmapped topics: nothing is opted out.
    await expect(provider.revokePermission?.({ topics: ['unmapped'] })).resolves.toEqual({
      snapshot: { app: 'granted', topics: { unmapped: 'unsupported' } },
      outcomes: { unmapped: 'unavailable' },
    });
    expect(plugin.optOutCalls).toBe(0);
    await expect(provider.revokePermission?.({ topics: ['friend-challenge', 'unmapped'] })).resolves.toEqual({
      snapshot: { app: 'prompt', topics: { 'friend-challenge': 'prompt', unmapped: 'unsupported' } },
      outcomes: { 'friend-challenge': 'denied', unmapped: 'unavailable' },
    });
    expect(plugin.optOutCalls).toBe(1);
  });

  it('answers a revocation with the state the opt-out produced, not a later read', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    plugin.optedIn.add(user);
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    // A read after the opt-out would still see the user in (eventual consistency).
    plugin.optOutCurrentUser = async () => ({ success: true });
    await expect(provider.revokePermission?.({ topics: ['friend-challenge'] })).resolves.toEqual({
      snapshot: { app: 'prompt', topics: { 'friend-challenge': 'prompt' } },
      outcomes: { 'friend-challenge': 'denied' },
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
      snapshot: { app: 'prompt', topics: { other: 'unsupported' } },
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

  it('opts out only a user who is opted in', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    plugin.optOutCurrentUser = () => Promise.resolve({ success: false });
    const provider = createDevvitServerNotificationProvider({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
    });
    await expect(provider.revokePermission?.({ topics })).resolves.toMatchObject({
      outcomes: { 'friend-challenge': 'denied' },
      snapshot: { app: 'prompt' },
    });
  });

  it("keeps the plugin's error text on the server and reports it there", async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    plugin.isOptedIn = () => Promise.reject(new Error('redis://internal-host:6379 timed out'));
    const reported: { method: string; cause: unknown }[] = [];
    const bridge = createDevvitNotificationsV2BridgeHandler({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
      onError: (error, { method }) => {
        reported.push({ method, cause: (error as { cause?: unknown }).cause });
      },
    });
    const response = await bridge.request(request('notifications.v2.getPermission', { topics: ['friend-challenge'] }));
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain('internal-host');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.method).toBe('notifications.v2.getPermission');
    expect(String(reported[0]?.cause)).toContain('internal-host');
    // A hook that rejects or throws changes nothing.
    const quiet = createDevvitNotificationsV2BridgeHandler({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics,
      onError: (() => Promise.reject(new Error('log sink down'))) as unknown as () => void,
    });
    await expect(quiet.request(request('notifications.v2.getPermission', { topics: ['friend-challenge'] })))
      .resolves.toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' } });
    // A refused opt-in keeps Devvit's message on the server too.
    plugin.isOptedIn = async () => false;
    plugin.optInAnswers.push({ success: false, message: 'internal approval queue 7' });
    const refused = await bridge.request(request('notifications.v2.requestPermission', { topics: ['friend-challenge'] }));
    expect(JSON.stringify(refused)).not.toContain('approval queue');
    expect(reported).toHaveLength(2);
    expect(String(reported[1]?.cause)).toContain('approval queue');
    // An invalid payload is the caller's, not reported.
    await bridge.request(request('notifications.v2.requestPermission', { topics: [] }));
    expect(reported).toHaveLength(2);
  });

  it('refuses an opt-out Devvit refused', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    plugin.optedIn.add(user);
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

  it('keeps the retryable flag of a failure that is not a notifications code', async () => {
    const { plugin } = handler();
    const raw = createDevvitNotificationsV2BridgeHandler({
      notifications: plugin,
      currentUserId: () => {
        throw new PlatformOperationError({ code: 'CONTEXT_FAILED', message: 'no context', retryable: false });
      },
      topics,
    });
    await expect(raw.request(request('notifications.v2.getPermission', { topics: ['friend-challenge'] })))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: false },
      });
  });

  it('reports a logged-out viewer through the validated snapshot', async () => {
    const { bridge } = handler(null);
    await expect(bridge.request(request('notifications.v2.getPermission', { topics: ['friend-challenge'] })))
      .resolves.toMatchObject({ ok: true, data: { app: 'action-required', requiredAction: 'login' } });
  });
});
