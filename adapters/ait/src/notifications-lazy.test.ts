import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BridgeNotificationsEvent } from '@mpgd/bridge';
import type { NotificationEvent } from '@mpgd/platform/notifications';

afterEach(() => {
  vi.doUnmock('./notifications-bridge.js');
  vi.resetModules();
});

function channel() {
  const listeners = new Set<(event: BridgeNotificationsEvent) => void>();
  return {
    subscribe(listener: (event: BridgeNotificationsEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: BridgeNotificationsEvent) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

const opened = (route: string): BridgeNotificationsEvent => ({
  protocol: 'mpgd.notifications.v2',
  sequence: 0,
  event: { type: 'opened', channel: 'remote', source: 'cold', route },
});

describe('createLazyAitBridgeNotificationProvider', () => {
  it('keeps events emitted while the client loads and delivers them in order', async () => {
    const { createLazyAitBridgeNotificationProvider } = await import('./notifications-lazy.js');
    const events = channel();
    const provider = createLazyAitBridgeNotificationProvider({
      provider: 'apps-in-toss',
      request: async () => ({ topics: { a: 'unknown' } }),
      subscribe: (listener) => events.subscribe(listener),
    });
    const seen: NotificationEvent[] = [];
    provider.subscribe((event) => seen.push(event));
    events.emit(opened('/a'));
    events.emit({ ...opened('/b'), sequence: 1 });
    expect(seen).toEqual([]);
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    events.emit({ ...opened('/c'), sequence: 2 });
    expect(seen.map((event) => (event.type === 'opened' ? event.route : undefined)))
      .toEqual(['/a', '/b', '/c']);
    await expect(provider.getPermission({ topics: ['a'] })).resolves.toEqual({
      topics: { a: 'unknown' },
    });
  });

  it('drops nothing for an unsubscribed listener and delivers nothing after it leaves', async () => {
    const { createLazyAitBridgeNotificationProvider } = await import('./notifications-lazy.js');
    const events = channel();
    const provider = createLazyAitBridgeNotificationProvider({
      provider: 'apps-in-toss',
      request: async () => undefined,
      subscribe: (listener) => events.subscribe(listener),
    });
    const seen: NotificationEvent[] = [];
    const unsubscribe = provider.subscribe((event) => seen.push(event));
    events.emit(opened('/a'));
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.emit(opened('/b'));
    expect(seen).toEqual([]);
  });

  it('rejects with a retryable error while the client cannot load, and loads on a later call', async () => {
    vi.doMock('./notifications-bridge.js', () => {
      throw new Error('chunk missing');
    });
    const { createLazyAitBridgeNotificationProvider } = await import('./notifications-lazy.js');
    const provider = createLazyAitBridgeNotificationProvider({
      provider: 'apps-in-toss',
      request: async () => ({ topics: { a: 'unknown' } }),
      subscribe: () => () => {},
    });
    await expect(provider.getPermission({ topics: ['a'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
    vi.doUnmock('./notifications-bridge.js');
    await expect(provider.getPermission({ topics: ['a'] })).resolves.toEqual({
      topics: { a: 'unknown' },
    });
  });
});
