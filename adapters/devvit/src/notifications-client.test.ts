import { describe, expect, it } from 'vitest';

import type { BridgeRequest } from '@mpgd/bridge';
import { NotificationError } from '@mpgd/platform/notifications';

import { createFakeDevvitNotifications } from '../test/fake-devvit-notifications.js';
import { createDevvitBridgeNotificationProvider } from './notifications-client.js';
import { createDevvitNotificationsV2BridgeHandler } from './server/notifications-bridge.js';

const user = 't2_alice';

function request(method: string, payload: unknown): BridgeRequest {
  return {
    id: 'req-1',
    method: method as BridgeRequest['method'],
    payload,
    meta: { target: 'reddit', appVersion: '1', buildId: 'test', sentAt: '2026-10-19T00:00:00Z' },
  };
}

describe('createDevvitBridgeNotificationProvider host codes', () => {
  it('reads the host code from the exact message the server bridge writes', async () => {
    const plugin = createFakeDevvitNotifications({ currentUserId: user });
    plugin.optInAnswers.push({ success: false, message: 'App is not approved for notifications' });
    const bridge = createDevvitNotificationsV2BridgeHandler({
      notifications: plugin,
      currentUserId: () => plugin.currentUserId,
      topics: ['friend-challenge'],
    });
    const response = await bridge.request(request('notifications.v2.requestPermission', {
      topics: ['friend-challenge'],
    }));
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error('expected the server bridge to refuse the opt-in');
    }
    expect(response.error.message).toBe('Devvit refused the opt-in. (host code DEVVIT_OPT_IN_REFUSED)');
    const provider = createDevvitBridgeNotificationProvider({
      request: () => Promise.reject(response.error),
    });
    const failure = await provider.requestPermission({ topics: ['friend-challenge'] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotificationError);
    expect(failure).toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      hostCode: 'DEVVIT_OPT_IN_REFUSED',
    });
  });
});
