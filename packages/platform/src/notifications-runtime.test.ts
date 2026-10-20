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
    expect(storage.stored).toEqual({ unbound: true });
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
    const { host, backend, create } = setup(storage.port);
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
    const restarted = create();
    const error = await restarted.unregister().then(() => undefined, (failure: unknown) => failure);
    expect(backend.endpoints).toEqual([]);
    expect((error as NotificationError).code).toBe('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
    expect((error as NotificationError).message).toContain('could not read');
    expect(storage.stored).toEqual({ unbound: true });
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
    expect(notificationRuntimeStateOf({ registration: { ...registration, at: 'yesterday' } })).toEqual({});
    expect(notificationRuntimeStateOf({
      registration: { ...registration, registration: { provider: 'fcm', address: [] } },
    })).toEqual({});
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
