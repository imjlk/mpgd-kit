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
    get attached() {
      return listeners.size;
    },
    subscribe(listener: (event: BridgeNotificationsEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: BridgeNotificationsEvent) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

const opened = (route: string, sequence = 0): BridgeNotificationsEvent => ({
  protocol: 'mpgd.notifications.v2',
  sequence,
  event: { type: 'opened', channel: 'remote', source: 'cold', route },
});

const routes = (events: readonly NotificationEvent[]) =>
  events.map((event) => (event.type === 'opened' ? event.route : undefined));

describe('createLazyAitBridgeNotificationProvider', () => {
  it('attaches to the bridge channel once the client has loaded, then delivers in order', async () => {
    const { createLazyAitBridgeNotificationProvider } = await import('./notifications-lazy.js');
    const events = channel();
    const provider = createLazyAitBridgeNotificationProvider({
      provider: 'apps-in-toss',
      request: async () => ({ topics: { a: 'unknown' } }),
      subscribe: (listener) => events.subscribe(listener),
    });
    const seen: NotificationEvent[] = [];
    provider.subscribe((event) => seen.push(event));
    // Not attached yet: the host keeps its cold open for its first listener.
    await vi.waitFor(() => expect(events.attached).toBe(1));
    events.emit(opened('/a'));
    events.emit(opened('/b', 1));
    expect(routes(seen)).toEqual(['/a', '/b']);
    // Once loaded, a later subscriber attaches at once.
    provider.subscribe(() => {});
    expect(events.attached).toBe(2);
    await expect(provider.getPermission({ topics: ['a'] })).resolves.toEqual({
      topics: { a: 'unknown' },
    });
  });

  it('never attaches a subscriber that left before the client loaded', async () => {
    const { createLazyAitBridgeNotificationProvider } = await import('./notifications-lazy.js');
    const events = channel();
    const provider = createLazyAitBridgeNotificationProvider({
      provider: 'apps-in-toss',
      request: async () => ({ topics: {} }),
      subscribe: (listener) => events.subscribe(listener),
    });
    const unsubscribe = provider.subscribe(() => {});
    unsubscribe();
    await provider.getPermission({ topics: [] }).catch(() => undefined);
    expect(events.attached).toBe(0);
  });

  it('rejects with a retryable error while the client cannot load, then attaches waiting subscribers', async () => {
    vi.doMock('./notifications-bridge.js', () => {
      throw new Error('chunk missing');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { createLazyAitBridgeNotificationProvider } = await import('./notifications-lazy.js');
      const events = channel();
      const provider = createLazyAitBridgeNotificationProvider({
        provider: 'apps-in-toss',
        request: async () => ({ topics: { a: 'unknown' } }),
        subscribe: (listener) => events.subscribe(listener),
      });
      const seen: NotificationEvent[] = [];
      provider.subscribe((event) => seen.push(event));
      await expect(provider.getPermission({ topics: ['a'] })).rejects.toMatchObject({
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        retryable: true,
      });
      expect(events.attached).toBe(0);
      vi.doUnmock('./notifications-bridge.js');
      await expect(provider.getPermission({ topics: ['a'] })).resolves.toEqual({
        topics: { a: 'unknown' },
      });
      expect(events.attached).toBe(1);
      events.emit(opened('/late'));
      expect(routes(seen)).toEqual(['/late']);
    } finally {
      warn.mockRestore();
    }
  });
});
