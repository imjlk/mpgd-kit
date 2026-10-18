import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BridgeNotificationsEvent } from '@mpgd/bridge';
import type { NotificationEvent } from '@mpgd/platform/notifications';

import * as bridgeClient from './notifications-bridge.js';
import {
  createLazyAitBridgeNotificationProvider,
  type AitBridgeNotificationClientModule,
} from './notifications-lazy.js';

// Every test injects the loader, so nothing here waits on a real dynamic
// import or on wall-clock time: each load is a promise the test settles.

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

/** A loader whose every call returns a promise the test settles. */
function controlledLoader() {
  const pending: {
    readonly promise: Promise<AitBridgeNotificationClientModule>;
    readonly resolve: () => Promise<void>;
    readonly reject: () => Promise<void>;
  }[] = [];
  const load = (): Promise<AitBridgeNotificationClientModule> => {
    let resolve!: (module: AitBridgeNotificationClientModule) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<AitBridgeNotificationClientModule>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    pending.push({
      promise,
      // Settling, then awaiting the same promise, runs after the provider's
      // own handler, which `load()` in notifications-lazy.ts registers
      // synchronously when it starts the load.
      async resolve() {
        resolve(bridgeClient);
        await promise;
      },
      async reject() {
        reject(new Error('chunk missing'));
        await promise.catch(() => undefined);
      },
    });
    return promise;
  };
  return {
    load,
    get calls() {
      return pending.length;
    },
    call(index: number) {
      const entry = pending[index];
      if (entry === undefined) {
        throw new Error(`No load call ${index}.`);
      }
      return entry;
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
    const loader = controlledLoader();
    const events = channel();
    const provider = createLazyAitBridgeNotificationProvider(
      {
        provider: 'apps-in-toss',
        request: async () => ({ topics: { a: 'unknown' } }),
        subscribe: (listener) => events.subscribe(listener),
      },
      { load: loader.load },
    );
    // The provider starts loading at once, and loads once.
    expect(loader.calls).toBe(1);
    const seen: NotificationEvent[] = [];
    provider.subscribe((event) => seen.push(event));
    // Not attached yet: the host keeps its cold open for its first listener.
    expect(events.attached).toBe(0);
    await loader.call(0).resolve();
    expect(events.attached).toBe(1);
    events.emit(opened('/a'));
    events.emit(opened('/b', 1));
    expect(routes(seen)).toEqual(['/a', '/b']);
    // Once loaded, a later subscriber attaches at once.
    provider.subscribe(() => {});
    expect(events.attached).toBe(2);
    await expect(provider.getPermission({ topics: ['a'] })).resolves.toEqual({
      topics: { a: 'unknown' },
    });
    expect(loader.calls).toBe(1);
  });

  it('detaches a listener that leaves during the host replay and isolates a throwing attach', async () => {
    const loader = controlledLoader();
    const listeners = new Set<(event: BridgeNotificationsEvent) => void>();
    let subscribeCalls = 0;
    const provider = createLazyAitBridgeNotificationProvider(
      {
        provider: 'apps-in-toss',
        request: async () => ({ topics: {} }),
        subscribe: (listener) => {
          subscribeCalls += 1;
          if (subscribeCalls === 2) {
            throw new Error('host refused');
          }
          listeners.add(listener);
          // The host replays what it buffered synchronously to a new listener.
          listener(opened('/cold'));
          listener(opened('/second', 1));
          return () => {
            listeners.delete(listener);
          };
        },
      },
      { load: loader.load },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: NotificationEvent[] = [];
    let unsubscribe: () => void = () => {};
    unsubscribe = provider.subscribe((event) => {
      seen.push(event);
      unsubscribe();
    });
    const other: NotificationEvent[] = [];
    provider.subscribe((event) => other.push(event));
    const third: NotificationEvent[] = [];
    provider.subscribe((event) => third.push(event));
    await loader.call(0).resolve();
    expect(subscribeCalls).toBe(3);
    // It left on the first event, so the second one of the replay is not delivered.
    expect(routes(seen)).toEqual(['/cold']);
    // The first listener left during the replay: its host listener is gone.
    expect(listeners.size).toBe(1);
    // The second attach threw and was reported; the third still attached, once.
    expect(routes(third)).toEqual(['/cold', '/second']);
    expect(other).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    await provider.getPermission({ topics: [] });
    expect(subscribeCalls).toBe(3);
  });

  it('never attaches a subscriber that left before the client loaded', async () => {
    const loader = controlledLoader();
    const events = channel();
    const provider = createLazyAitBridgeNotificationProvider(
      {
        provider: 'apps-in-toss',
        request: async () => ({ topics: {} }),
        subscribe: (listener) => events.subscribe(listener),
      },
      { load: loader.load },
    );
    const unsubscribe = provider.subscribe(() => {});
    unsubscribe();
    await loader.call(0).resolve();
    expect(events.attached).toBe(0);
  });

  it('rejects with a retryable error while the client cannot load, then attaches waiting subscribers', async () => {
    // The failed load schedules a retry timer; fake timers keep it inert.
    vi.useFakeTimers();
    const loader = controlledLoader();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = channel();
    const provider = createLazyAitBridgeNotificationProvider(
      {
        provider: 'apps-in-toss',
        request: async () => ({ topics: { a: 'unknown' } }),
        subscribe: (listener) => events.subscribe(listener),
      },
      { load: loader.load },
    );
    const seen: NotificationEvent[] = [];
    provider.subscribe((event) => seen.push(event));
    const failed = provider.getPermission({ topics: ['a'] });
    await loader.call(0).reject();
    await expect(failed).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
    expect(events.attached).toBe(0);
    // The next call loads again; the waiting subscriber attaches with it.
    const retried = provider.getPermission({ topics: ['a'] });
    expect(loader.calls).toBe(2);
    await loader.call(1).resolve();
    await expect(retried).resolves.toEqual({ topics: { a: 'unknown' } });
    expect(events.attached).toBe(1);
    events.emit(opened('/late'));
    expect(routes(seen)).toEqual(['/late']);
  });

  it('retries a failed load on its own while a subscriber waits', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loader = controlledLoader();
    const events = channel();
    const provider = createLazyAitBridgeNotificationProvider(
      {
        provider: 'apps-in-toss',
        request: async () => ({ topics: {} }),
        subscribe: (listener) => events.subscribe(listener),
      },
      { load: loader.load },
    );
    provider.subscribe(() => {});
    await loader.call(0).reject();
    expect(events.attached).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(loader.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(loader.calls).toBe(2);
    await loader.call(1).resolve();
    expect(events.attached).toBe(1);
  });

  it('retries on a 1, 4, 15 second schedule only while someone waits, then gives up', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loader = controlledLoader();
    const quiet = createLazyAitBridgeNotificationProvider(
      {
        provider: 'apps-in-toss',
        request: async () => ({ topics: {} }),
        subscribe: () => () => {},
      },
      { load: loader.load },
    );
    await loader.call(0).reject();
    // Nobody waited on the eager load: no retry is scheduled.
    expect(vi.getTimerCount()).toBe(0);
    const unsubscribe = quiet.subscribe(() => {});
    expect(loader.calls).toBe(2);
    await loader.call(1).reject();
    expect(vi.getTimerCount()).toBe(1);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(1_000);
    // The timer fired with nobody waiting: no load, no further timer.
    expect(loader.calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    quiet.subscribe(() => {});
    expect(loader.calls).toBe(3);
    await loader.call(2).reject();
    let call = 3;
    for (const delay of [4_000, 15_000]) {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay);
      expect(loader.calls).toBe(call + 1);
      await loader.call(call).reject();
      call += 1;
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('did not load; waiting subscribers attach'),
    );
  });
});
