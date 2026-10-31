import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { StorageAdapter } from './index.js';
import {
  createNotificationConformanceBackend,
  createNotificationConformanceClock,
  createNotificationConformanceHost,
  notificationConformanceRegistryEntry,
} from './notifications-conformance.js';
import {
  createMemoryNotificationRuntimeStorage,
  createNotificationRuntime,
  createNotificationRuntimeStorage,
  defaultNotificationRuntimeStorageKey,
  notificationRuntimeStateOf,
  type NotificationRuntimeBackend,
  type NotificationRuntimeSession,
  type NotificationRuntimeState,
  type NotificationRuntimeStorage,
} from './notifications-runtime.js';
import {
  notificationDefaultDeploymentTimeZone,
  NotificationError,
  type NotificationTopicDeclaration,
} from './notifications.js';
import { assertNotificationConformanceVector } from './notifications-vectors.js';

/**
 * The production runtime's own surface: the storage port, the defaults, and
 * `onError`. Its rules are pinned by the conformance vectors, which the
 * runner drives through this runtime.
 */

const vector = assertNotificationConformanceVector(JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'docs', 'specs', 'notifications', 'vectors', 'os-permission-granted.json'),
  'utf8',
)) as unknown);
const osProfile = vector.profile;
const now = '2026-10-12T03:00:00Z';
const energy: NotificationTopicDeclaration = {
  id: 'energy-full',
  purpose: 'requested',
  channels: ['local', 'remote'],
  route: '/?entry=continue',
  copy: { ko: { title: '에너지 충전 완료', body: '에너지가 가득 찼어요.' } },
  mapping: { channelId: 'reminders' },
};

/** A device player's fake host and backend, and a runtime over `storage`. */
function setup(storage?: NotificationRuntimeStorage, options: { readonly onError?: (error: unknown) => void } = {}) {
  const clock = createNotificationConformanceClock(now);
  const host = createNotificationConformanceHost({
    profile: osProfile,
    catalog: [energy],
    timeZone: 'Asia/Seoul',
  });
  const entry = notificationConformanceRegistryEntry({
    provider: osProfile.provider,
    capabilities: osProfile.capabilities,
  });
  const backend = createNotificationConformanceBackend({
    entry,
    catalog: [energy],
    clock,
    defaultLocale: 'ko',
    defaultPlayer: 'p-1',
  });
  const create = (client: NotificationRuntimeBackend = backend) => createNotificationRuntime({
    provider: host.provider,
    backend: client,
    catalog: [energy],
    clock,
    defaultLocale: 'ko',
    ...(storage === undefined ? {} : { storage }),
    ...(entry === undefined ? {} : { registryEntry: entry }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return { clock, host, backend, create };
}

/** The fake backend as a plain runtime backend, with some calls replaced. */
function clientOf(
  backend: NotificationRuntimeBackend,
  overrides: Partial<NotificationRuntimeBackend> = {},
): NotificationRuntimeBackend {
  return {
    session: () => backend.session(),
    onAuthenticated: (listener) => backend.onAuthenticated(listener),
    recordConsent: (record) => backend.recordConsent(record),
    listConsent: () => backend.listConsent(),
    registerEndpoint: (registration) => backend.registerEndpoint(registration),
    unregisterEndpoint: (input) => backend.unregisterEndpoint(input),
    setReminder: (input) => backend.setReminder(input),
    cancelReminder: (input) => backend.cancelReminder(input),
    listNotices: () => backend.listNotices(),
    recordNotice: (input) => backend.recordNotice(input),
    ...overrides,
  };
}

/** A storage port over a plain value whose load and save settle asynchronously. */
function asyncStorage(initial?: unknown) {
  let stored = initial;
  const saves: NotificationRuntimeState[] = [];
  let failLoads = 0;
  let failSaves = 0;
  const port: NotificationRuntimeStorage = {
    async load() {
      await Promise.resolve();
      if (failLoads > 0) {
        failLoads -= 1;
        throw new Error('disk unavailable');
      }
      return stored;
    },
    async save(state) {
      await Promise.resolve();
      if (failSaves > 0) {
        failSaves -= 1;
        throw new Error('disk full');
      }
      stored = state;
      saves.push(state);
    },
  };
  return {
    port,
    saves,
    reset() {
      stored = undefined;
    },
    get stored() {
      return stored;
    },
    failNextLoads(count: number) {
      failLoads = count;
    },
    failNextSaves(count: number) {
      failSaves = count;
    },
  };
}

describe('createNotificationRuntime storage', () => {
  it('persists the acknowledged registration and skips an identical one after a restart', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.runUntilIdle();
    expect(storage.stored).toMatchObject({
      registration: {
        player: 'p-1',
        session: 'session-1',
        registration: { provider: osProfile.provider, address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' } },
      },
    });
    const registered = backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt);
    runtime.stop();

    // A restart in the same session reads the stored registration and sends nothing new.
    const restarted = create();
    await restarted.start();
    await restarted.getPermission({ topics: ['energy-full'] });
    await restarted.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt)).toEqual(registered);
  });

  it('registers at start for a session that began while the runtime was not listening', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.session)).toEqual(['session-1']);
    runtime.stop();

    // The player signs in again while no runtime listens; the next runtime's start binds the new session.
    backend.authenticate('p-2');
    const restarted = create();
    await restarted.start();
    await restarted.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.player, endpoint.session])).toEqual([['p-2', 'session-2']]);
    // Its own session is acknowledged now: the next start sends nothing new.
    const registered = backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt);
    restarted.stop();
    const again = create();
    await again.start();
    await again.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt)).toEqual(registered);
  });

  it('keeps unregister() across a restart until the next authentication', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.runUntilIdle();
    await runtime.unregister();
    expect(storage.stored).toEqual({ unbound: true, unboundSession: { player: 'p-1', session: 'session-1' } });
    expect(backend.endpoints).toEqual([]);
    runtime.stop();

    const restarted = create();
    await restarted.start();
    // A rotated token after the restart binds nothing while unbound.
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-2' });
    await restarted.getPermission({ topics: ['energy-full'] });
    await restarted.runUntilIdle();
    expect(backend.endpoints).toEqual([]);

    // The next authentication binds again and clears the stored flag.
    backend.authenticate('p-1');
    await restarted.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.value, endpoint.player])).toEqual([['tok-2', 'p-1']]);
    expect(storage.stored).not.toHaveProperty('unbound');
  });

  it('saves the unbound state even when the unbind fails, and throws the unbind error', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    const offline = new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: 'offline' });
    const runtime = create(clientOf(backend, {
      unregisterEndpoint: async () => {
        throw offline;
      },
    }));
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.runUntilIdle();
    await expect(runtime.unregister()).rejects.toBe(offline);
    expect(storage.stored).toMatchObject({ unbound: true });
  });

  it('answers NOTIFICATIONS_TEMPORARILY_UNAVAILABLE when the state cannot be read, and reads again later', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    // The load when the runtime is created and the one the authentication needs both fail.
    storage.failNextLoads(2);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    const failure = await runtime.runUntilIdle().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NotificationError);
    expect((failure as NotificationError).code).toBe('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
    expect((failure as NotificationError).message).toContain('disk unavailable');
    // Nothing was bound on a state the runtime could not read.
    expect(backend.endpoints).toEqual([]);
    // The next call reads the state again.
    await runtime.register();
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
    expect(storage.stored).toMatchObject({ registration: { player: 'p-1' } });
  });

  it('answers NOTIFICATIONS_TEMPORARILY_UNAVAILABLE for a storage failure whose value cannot be read', async () => {
    const hostile = (): never => {
      throw new Error('hostile read');
    };
    const thrown = [
      new Proxy({}, { get: hostile, getPrototypeOf: hostile }),
      { toString: hostile },
      Object.defineProperty(new Error('hidden'), 'message', { get: hostile }),
    ];
    for (const value of thrown) {
      let loads = 0;
      const { host, backend, create } = setup({
        load() {
          loads += 1;
          if (loads <= 2) {
            throw value;
          }
          return {};
        },
        save: () => undefined,
      });
      host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
      const runtime = create();
      await runtime.start();
      backend.authenticate('p-1');
      const failure = await runtime.runUntilIdle().then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(NotificationError);
      expect((failure as NotificationError).code).toBe('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
      expect((failure as NotificationError).message).toContain('a failure that cannot be read');
      expect((failure as NotificationError).cause).toBe(value);
    }
  });

  it('surfaces a failed save as NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    storage.failNextSaves(1);
    const error = await runtime.register().then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(NotificationError);
    expect((error as NotificationError).code).toBe('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
    expect((error as NotificationError).retryable).toBe(true);
  });

  it('sends a registration again when saving its acknowledgement failed', async () => {
    const storage = asyncStorage();
    const { clock, host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    storage.failNextSaves(1);
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await expect(runtime.runUntilIdle()).rejects.toBeInstanceOf(NotificationError);
    const sent = backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt);
    expect(sent).toHaveLength(1);
    clock.advance(60);
    // The same address again: nothing was kept as acknowledged, so it is sent, and kept this time.
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt)).not.toEqual(sent);
    expect(storage.stored).toMatchObject({ registration: { player: 'p-1' } });
  });

  it('still unbinds when the stored state cannot be read, and saves the unbound state', async () => {
    const storage = asyncStorage();
    const { clock, host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.runUntilIdle();
    // A second runtime whose loads fail logs the same player out.
    storage.failNextLoads(2);
    runtime.stop();
    const errors: unknown[] = [];
    const restarted = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      clock,
      defaultLocale: 'ko',
      storage: storage.port,
      onError: (error) => errors.push(error),
    });
    // The unbind reached the backend, so the logout succeeds; the storage's failure is reported.
    await restarted.unregister();
    expect(backend.endpoints).toEqual([]);
    expect(storage.stored).toEqual({ unbound: true, unboundSession: { player: 'p-1', session: 'session-1' } });
    expect(errors).toHaveLength(1);
    expect((errors[0] as NotificationError).code).toBe('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
    expect((errors[0] as NotificationError).message).toContain('could not read');
  });

  it('resolves unregister() when only saving after the unbind fails, and binds again at the next authentication', async () => {
    const storage = asyncStorage();
    const errors: unknown[] = [];
    const { clock, host, backend, create } = setup(storage.port, { onError: (error) => errors.push(error) });
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.runUntilIdle();
    // The save before the unbind goes through; the one after it fails.
    let saves = 0;
    const flaky = storage.port;
    const port: NotificationRuntimeStorage = {
      load: () => flaky.load(),
      save(state) {
        saves += 1;
        if (saves === 2) {
          throw new Error('disk full');
        }
        return flaky.save(state);
      },
    };
    runtime.stop();
    const restarted = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      clock,
      defaultLocale: 'ko',
      storage: port,
      onError: (error) => errors.push(error),
    });
    await restarted.start();
    await restarted.unregister();
    expect(backend.endpoints).toEqual([]);
    expect(errors.map((error) => (error as Error).message)).toEqual([
      expect.stringContaining('could not save'),
    ]);
    // Storage still names the registration it had before the unbind, next to the unbound state.
    expect(storage.stored).toMatchObject({ unbound: true, registration: { session: 'session-1' } });
    errors.length = 0;
    await restarted.runUntilIdle().catch(() => undefined);
    restarted.stop();

    // A restart in the same session stays unbound at start.
    let announce: ((session: NotificationRuntimeSession) => void) | undefined;
    const again = create(clientOf(backend, {
      onAuthenticated(listener) {
        announce = listener;
        return () => undefined;
      },
    }));
    await again.start();
    await again.runUntilIdle();
    expect(backend.endpoints).toEqual([]);
    // An authentication of that same session binds again, although storage still names its registration.
    const signedIn = backend.session();
    expect(signedIn?.id).toBe('session-1');
    if (signedIn !== undefined) {
      announce?.(signedIn);
    }
    await again.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.value, endpoint.player, endpoint.session])).toEqual([
      ['tok-1', 'p-1', 'session-1'],
    ]);
  });

  it('binds again at start for a sign-in after unregister() that the runtime did not observe', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    await runtime.unregister();
    runtime.stop();
    expect(backend.endpoints).toEqual([]);
    // The next player signs in while no runtime listens.
    backend.authenticate('p-2');
    const restarted = create();
    await restarted.start();
    await restarted.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.player, endpoint.session])).toEqual([['p-2', 'session-2']]);
    expect(storage.stored).not.toHaveProperty('unbound');
  });

  it('binds again for any sign-in after an unregister() made while signed out, and keeps an earlier session', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    await runtime.unregister();
    // The session ends; a second unregister() while signed out keeps the session the first one left.
    backend.revokeSession();
    await runtime.unregister();
    expect(storage.stored).toEqual({ unbound: true, unboundSession: { player: 'p-1', session: 'session-1' } });
    runtime.stop();
    // Signed out at the unbind, with nothing kept: any later session is a sign-in.
    storage.reset();
    const signedOut = create();
    await signedOut.start();
    await signedOut.unregister();
    expect(storage.stored).toEqual({ unbound: true });
    signedOut.stop();
    backend.authenticate('p-2');
    const restarted = create();
    await restarted.start();
    await restarted.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.player, endpoint.session])).toEqual([['p-2', 'session-2']]);
  });

  it('binds again on a read, not only at start, and stays unbound on a read in the session it left', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    let announce: ((session: NotificationRuntimeSession) => void) | undefined;
    // A backend whose sign-ins the runtime never hears about.
    const runtime = create(clientOf(backend, {
      onAuthenticated(listener) {
        announce = listener;
        return () => undefined;
      },
    }));
    await runtime.start();
    backend.authenticate('p-1');
    expect(announce).toBeDefined();
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    await runtime.unregister();
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(backend.endpoints).toEqual([]);
    backend.authenticate('p-2');
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.player, endpoint.session])).toEqual([['p-2', 'session-2']]);
  });

  it('keeps the unbound state in memory when clearing it cannot be saved', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    await runtime.unregister();
    storage.failNextSaves(1);
    await expect(runtime.register()).rejects.toBeInstanceOf(NotificationError);
    expect(backend.endpoints).toEqual([]);
    // Memory still says unbound, as storage does, and the next register() binds.
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(backend.endpoints).toEqual([]);
    await runtime.register();
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
  });

  it('registers at start for a session signed in before the runtime started', async () => {
    const storage = asyncStorage();
    const { host, backend, create } = setup(storage.port);
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    backend.authenticate('p-1');
    const runtime = create();
    await runtime.start();
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.value, endpoint.session])).toEqual([['tok-1', 'session-1']]);
    // A read later sends nothing more for the same session.
    const registered = backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt);
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt)).toEqual(registered);
  });

  it('throws the unbind error when the save fails too, and reports the save failure', async () => {
    const storage = asyncStorage();
    const errors: unknown[] = [];
    const { host, backend, create } = setup(storage.port, { onError: (error) => errors.push(error) });
    const offline = new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: 'offline' });
    const runtime = create(clientOf(backend, {
      unregisterEndpoint: async () => {
        throw offline;
      },
    }));
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    storage.failNextSaves(1);
    await expect(runtime.unregister()).rejects.toBe(offline);
    expect(errors).toHaveLength(1);
    expect((errors[0] as NotificationError).message).toContain('could not save');
    await expect(runtime.runUntilIdle()).rejects.toBe(errors[0]);
  });

  it('schedules a local reminder in the deployment zone when the stored state cannot be read', async () => {
    const storage = asyncStorage();
    storage.failNextLoads(1000);
    const { host, backend, create } = setup(storage.port);
    const runtime = create();
    await runtime.start();
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    const result = await runtime.reminders.set({
      key: 'energy',
      topic: 'energy-full',
      fireAt: '2026-10-12T05:00:00Z',
    });
    expect(result).toEqual({ route: 'local', status: 'scheduled' });
    expect(host.localPending.map((entry) => entry.key)).toEqual(['energy']);
    await expect(runtime.runUntilIdle()).rejects.toBeDefined();
  });

  /** A signed-in player with the topic on and one local reminder pending, over a counting backend. */
  async function withLocalReminder(
    overrides: (backend: NotificationRuntimeBackend) => Partial<NotificationRuntimeBackend> = () => ({}),
  ) {
    const { host, backend, create } = setup();
    const calls: string[] = [];
    const counted = clientOf(backend, {
      listConsent: async () => {
        calls.push('listConsent');
        return backend.listConsent();
      },
      recordConsent: async (record) => {
        calls.push('recordConsent');
        return backend.recordConsent(record);
      },
      ...overrides(backend),
    });
    const runtime = create(counted);
    await runtime.start();
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    expect(await runtime.reminders.set({ key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T05:00:00Z' }))
      .toEqual({ route: 'local', status: 'scheduled' });
    await runtime.runUntilIdle();
    calls.length = 0;
    return { host, backend, runtime, calls };
  }

  it('reads the records once for a read, its write, and its local sweep', async () => {
    const { host, backend, runtime, calls } = await withLocalReminder();
    // Another device turns the topic off: only the sweep after a read sees it.
    await backend.recordConsent({
      kind: 'topic-preference',
      topic: 'energy-full',
      state: 'withdrawn',
      source: 'player',
      at: '2026-10-12T03:00:01Z',
    });
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(host.localPending).toEqual([]);
    expect(calls).toEqual(['listConsent']);
  });

  it('reads the records again after the runtime wrote one since its read', async () => {
    const { runtime, calls } = await withLocalReminder();
    // The preference write between the two reads makes the first one stale.
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: false });
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(calls).toEqual(['listConsent', 'recordConsent', 'listConsent']);
  });

  it('cancels each local reminder alone when the host fails a batch, and throws for the one it cannot cancel', async () => {
    const { host, backend } = setup();
    const stuck = new Error('the host cannot cancel this one');
    const batches: (readonly string[])[] = [];
    const cancelLocal = host.provider.cancelLocal;
    const provider = {
      ...host.provider,
      cancelLocal: async (request: { readonly keys: readonly string[] }) => {
        batches.push([...request.keys]);
        if (request.keys.includes('stuck')) {
          throw stuck;
        }
        await cancelLocal?.call(host.provider, request);
      },
    };
    const runtime = createNotificationRuntime({ provider, backend, catalog: [energy], defaultLocale: 'ko' });
    await runtime.start();
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    for (const key of ['early', 'stuck', 'late']) {
      await runtime.reminders.set({ key, topic: 'energy-full', fireAt: '2026-10-12T05:00:00Z' });
    }
    await runtime.runUntilIdle();
    await expect(runtime.setTopicPreference({ topic: 'energy-full', enabled: false })).rejects.toBe(stuck);
    expect(host.localPending.map((entry) => entry.key)).toEqual(['stuck']);
    // One batch of three, then each key alone.
    const [batch, ...alone] = batches.slice(-4);
    expect([...(batch ?? [])].sort()).toEqual(['early', 'late', 'stuck']);
    expect(alone).toEqual((batch ?? []).map((key) => [key]));
  });

  it('still cancels local reminders the host reports revoked when the records cannot be read', async () => {
    const down = new Error('backend down');
    let failing = false;
    const { host, backend, runtime } = await withLocalReminder((inner) => ({
      listConsent: async () => {
        if (failing) {
          throw down;
        }
        return inner.listConsent();
      },
    }));
    // Permission turned off in system settings raises no event; the next sign-in reconciles.
    host.setPermission('denied');
    failing = true;
    backend.authenticate('p-1');
    await expect(runtime.runUntilIdle()).rejects.toBe(down);
    expect(host.localPending).toEqual([]);
  });

  it('reads a value that is not a runtime state as an empty one', () => {
    expect(notificationRuntimeStateOf(undefined)).toEqual({});
    expect(notificationRuntimeStateOf('x')).toEqual({});
    expect(notificationRuntimeStateOf([])).toEqual({});
    expect(notificationRuntimeStateOf({ unbound: 'yes' })).toEqual({});
    expect(notificationRuntimeStateOf({ registration: { player: 'p-1' } })).toEqual({});
    expect(notificationRuntimeStateOf({
      registration: { registration: { provider: 'fcm' }, player: 'p-1', session: 's-1', at: now },
    })).toEqual({});
    const registration = {
      registration: { provider: 'fcm', address: { kind: 'fcm-token', value: 't', permission: 'granted' } },
      player: 'p-1',
      session: 's-1',
      at: now,
    };
    expect(notificationRuntimeStateOf({ registration, unbound: true, extra: 1 })).toEqual({ registration, unbound: true });
    expect(notificationRuntimeStateOf({ unbound: true, unboundSession: { player: 'p-1', session: 's-1' } }))
      .toEqual({ unbound: true, unboundSession: { player: 'p-1', session: 's-1' } });
    // The session unregister() left means nothing without the unbound state, or without both fields.
    expect(notificationRuntimeStateOf({ unboundSession: { player: 'p-1', session: 's-1' } })).toEqual({});
    expect(notificationRuntimeStateOf({ unbound: true, unboundSession: { player: 'p-1' } })).toEqual({ unbound: true });
    expect(notificationRuntimeStateOf({ registration: { ...registration, at: 'yesterday' } })).toEqual({});
    expect(notificationRuntimeStateOf({
      registration: { ...registration, registration: { provider: 'fcm', address: [] } },
    })).toEqual({});
    expect(notificationRuntimeStateOf({
      registration: { ...registration, registration: { provider: 'fcm', address: { value: 't' } } },
    })).toEqual({});
  });

  it('leaves out a malformed or unreadable stored entry and keeps the others', () => {
    const registration = {
      registration: { provider: 'fcm', address: { kind: 'fcm-token', value: 't', permission: 'granted' } },
      player: 'p-1',
      session: 's-1',
      at: now,
    };
    const hostile = (): never => {
      throw new Error('hostile read');
    };
    // A malformed registration next to a good unbound state.
    expect(notificationRuntimeStateOf({
      registration: { ...registration, at: 42 },
      unbound: true,
      unboundSession: { player: 'p-1', session: 's-1' },
    })).toEqual({ unbound: true, unboundSession: { player: 'p-1', session: 's-1' } });
    // A good registration next to a malformed session.
    expect(notificationRuntimeStateOf({ registration, unbound: true, unboundSession: { player: 7 } }))
      .toEqual({ registration, unbound: true });
    // A getter that throws drops only its own entry.
    expect(notificationRuntimeStateOf({
      get registration(): unknown {
        return hostile();
      },
      unbound: true,
    })).toEqual({ unbound: true });
    expect(notificationRuntimeStateOf({
      registration,
      get unbound(): unknown {
        return hostile();
      },
    })).toEqual({ registration });
    // A registration whose own fields throw, or a Proxy whose traps throw.
    expect(notificationRuntimeStateOf({
      registration: { ...registration, get player(): unknown {
        return hostile();
      } },
      unbound: true,
    })).toEqual({ unbound: true });
    const trapped = new Proxy({}, { get: hostile, ownKeys: hostile, getOwnPropertyDescriptor: hostile });
    expect(notificationRuntimeStateOf({ registration: trapped, unbound: true })).toEqual({ unbound: true });
    expect(notificationRuntimeStateOf(trapped)).toEqual({});
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(notificationRuntimeStateOf(revocable.proxy)).toEqual({});
    expect(notificationRuntimeStateOf({ registration: revocable.proxy, unbound: true })).toEqual({ unbound: true });
    // What is kept is a plain copy, not the stored object.
    const kept = notificationRuntimeStateOf({ registration });
    expect(kept.registration).toEqual(registration);
    expect(kept.registration).not.toBe(registration);
  });

  it('reads a stored value whose fields cannot be read as an empty state', async () => {
    const hostile = (): never => {
      throw new Error('hostile read');
    };
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const stored of [new Proxy({}, { get: hostile, getPrototypeOf: hostile }), revocable.proxy]) {
      const { host, backend, create } = setup({ load: () => stored, save: () => undefined });
      backend.authenticate('p-1');
      host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
      const runtime = create();
      await runtime.start();
      await runtime.runUntilIdle();
      expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
    }
  });

  it('starts over a stored state with an unreadable entry and registers again', async () => {
    const stored = {
      get registration(): unknown {
        throw new Error('hostile read');
      },
      unbound: false,
    };
    const { host, backend, create } = setup({ load: () => stored, save: () => undefined });
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    const runtime = create();
    await runtime.start();
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
    await expect(runtime.getPermission({ topics: ['energy-full'] })).resolves.toBeDefined();
  });

  it('keeps the state in one storage key of the platform storage adapter', async () => {
    const values = new Map<string, unknown>();
    const adapter: StorageAdapter = {
      async load({ key }) {
        return values.has(key) ? { value: values.get(key) } : null;
      },
      async save({ key, value }) {
        values.set(key, value);
      },
    };
    const port = createNotificationRuntimeStorage({ storage: adapter });
    expect(await port.load()).toBeUndefined();
    await port.save({ unbound: true });
    expect([...values]).toEqual([[defaultNotificationRuntimeStorageKey, { unbound: true }]]);
    expect(await port.load()).toEqual({ unbound: true });
    const custom = createNotificationRuntimeStorage({ storage: adapter, key: 'game:notifications' });
    await custom.save({});
    expect(values.get('game:notifications')).toEqual({});
    expect(() => createNotificationRuntimeStorage({ storage: adapter, key: '' })).toThrow(NotificationError);
  });

  it('keeps the state in memory without a storage port', async () => {
    const memory = createMemoryNotificationRuntimeStorage();
    expect(memory.load()).toEqual({});
    await memory.save({ unbound: true });
    expect(memory.load()).toEqual({ unbound: true });
  });
});

/** Lets a background load answer: it is neither awaited by start() nor by runUntilIdle(). */
const settleLoad = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createNotificationRuntime registry entry', () => {
  it('compares the provider with an entry loaded in the background at start', async () => {
    const { host, backend } = setup();
    const entry = notificationConformanceRegistryEntry({ provider: osProfile.provider, capabilities: osProfile.capabilities });
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }
    const create = (loadRegistryEntry: () => Promise<typeof entry | undefined>, onError?: (error: unknown) => void) =>
      createNotificationRuntime({
        provider: host.provider,
        backend,
        catalog: [energy],
        defaultLocale: 'ko',
        loadRegistryEntry,
        ...(onError === undefined ? {} : { onError }),
      });
    // An entry that disagrees with the provider turns every call into a configuration error once loaded.
    const mismatched = create(async () => ({ ...entry, addressing: 'platform-user' }));
    await mismatched.start();
    await settleLoad();
    await expect(mismatched.getPermission({ topics: ['energy-full'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    });
    // A matching entry passes.
    const matching = create(async () => entry);
    await matching.start();
    await settleLoad();
    await expect(matching.getPermission({ topics: ['energy-full'] })).resolves.toBeDefined();
    // A load that fails is reported once, the runtime works without it, and the next start loads again.
    const errors: unknown[] = [];
    let loads = 0;
    const unreachable = create(async () => {
      loads += 1;
      if (loads === 1) {
        throw new Error('Worker unreachable');
      }
      return { ...entry, addressing: 'platform-user' };
    }, (error) => errors.push(error));
    await unreachable.start();
    await settleLoad();
    await expect(unreachable.runUntilIdle()).rejects.toThrow('Worker unreachable');
    expect(errors).toHaveLength(1);
    await expect(unreachable.getPermission({ topics: ['energy-full'] })).resolves.toBeDefined();
    unreachable.stop();
    await unreachable.start();
    await settleLoad();
    expect(loads).toBe(2);
    await expect(unreachable.getPermission({ topics: ['energy-full'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    });
    // An entry once loaded is kept across starts.
    unreachable.stop();
    await unreachable.start();
    await settleLoad();
    expect(loads).toBe(2);
  });

  it('neither waits for a load that never answers nor starts a second one', async () => {
    const { host, backend } = setup();
    let loads = 0;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: () => {
        loads += 1;
        return new Promise(() => undefined);
      },
    });
    // start(), calls, and runUntilIdle() answer while the load hangs.
    await runtime.start();
    await expect(runtime.getPermission({ topics: ['energy-full'] })).resolves.toBeDefined();
    await runtime.runUntilIdle();
    runtime.stop();
    await runtime.start();
    expect(loads).toBe(1);
  });

  it('loads no entry for a provider without remote delivery', async () => {
    const backend = createNotificationConformanceBackend({
      entry: undefined,
      catalog: [energy],
      clock: createNotificationConformanceClock(now),
      defaultLocale: 'ko',
      defaultPlayer: 'p-1',
    });
    const host = createNotificationConformanceHost({
      profile: {
        ...osProfile,
        capabilities: {
          ...osProfile.capabilities,
          remote: { supported: false, purposes: [], addressing: 'none', content: 'free-form' },
        },
      },
      catalog: [energy],
    });
    let loads = 0;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: async () => {
        loads += 1;
        return undefined;
      },
    });
    await runtime.start();
    await settleLoad();
    expect(loads).toBe(0);
  });

  it('treats a loaded entry that cannot be compared as a failed load, and loads again at the next start', async () => {
    const { host, backend } = setup();
    const entry = notificationConformanceRegistryEntry({ provider: osProfile.provider, capabilities: osProfile.capabilities });
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }
    const errors: unknown[] = [];
    const answers: unknown[] = [
      { ...entry, purposes: 'service' },
      { ...entry, get permission(): unknown {
        throw new Error('hostile read');
      } },
      // A newer backend's extra field still compares; this one disagrees with the provider.
      { ...entry, addressing: 'platform-user', addedLater: true },
    ];
    let loads = 0;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: async () => answers[loads++] as typeof entry,
      onError: (error) => errors.push(error),
    });
    for (const issue of [/purposes/u, /JSON/u]) {
      await runtime.start();
      await settleLoad();
      expect(errors.at(-1)).toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
      expect(String((errors.at(-1) as Error).message)).toMatch(issue);
      // The runtime runs without the comparison.
      await expect(runtime.getPermission({ topics: ['energy-full'] })).resolves.toBeDefined();
      await runtime.runUntilIdle().catch(() => undefined);
      runtime.stop();
    }
    await runtime.start();
    await settleLoad();
    expect(loads).toBe(3);
    await expect(runtime.getPermission({ topics: ['energy-full'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    });
  });

  it('fails closed on a given entry that cannot be compared, as on one that disagrees', async () => {
    const entry = notificationConformanceRegistryEntry({ provider: osProfile.provider, capabilities: osProfile.capabilities });
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }
    const hostile = (): never => {
      throw new Error('hostile read');
    };
    const given: unknown[] = [
      { ...entry, permission: null },
      { ...entry, get purposes(): unknown {
        return hostile();
      } },
      // A readable entry that disagrees: the behaviour the malformed ones must match.
      { ...entry, addressing: 'platform-user' },
    ];
    for (const registryEntry of given) {
      const { host, backend } = setup();
      backend.authenticate('p-1');
      host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
      const errors: unknown[] = [];
      let loads = 0;
      const runtime = createNotificationRuntime({
        provider: host.provider,
        backend,
        catalog: [energy],
        defaultLocale: 'ko',
        registryEntry: registryEntry as typeof entry,
        loadRegistryEntry: async () => {
          loads += 1;
          return entry;
        },
        onError: (error) => errors.push(error),
      });
      // start() does not throw for it, loads nothing in its place, and sends nothing.
      await runtime.start();
      await settleLoad();
      await runtime.runUntilIdle().catch(() => undefined);
      expect(loads).toBe(0);
      expect(backend.endpoints).toEqual([]);
      await expect(runtime.getPermission({ topics: ['energy-full'] })).rejects.toMatchObject({
        code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      });
      await expect(runtime.register()).rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
      expect(backend.endpoints).toEqual([]);
    }
  });

  it('reports a given entry that cannot be compared through onError at each start', async () => {
    const { host, backend } = setup();
    const entry = notificationConformanceRegistryEntry({ provider: osProfile.provider, capabilities: osProfile.capabilities });
    const errors: unknown[] = [];
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      registryEntry: { ...entry, permission: null } as unknown as NonNullable<typeof entry>,
      onError: (error) => errors.push(error),
    });
    await runtime.start();
    runtime.stop();
    await runtime.start();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    expect(String((errors[0] as Error).message)).toMatch(/permission/u);
  });

  it('loads again after a loader that throws synchronously', async () => {
    const { host, backend } = setup();
    const errors: unknown[] = [];
    let loads = 0;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: () => {
        loads += 1;
        throw new Error('bad Worker URL');
      },
      onError: (error) => errors.push(error),
    });
    await runtime.start();
    await settleLoad();
    runtime.stop();
    await runtime.start();
    await settleLoad();
    expect(loads).toBe(2);
    expect(errors).toHaveLength(2);
  });
});

describe('createNotificationRuntime review fixes', () => {
  const fcmEntry = () => {
    const entry = notificationConformanceRegistryEntry({ provider: osProfile.provider, capabilities: osProfile.capabilities });
    if (entry === undefined) {
      throw new Error('the profile has remote delivery');
    }
    return entry;
  };

  it('sends no registration and no record for a provider its registry entry disagrees with', async () => {
    for (const given of ['at creation', 'loaded'] as const) {
      const { host, backend } = setup();
      const mismatched = { ...fcmEntry(), addressing: 'platform-user' as const };
      backend.authenticate('p-1');
      host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
      const runtime = createNotificationRuntime({
        provider: host.provider,
        backend,
        catalog: [energy],
        defaultLocale: 'ko',
        ...(given === 'at creation'
          ? { registryEntry: mismatched }
          : { loadRegistryEntry: () => new Promise((resolve) => setTimeout(() => resolve(mismatched), 0)) }),
      });
      await runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // A rotated address and a new session reach nothing either.
      host.issueEndpoint({ kind: 'fcm-token', value: 'tok-2' });
      backend.authenticate('p-1');
      await runtime.runUntilIdle().catch(() => undefined);
      expect(backend.endpoints, given).toEqual([]);
      expect(backend.consent, given).toEqual([]);
      await expect(runtime.getPermission({ topics: ['energy-full'] })).rejects.toMatchObject({
        code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      });
    }
  });

  it('holds registrations and records while the entry loads, without holding the queues, and sends them when it matches', async () => {
    const { host, backend } = setup();
    let answer: ((entry: ReturnType<typeof fcmEntry>) => void) | undefined;
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: () => new Promise((resolve) => {
        answer = resolve;
      }),
    });
    await runtime.start();
    // While it loads: calls answer, nothing is sent, and runUntilIdle and unregister do not hang.
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    await runtime.runUntilIdle();
    expect(backend.endpoints).toEqual([]);
    expect(backend.consent).toEqual([]);
    // The matching entry arrives: the waiting record and the registration go out.
    answer?.(fcmEntry());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
    expect(backend.consent.map((record) => [record.kind, record.state])).toEqual([['topic-preference', 'granted']]);
  });

  it('handles register(), rotations, withdrawals, and stop() while the entry loads', async () => {
    // A load whose answer the test releases.
    const pendingLoad = () => {
      let answer: ((entry: ReturnType<typeof fcmEntry>) => void) | undefined;
      return {
        load: () => new Promise<ReturnType<typeof fcmEntry>>((resolve) => {
          answer = resolve;
        }),
        answer: () => answer?.(fcmEntry()),
      };
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    // register() during the load is sent unconditionally once it matches, even if identical and fresh.
    {
      const storage = asyncStorage();
      const { clock, host, backend } = setup(storage.port);
      backend.authenticate('p-1');
      host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
      const first = createNotificationRuntime({ provider: host.provider, backend, catalog: [energy], clock, defaultLocale: 'ko', storage: storage.port });
      await first.start();
      await first.runUntilIdle();
      const sent = backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt);
      expect(sent).toHaveLength(1);
      first.stop();
      clock.advance(60);
      const loading = pendingLoad();
      const runtime = createNotificationRuntime({
        provider: host.provider, backend, catalog: [energy], clock, defaultLocale: 'ko', storage: storage.port, loadRegistryEntry: loading.load,
      });
      await runtime.start();
      await runtime.register();
      expect(backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt)).toEqual(sent);
      loading.answer();
      await tick();
      await runtime.runUntilIdle();
      expect(backend.endpoints.map((endpoint) => endpoint.lastRegisteredAt)).not.toEqual(sent);
    }

    // A provider without register(): a rotation during the load is sent after it.
    {
      const { host, backend } = setup();
      backend.authenticate('p-1');
      const { register: _register, ...eventOnly } = host.provider;
      const loading = pendingLoad();
      const runtime = createNotificationRuntime({
        provider: eventOnly, backend, catalog: [energy], defaultLocale: 'ko', loadRegistryEntry: loading.load,
      });
      await runtime.start();
      host.issueEndpoint({ kind: 'fcm-token', value: 'tok-rotated' });
      await runtime.runUntilIdle();
      expect(backend.endpoints).toEqual([]);
      loading.answer();
      await tick();
      await runtime.runUntilIdle();
      expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-rotated']);
    }

    // A withdrawal goes out at once; a grant after it waits for the check.
    {
      const { host, backend } = setup();
      backend.authenticate('p-1');
      const loading = pendingLoad();
      const runtime = createNotificationRuntime({
        provider: host.provider, backend, catalog: [energy], defaultLocale: 'ko', loadRegistryEntry: loading.load,
      });
      await runtime.start();
      await runtime.setAdvertisingConsent({ advertising: 'withdrawn', textVersion: '1' });
      await runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: '1' });
      await runtime.runUntilIdle();
      expect(backend.consent.map((record) => record.state)).toEqual(['withdrawn']);
      loading.answer();
      await tick();
      await runtime.runUntilIdle();
      expect(backend.consent.map((record) => record.state)).toEqual(['withdrawn', 'granted']);
    }

    // A load that settles after stop() sends nothing.
    {
      const { host, backend } = setup();
      backend.authenticate('p-1');
      host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
      const loading = pendingLoad();
      const runtime = createNotificationRuntime({
        provider: host.provider, backend, catalog: [energy], defaultLocale: 'ko', loadRegistryEntry: loading.load,
      });
      await runtime.start();
      runtime.stop();
      loading.answer();
      await tick();
      await runtime.runUntilIdle();
      expect(backend.endpoints).toEqual([]);
    }
  });

  it('keeps the decided device permission of a registration held by the load', async () => {
    const { host, backend } = setup();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    // A provider whose registration always reports granted, whatever it reads.
    const provider = {
      ...host.provider,
      register: async () => {
        const registration = await host.provider.register?.();
        return registration === null || registration === undefined || registration.address.kind === 'platform-user'
          ? (registration ?? null)
          : { ...registration, address: { ...registration.address, permission: 'granted' as const } };
      },
    };
    let answer: ((entry: ReturnType<typeof fcmEntry>) => void) | undefined;
    const runtime = createNotificationRuntime({
      provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: () => new Promise((resolve) => {
        answer = resolve;
      }),
    });
    await runtime.start();
    host.setPermission('blocked');
    await runtime.getPermission({ topics: ['energy-full'] });
    answer?.(fcmEntry());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.permission)).toEqual(['blocked']);
  });

  it('reads nothing from the backend and still cancels a withdrawn topic locally on a mismatch', async () => {
    const { host, backend } = setup();
    let reads = 0;
    const mismatched = { ...fcmEntry(), addressing: 'platform-user' as const };
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend: clientOf(backend, {
        listConsent: async () => {
          reads += 1;
          return backend.listConsent();
        },
      }),
      catalog: [energy],
      defaultLocale: 'ko',
      registryEntry: mismatched,
    });
    await runtime.start();
    // A pending local reminder of the topic, scheduled straight on the device.
    host.setPermission('granted');
    expect(await host.provider.scheduleLocal?.({
      key: 'k',
      topic: 'energy-full',
      fireAt: '2026-10-12T05:00:00Z',
      title: 't',
      body: 'b',
    })).toMatchObject({ status: 'scheduled' });
    // A sign-in reconciles nothing against the backend.
    backend.authenticate('p-1');
    await runtime.runUntilIdle().catch(() => undefined);
    expect(reads).toBe(0);
    await expect(runtime.setTopicPreference({ topic: 'energy-full', enabled: false })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    });
    expect(host.localPending).toEqual([]);
    expect(reads).toBe(0);
  });

  it('keeps the order of records when a write fails while a grant is held back', async () => {
    const { host, backend } = setup();
    backend.authenticate('p-1');
    let failNext = true;
    let answer: ((entry: ReturnType<typeof fcmEntry>) => void) | undefined;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend: clientOf(backend, {
        recordConsent: async (record) => {
          if (failNext) {
            failNext = false;
            throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: 'offline' });
          }
          await backend.recordConsent(record);
        },
      }),
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: () => new Promise((resolve) => {
        answer = resolve;
      }),
    });
    await runtime.start();
    // One decision, written in order: the withdrawal goes first and fails once, the grant waits for the entry.
    await expect(
      runtime.setAdvertisingConsent({ advertising: 'withdrawn', night: 'granted', textVersion: '1' }),
    ).rejects.toBeDefined();
    answer?.(fcmEntry());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.runUntilIdle();
    expect(backend.consent.map((record) => [record.kind, record.state])).toEqual([
      ['advertising', 'withdrawn'],
      ['night', 'granted'],
    ]);
  });

  it('keeps the order of records when the session changes mid-write while a grant is held back', async () => {
    const { host, backend } = setup();
    backend.authenticate('p-1');
    let mode: 'fail' | 'switch' | 'write' = 'fail';
    let answer: ((entry: ReturnType<typeof fcmEntry>) => void) | undefined;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend: clientOf(backend, {
        recordConsent: async (record) => {
          if (mode === 'fail') {
            throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: 'offline' });
          }
          await backend.recordConsent(record);
          if (mode === 'switch') {
            // Another player signs in while the first record is written.
            mode = 'write';
            backend.authenticate('p-2');
          }
        },
      }),
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: () => new Promise((resolve) => {
        answer = resolve;
      }),
    });
    await runtime.start();
    // Two withdrawals wait after a failed write; a grant then waits behind them for the entry.
    await expect(
      runtime.setAdvertisingConsent({ advertising: 'withdrawn', night: 'withdrawn', textVersion: '1' }),
    ).rejects.toBeDefined();
    mode = 'switch';
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    // p-1 signs in again: the withdrawal left over goes first, then the grant once the entry matches.
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    answer?.(fcmEntry());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.runUntilIdle();
    expect(backend.consent.map((record) => [record.kind, record.state])).toEqual([
      ['advertising', 'withdrawn'],
      ['night', 'withdrawn'],
      ['topic-preference', 'granted'],
    ]);
  });

  it("keeps a withdrawal's own error when the local cancel on its error path fails too", async () => {
    const { host, backend } = setup();
    const errors: unknown[] = [];
    const cancelFailure = new Error('cancel failed');
    const provider = {
      ...host.provider,
      cancelLocal: async () => {
        throw cancelFailure;
      },
    };
    const runtime = createNotificationRuntime({
      provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      registryEntry: { ...fcmEntry(), addressing: 'platform-user' },
      onError: (error) => errors.push(error),
    });
    await runtime.start();
    host.setPermission('granted');
    await host.provider.scheduleLocal?.({ key: 'k', topic: 'energy-full', fireAt: '2026-10-12T05:00:00Z', title: 't', body: 'b' });
    backend.authenticate('p-1');
    await expect(runtime.setTopicPreference({ topic: 'energy-full', enabled: false })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    });
    expect(errors).toContain(cancelFailure);
  });

  it('sends what waited when the entry cannot be loaded', async () => {
    const { host, backend } = setup();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    const errors: unknown[] = [];
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      loadRegistryEntry: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('unreachable')), 0)),
      onError: (error) => errors.push(error),
    });
    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.runUntilIdle().catch(() => undefined);
    expect(errors).toHaveLength(1);
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
  });

  it('retries a first registration that failed, on a read once its backoff has passed', async () => {
    const { clock, host, backend } = setup();
    let failures = 1;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend: clientOf(backend, {
        registerEndpoint: async (registration) => {
          if (failures > 0) {
            failures -= 1;
            throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: '429' });
          }
          await backend.registerEndpoint(registration);
        },
      }),
      catalog: [energy],
      clock,
      defaultLocale: 'ko',
    });
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.start();
    await runtime.runUntilIdle().catch(() => undefined);
    expect(backend.endpoints).toEqual([]);
    clock.advance(30);
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
  });

  it('backs reads off a first registration that failed on endpoint-changed', async () => {
    const { clock, host, backend } = setup();
    const attempts: string[] = [];
    let failing = true;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend: clientOf(backend, {
        registerEndpoint: async (registration) => {
          attempts.push(clock.now());
          if (failing) {
            throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: '503' });
          }
          await backend.registerEndpoint(registration);
        },
      }),
      catalog: [energy],
      clock,
      defaultLocale: 'ko',
      onError: () => undefined,
    });
    backend.authenticate('p-1');
    await runtime.start();
    await runtime.runUntilIdle().catch(() => undefined);
    // The address arrives late, as an FCM token often does, and its registration fails.
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle().catch(() => undefined);
    expect(attempts).toHaveLength(1);
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle().catch(() => undefined);
    expect(attempts).toHaveLength(1);
    failing = false;
    clock.advance(30);
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(attempts).toHaveLength(2);
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
  });

  it('counts a failure for the session the attempt began for, not the one signed in when it failed', async () => {
    const { clock, host, backend } = setup();
    const attempts: string[] = [];
    let release: (() => void) | undefined;
    let failing = true;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend: clientOf(backend, {
        registerEndpoint: async (registration) => {
          attempts.push(clock.now());
          if (release === undefined && attempts.length === 1) {
            // The first attempt (p-1's) answers only after p-2 signed in.
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          if (failing) {
            throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: '503' });
          }
          await backend.registerEndpoint(registration);
        },
      }),
      catalog: [energy],
      clock,
      defaultLocale: 'ko',
      onError: () => undefined,
    });
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    const started = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    backend.authenticate('p-2');
    release?.();
    await started;
    await runtime.runUntilIdle().catch(() => undefined);
    // p-1's failure, then p-2's sign-in registration failed once: p-2 waits 30 s, not 60.
    expect(attempts).toHaveLength(2);
    failing = false;
    clock.advance(30);
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(attempts).toHaveLength(3);
  });

  it("does not back reads off for a failure that is not the backend's: a failed save retries on the next read", async () => {
    const storage = asyncStorage();
    const { clock, host, backend } = setup(storage.port);
    let sent = 0;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend: clientOf(backend, {
        registerEndpoint: async (registration) => {
          sent += 1;
          await backend.registerEndpoint(registration);
        },
      }),
      catalog: [energy],
      clock,
      defaultLocale: 'ko',
      storage: storage.port,
      onError: () => undefined,
    });
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    // The backend takes the first registration, but its acknowledgement cannot be saved, twice.
    storage.failNextSaves(2);
    await runtime.start();
    await runtime.runUntilIdle().catch(() => undefined);
    expect(sent).toBe(1);
    // Without moving the clock, each read sends it again at once.
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle().catch(() => undefined);
    expect(sent).toBe(2);
    await runtime.getPermission({ topics: ['energy-full'] });
    await runtime.runUntilIdle();
    expect(sent).toBe(3);
    expect(storage.stored).toMatchObject({ registration: { player: 'p-1' } });
  });

  it('backs reads off a registration that keeps failing: 30 s, doubling, at most an hour', async () => {
    const { clock, host, backend } = setup();
    const attempts: string[] = [];
    let failing = true;
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend: clientOf(backend, {
        registerEndpoint: async (registration) => {
          attempts.push(clock.now());
          if (failing) {
            throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: '503' });
          }
          await backend.registerEndpoint(registration);
        },
      }),
      catalog: [energy],
      clock,
      defaultLocale: 'ko',
      onError: () => undefined,
    });
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    const read = async (): Promise<void> => {
      await runtime.getPermission({ topics: ['energy-full'] });
      await runtime.runUntilIdle().catch(() => undefined);
    };
    // Start sends at once and fails: reads hold back for 30 s.
    await runtime.start();
    await runtime.runUntilIdle().catch(() => undefined);
    expect(attempts).toHaveLength(1);
    await read();
    await read();
    clock.advance(29);
    await read();
    expect(attempts).toHaveLength(1);
    // Each failure in a row doubles the wait: 30, 60, 120, ... seconds.
    const waits: number[] = [];
    let waited = 29;
    while (waits.length < 9) {
      clock.advance(1);
      waited += 1;
      const before = attempts.length;
      await read();
      if (attempts.length > before) {
        waits.push(waited);
        waited = 0;
      }
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600]);
    // Explicit triggers do not wait: a rotated address goes out at once.
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-2' });
    await runtime.runUntilIdle().catch(() => undefined);
    expect(attempts).toHaveLength(11);
    // One the backend acknowledges ends the backoff: the next failure waits 30 s again.
    failing = false;
    clock.advance(3600);
    await read();
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toContain('tok-2');
    expect(attempts).toHaveLength(12);
    // Another player signs in: that registration fails, and reads retry it after 30 s, not an hour.
    failing = true;
    backend.authenticate('p-2');
    await runtime.runUntilIdle().catch(() => undefined);
    expect(attempts).toHaveLength(13);
    clock.advance(29);
    await read();
    expect(attempts).toHaveLength(13);
    clock.advance(1);
    await read();
    expect(attempts).toHaveLength(14);
  });

  it('records no player action for a player who signed out while the call was under way', async () => {
    const { host, backend } = setup();
    let release: (() => void) | undefined;
    let hold = false;
    const provider = {
      ...host.provider,
      getCapabilities: async () => {
        if (hold) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return host.provider.getCapabilities();
      },
    };
    const runtime = createNotificationRuntime({ provider, backend, catalog: [energy], defaultLocale: 'ko' });
    await runtime.start();
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    for (const call of [
      () => runtime.setTopicPreference({ topic: 'energy-full', enabled: true }),
      () => runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: '1' }),
    ]) {
      hold = true;
      const pending = call();
      await new Promise((resolve) => setTimeout(resolve, 0));
      hold = false;
      // Another player signs in while the call waits for the provider.
      backend.authenticate('p-2');
      release?.();
      await expect(pending).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
      // p-1 signing in again does not receive the abandoned record.
      backend.authenticate('p-1');
      await runtime.runUntilIdle();
      expect(backend.consent).toEqual([]);
    }
  });
});

describe('createNotificationRuntime withdrawal on an account switch', () => {
  it("still cancels the topic's local reminders when the withdrawal throws on a switch", async () => {
    const { host, backend } = setup();
    let release: (() => void) | undefined;
    let hold = false;
    const provider = {
      ...host.provider,
      getCapabilities: async () => {
        if (hold) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return host.provider.getCapabilities();
      },
    };
    const runtime = createNotificationRuntime({ provider, backend, catalog: [energy], defaultLocale: 'ko' });
    await runtime.start();
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    expect(await runtime.reminders.set({ key: 'k', topic: 'energy-full', fireAt: '2026-10-12T05:00:00Z' }))
      .toMatchObject({ route: 'local' });
    expect(host.localPending).toHaveLength(1);
    hold = true;
    const withdrawing = runtime.setTopicPreference({ topic: 'energy-full', enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    hold = false;
    backend.authenticate('p-2');
    release?.();
    await expect(withdrawing).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    expect(host.localPending).toEqual([]);
  });
});

describe('createNotificationRuntime defaults', () => {
  it('dates the stored registration by the system clock', async () => {
    const storage = asyncStorage();
    const host = createNotificationConformanceHost({ profile: osProfile, catalog: [energy], timeZone: 'Asia/Seoul' });
    const backend = createNotificationConformanceBackend({
      entry: notificationConformanceRegistryEntry({ provider: osProfile.provider, capabilities: osProfile.capabilities }),
      catalog: [energy],
      clock: createNotificationConformanceClock(now),
      defaultLocale: 'ko',
      defaultPlayer: 'p-1',
    });
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    const runtime = createNotificationRuntime({
      provider: host.provider,
      backend,
      catalog: [energy],
      defaultLocale: 'ko',
      storage: storage.port,
    });
    await runtime.start();
    const before = Date.now();
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    const at = (storage.stored as NotificationRuntimeState).registration?.at;
    expect(at).toBeDefined();
    expect(Date.parse(at ?? '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(at ?? '')).toBeLessThanOrEqual(Date.now());
  });

  it('reports each background failure to onError and still rethrows it from runUntilIdle', async () => {
    const errors: unknown[] = [];
    const broken = new Error('backend down');
    const { host, backend, create } = setup(undefined, {
      onError(error) {
        errors.push(error);
        throw new Error('the observer itself fails');
      },
    });
    const runtime = create(clientOf(backend, {
      recordConsent: async () => {
        throw broken;
      },
    }));
    await runtime.start();
    backend.authenticate('p-1');
    // The call's own failure is the caller's, not a background one.
    await expect(runtime.setTopicPreference({ topic: 'energy-full', enabled: true })).rejects.toBe(broken);
    expect(errors).toEqual([]);
    runtime.subscribe(() => {
      throw broken;
    });
    // A listener that throws is a background failure.
    host.tap({ channel: 'remote', topic: 'energy-full' });
    expect(errors).toEqual([broken]);
    await expect(runtime.runUntilIdle()).rejects.toBe(broken);
    expect(notificationDefaultDeploymentTimeZone).toBe('Asia/Seoul');
  });

  it('ignores a promise onError returns, even a rejected one', async () => {
    const seen: unknown[] = [];
    const { host, create } = setup(undefined, {
      onError: async (error) => {
        seen.push(error);
        throw new Error('the async observer fails');
      },
    });
    const runtime = create();
    await runtime.start();
    const broken = new Error('listener');
    runtime.subscribe(() => {
      throw broken;
    });
    host.tap({ channel: 'remote', topic: 'energy-full' });
    await Promise.resolve();
    expect(seen).toEqual([broken]);
    await expect(runtime.runUntilIdle()).rejects.toBe(broken);
  });
});
