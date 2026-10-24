import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isBridgeNotificationsBackendMethod,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { NotificationConsentRateLimitError } from '@mpgd/game-services/notifications';
import { NotificationError } from '@mpgd/platform/notifications';
import { createNotificationRuntime } from '@mpgd/platform/notifications-runtime';

import { createFakeNotificationRedis } from '../test/fake-notification-redis.js';
import {
  createFakeDevvitNotifications,
  type FakeDevvitNotifications,
} from '../test/fake-devvit-notifications.js';
import { createDevvitNotificationsBackend } from './index.js';
import * as backendClientModule from './notifications-backend-client.js';
import { createDevvitNotificationsBackendClient } from './notifications-backend-client.js';
import { createDevvitBridgeNotificationProvider } from './notifications-client.js';
import { createDevvitNotificationsBackendBridgeHandler } from './server/notifications-backend-bridge.js';
import { createDevvitNotificationsV2BridgeHandler } from './server/notifications-bridge.js';
import {
  createDevvitNotificationProviderEntry,
  createDevvitNotificationService,
  runDevvitNotificationTask,
} from './server/notifications-delivery.js';

/**
 * The production notifications runtime on Devvit, in process: the webview's
 * provider and backend client over the Devvit server bridge, whose two
 * handlers serve the game-rendered opt-in and the notifications service
 * over the fake Redis store and a fake notifications plugin. The request
 * context's user is the fake plugin's `currentUserId`.
 */

const alice = 't2_alice';
const bob = 't2_bob';

const catalogFile = {
  version: '2026-10-24',
  defaultLocale: 'en',
  topics: [
    {
      id: 'friend-challenge',
      purpose: 'service',
      channels: ['remote'],
      route: '/?entry=friend-challenge',
      targets: {
        reddit: {
          title: 'New challenge',
          body: '{{friend}} sent you a challenge.',
          link: 't3_daily',
        },
      },
    },
    {
      id: 'daily-puzzle',
      purpose: 'requested',
      channels: ['remote'],
      route: '/?entry=daily',
      targets: { reddit: { title: 'Daily puzzle', body: 'A new puzzle is open.' } },
    },
  ],
};

interface Sent {
  readonly method: string;
  readonly payload: unknown;
  readonly user: string | undefined;
}

function setup(input: { readonly loggedOut?: boolean } = {}) {
  /** Bridge methods whose next request fails in transit, once each. */
  const failNext = new Set<string>();
  let now = Date.parse('2026-10-24T03:00:00Z');
  const plugin: FakeDevvitNotifications = createFakeDevvitNotifications(
    input.loggedOut === true ? {} : { currentUserId: alice },
  );
  const devvit = createDevvitNotificationService({
    redis: createFakeNotificationRedis(),
    notifications: plugin,
    catalog: catalogFile,
    now: () => new Date(now).toISOString(),
    random: () => 0,
  });
  const topics = devvit.catalog.topicsFor('reddit');
  const providerHandler = createDevvitNotificationsV2BridgeHandler({
    notifications: plugin,
    currentUserId: () => plugin.currentUserId,
    topics: topics.map((topic) => topic.id),
  });
  const backendFailures: unknown[] = [];
  const backendHandler = createDevvitNotificationsBackendBridgeHandler({
    service: devvit.service,
    context: () => ({ userId: plugin.currentUserId }),
    onError: (error) => backendFailures.push(error),
  });
  const sent: Sent[] = [];
  const serve = async (method: string, payload: unknown): Promise<unknown> => {
    sent.push({ method, payload, user: plugin.currentUserId });
    if (failNext.delete(method)) {
      throw Object.assign(new Error('Failed to fetch'), {
        code: 'DEVVIT_BRIDGE_NETWORK_ERROR',
        retryable: true,
      });
    }
    const request: BridgeRequest = {
      id: `r-${sent.length}`,
      method: method as BridgeRequest['method'],
      payload,
      meta: { target: 'reddit', appVersion: '1', buildId: 'test', sentAt: '2026-10-24T03:00:00Z' },
    };
    const response: BridgeResponse = isBridgeNotificationsBackendMethod(method)
      ? await backendHandler.request(request)
      : await providerHandler.request(request);
    if (!response.ok) {
      throw Object.assign(new Error(response.error.message), response.error);
    }
    return response.data;
  };
  const provider = createDevvitBridgeNotificationProvider({
    request: serve,
    timeZone: () => 'America/New_York',
    locale: () => 'en-US',
  });
  const client = createDevvitNotificationsBackendClient({ request: serve, now: () => now });
  const errors: unknown[] = [];
  const runtime = createNotificationRuntime({
    provider,
    backend: client,
    catalog: topics,
    defaultLocale: 'en',
    clock: { now: () => new Date(now).toISOString() },
    registryEntry: createDevvitNotificationProviderEntry(),
    onError: (error) => errors.push(error),
  });
  return {
    plugin,
    devvit,
    client,
    runtime,
    sent,
    failNext,
    errors,
    backendFailures,
    advance(ms: number) {
      now += ms;
    },
    at: (offsetMs: number) => new Date(now + offsetMs).toISOString(),
    recordsOf: (player: string) =>
      devvit.service.listConsent({
        player,
        sessionId: `devvit:${player}`,
        installationId: `devvit:${player}`,
      }),
  };
}

/** Lets every pending promise job of the in-process bridge run; no timers. */
async function flushJobs(): Promise<void> {
  for (let step = 0; step < 50; step += 1) {
    await Promise.resolve();
  }
}

const sentBackend = (sent: readonly Sent[], method: string) =>
  sent.filter((entry) => entry.method === `notifications.backend.${method}`);

describe('the notifications runtime on Devvit through the backend client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opts in, registers the platform user, and records the decision for the request user', async () => {
    const harness = setup();
    await harness.client.refreshSession();
    expect(harness.client.session()).toEqual({ id: `devvit:${alice}`, player: alice });
    await harness.runtime.start();
    await harness.runtime.runUntilIdle();
    // At start, for a player already signed in: the platform-user registration with the webview's zone.
    const registrations = sentBackend(harness.sent, 'registerEndpoint');
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.payload).toEqual({
      expectedPlayer: alice,
      registration: {
        provider: 'devvit',
        address: { kind: 'platform-user' },
        locale: 'en-US',
        timeZone: 'America/New_York',
      },
    });

    await expect(harness.runtime.getPermission({ topics: ['daily-puzzle'] })).resolves.toMatchObject({
      app: 'prompt',
    });
    const result = await harness.runtime.requestPermission({ topics: ['daily-puzzle'], gesture: true });
    expect(result.outcomes).toEqual({ 'daily-puzzle': 'granted' });
    await harness.runtime.runUntilIdle();
    expect(harness.plugin.optedIn.has(alice)).toBe(true);
    const records = await harness.recordsOf(alice);
    expect(records).toEqual([
      expect.objectContaining({ kind: 'delivery-permission', state: 'granted', source: 'client-report' }),
    ]);
    // Every backend call named the request user, and every request ran as that user.
    expect(harness.sent.every((entry) => entry.user === alice)).toBe(true);
    expect(harness.errors).toEqual([]);
  });

  it('records a reminder preference, stores the server reminder, and fires it through enqueue', async () => {
    const harness = setup();
    await harness.client.refreshSession();
    await harness.runtime.start();
    await harness.runtime.requestPermission({ topics: ['daily-puzzle'], gesture: true });
    await harness.runtime.setTopicPreference({ topic: 'daily-puzzle', enabled: true });
    await harness.runtime.runUntilIdle();
    expect(await harness.recordsOf(alice)).toContainEqual(
      expect.objectContaining({ kind: 'topic-preference', topic: 'daily-puzzle', state: 'granted', source: 'player' }),
    );

    await expect(harness.runtime.reminders.set({
      key: 'daily',
      topic: 'daily-puzzle',
      fireAt: harness.at(60 * 60 * 1000),
      link: 't3_post',
    })).resolves.toEqual({ route: 'remote', status: 'scheduled' });
    await expect(runDevvitNotificationTask(harness.devvit.service, 'dispatch'))
      .resolves.toEqual({ task: 'dispatch', touched: 0, failed: 0 });
    harness.advance(60 * 60 * 1000);
    await expect(runDevvitNotificationTask(harness.devvit.service, 'dispatch'))
      .resolves.toEqual({ task: 'dispatch', touched: 1, failed: 0 });
    expect(harness.plugin.enqueueCalls).toEqual([
      { title: 'Daily puzzle', body: 'A new puzzle is open.', userId: alice, link: 't3_post', data: {} },
    ]);

    // A cancelled reminder never fires.
    await harness.runtime.reminders.set({
      key: 'daily',
      topic: 'daily-puzzle',
      fireAt: harness.at(60 * 60 * 1000),
      link: 't3_post',
    });
    await expect(harness.runtime.reminders.cancel({ key: 'daily' }))
      .resolves.toEqual({ route: 'remote', status: 'cancelled' });
    harness.advance(2 * 60 * 60 * 1000);
    await runDevvitNotificationTask(harness.devvit.service, 'dispatch');
    expect(harness.plugin.enqueueCalls).toHaveLength(1);
    // A reminder the player did not ask for is refused by the server's gate.
    await harness.runtime.setTopicPreference({ topic: 'daily-puzzle', enabled: false });
    await expect(harness.runtime.reminders.set({
      key: 'daily',
      topic: 'daily-puzzle',
      fireAt: harness.at(60 * 60 * 1000),
      link: 't3_post',
    })).resolves.toEqual({ route: 'remote', status: 'preference-off' });
    expect(harness.errors).toEqual([]);
  });

  it("reads the session again from the runtime's own reads after the first read failed", async () => {
    const harness = setup();
    harness.failNext.add('notifications.backend.getSession');
    await expect(harness.client.refreshSession()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await harness.runtime.start();
    await harness.runtime.runUntilIdle();
    expect(sentBackend(harness.sent, 'registerEndpoint')).toEqual([]);
    // Within the retry interval a read asks nothing more.
    await harness.runtime.getPermission({ topics: ['daily-puzzle'] });
    await flushJobs();
    expect(sentBackend(harness.sent, 'getSession')).toHaveLength(1);
    // After it, the runtime's next read starts a session read; the user is announced and registered.
    harness.advance(5_000);
    await harness.runtime.getPermission({ topics: ['daily-puzzle'] });
    await flushJobs();
    await harness.runtime.runUntilIdle();
    expect(sentBackend(harness.sent, 'getSession')).toHaveLength(2);
    expect(harness.client.session()).toEqual({ id: `devvit:${alice}`, player: alice });
    expect(sentBackend(harness.sent, 'registerEndpoint')).toHaveLength(1);
  });

  it('answers a logged-out viewer without reaching the service', async () => {
    const harness = setup({ loggedOut: true });
    await expect(harness.client.refreshSession()).resolves.toBeUndefined();
    expect(harness.client.session()).toBeUndefined();
    await harness.runtime.start();
    await expect(harness.runtime.getPermission({ topics: ['daily-puzzle'] })).resolves.toMatchObject({
      app: 'action-required',
      requiredAction: 'login',
    });
    await expect(harness.runtime.reminders.set({
      key: 'daily',
      topic: 'daily-puzzle',
      fireAt: harness.at(60 * 60 * 1000),
      link: 't3_post',
    })).resolves.toEqual({ route: 'remote', status: 'action-required' });
    // A backend call without a session is refused on the webview, before any request.
    const before = harness.sent.length;
    await expect(harness.client.listConsent()).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
    expect(harness.sent).toHaveLength(before);
    expect(sentBackend(harness.sent, 'registerEndpoint')).toEqual([]);

    // The server refuses a call for a user who has logged out since the session was read.
    harness.plugin.currentUserId = alice;
    await harness.client.refreshSession();
    harness.plugin.currentUserId = undefined;
    await expect(harness.client.listConsent()).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      hostCode: 'NOTIFICATIONS_SIGNED_OUT',
    });
    // ... and the client read the session again.
    expect(harness.client.session()).toBeUndefined();
    expect(harness.backendFailures).toEqual([]);
  });

  it('never reads or changes the previous user after an account switch', async () => {
    const harness = setup();
    await harness.client.refreshSession();
    await harness.runtime.start();
    await harness.runtime.requestPermission({ topics: ['daily-puzzle'], gesture: true });
    await harness.runtime.setTopicPreference({ topic: 'daily-puzzle', enabled: true });
    await harness.runtime.runUntilIdle();
    const aliceRecords = await harness.recordsOf(alice);
    const authenticated: string[] = [];
    harness.client.onAuthenticated((session) => authenticated.push(session.player));

    // Another Reddit user is the request user now (Devvit reloads the post after login).
    harness.plugin.currentUserId = bob;
    await expect(harness.runtime.setTopicPreference({ topic: 'daily-puzzle', enabled: false }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', hostCode: 'NOTIFICATIONS_SESSION_CHANGED' });
    await harness.runtime.runUntilIdle();
    // The refusal made the client read the session: bob is announced, and the runtime registered him.
    expect(authenticated).toEqual([bob]);
    expect(harness.client.session()).toEqual({ id: `devvit:${bob}`, player: bob });
    expect(sentBackend(harness.sent, 'registerEndpoint').at(-1)?.payload).toMatchObject({ expectedPlayer: bob });
    // Alice's records are as she left them.
    expect(await harness.recordsOf(alice)).toEqual(aliceRecords);

    // The refused withdrawal was alice's: it is not replayed for bob.
    await harness.runtime.runUntilIdle();
    expect(await harness.recordsOf(bob)).toEqual([]);
    await harness.runtime.setTopicPreference({ topic: 'daily-puzzle', enabled: true });
    expect(await harness.recordsOf(bob)).toEqual([
      expect.objectContaining({ kind: 'topic-preference', topic: 'daily-puzzle', state: 'granted', source: 'player' }),
    ]);
    expect(await harness.recordsOf(alice)).toEqual(aliceRecords);
    // Unbinding for the user who left sends nothing.
    const before = harness.sent.length;
    await harness.client.unregisterEndpoint({ provider: 'devvit', player: alice });
    expect(harness.sent).toHaveLength(before);
  });
});

describe('createDevvitNotificationsBackendClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const session = { session: { id: `devvit:${alice}`, player: alice } };

  it('stops waiting after timeoutMs with a retryable failure', async () => {
    vi.useFakeTimers();
    const client = createDevvitNotificationsBackendClient({
      request: async (method) => (method === 'notifications.backend.getSession' ? session : new Promise(() => {})),
      timeoutMs: 1000,
    });
    await client.refreshSession();
    const pending = client.listNotices();
    const settled = expect(pending).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true });
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(() => createDevvitNotificationsBackendClient({ request: async () => ({}), timeoutMs: 0 })).toThrow(NotificationError);
  });

  it('maps a server without the backend, a broken answer, and a transport failure', async () => {
    const answers: (() => unknown)[] = [];
    const client = createDevvitNotificationsBackendClient({
      request: async (method) => {
        if (method === 'notifications.backend.getSession') {
          return session;
        }
        const next = answers.shift();
        return next?.();
      },
    });
    await client.refreshSession();
    answers.push(() => {
      throw Object.assign(new Error('Unsupported Devvit bridge method'), { code: 'UNSUPPORTED_METHOD', retryable: false });
    });
    await expect(client.listConsent()).rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false });
    answers.push(() => {
      throw Object.assign(new Error('none'), { code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false });
    });
    await expect(client.listNotices()).rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    answers.push(() => ({ status: 'sent' }));
    await expect(client.setReminder({ key: 'k', topic: 'daily-puzzle', fireAt: '2026-10-25T03:00:00Z' }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    answers.push(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.cancelReminder({ key: 'k' })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
    // A payload outside the bridge contract is refused before it is sent.
    await expect(client.setReminder({ key: 'k', topic: 'daily-puzzle', fireAt: 'tomorrow' }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    expect(answers).toEqual([]);
  });

  it('shares one session read, keeps the session on a failed read, and announces only a new session', async () => {
    let reads = 0;
    let answer: unknown = session;
    const client = createDevvitNotificationsBackendClient({
      request: async () => {
        reads += 1;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
    });
    const announced: string[] = [];
    client.onAuthenticated((next) => announced.push(next.player));
    const [first, second] = await Promise.all([client.refreshSession(), client.refreshSession()]);
    expect(first).toEqual({ id: `devvit:${alice}`, player: alice });
    expect(second).toBe(first);
    expect(reads).toBe(1);
    await client.refreshSession();
    expect(announced).toEqual([alice]);
    answer = new Error('offline');
    await expect(client.refreshSession()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    expect(client.session()).toEqual({ id: `devvit:${alice}`, player: alice });
    answer = { session: { id: 'devvit:not-a-session', player: '' } };
    await expect(client.refreshSession()).rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    answer = { session: null };
    await expect(client.refreshSession()).resolves.toBeUndefined();
    expect(announced).toEqual([alice]);
  });

  it('reads the session again when a refused call joined a read answered before the switch', async () => {
    let user = alice;
    const reads: ((value: unknown) => void)[] = [];
    let refuse = false;
    const client = createDevvitNotificationsBackendClient({
      request: (method) => {
        if (method === 'notifications.backend.getSession') {
          const answered = { session: { id: `devvit:${user}`, player: user } };
          return new Promise((resolve) => {
            reads.push(() => resolve(answered));
          });
        }
        if (refuse) {
          return Promise.reject(Object.assign(new Error('another player (host code NOTIFICATIONS_SESSION_CHANGED)'), {
            code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
            message: 'another player (host code NOTIFICATIONS_SESSION_CHANGED)',
            retryable: true,
          }));
        }
        return Promise.resolve({ records: [] });
      },
    });
    const first = client.refreshSession();
    reads.shift()?.(undefined);
    await first;
    const announced: string[] = [];
    client.onAuthenticated((session) => announced.push(session.player));
    // A read starts and the server answers it for alice; then bob is the request user.
    const stale = client.refreshSession();
    const answerStale = reads.shift();
    user = bob;
    refuse = true;
    const refused = client.listConsent();
    // The refusal arrives and its re-read joins the read still in flight.
    await flushJobs();
    expect(reads).toHaveLength(0);
    answerStale?.(undefined);
    await stale;
    // The joined read named alice again, so the client asks once more.
    await flushJobs();
    expect(reads).toHaveLength(1);
    reads.shift()?.(undefined);
    await expect(refused).rejects.toMatchObject({ hostCode: 'NOTIFICATIONS_SESSION_CHANGED' });
    expect(client.session()?.player).toBe(bob);
    expect(announced).toEqual([bob]);
  });

  it('reads once more when a joined read answered logged out before another user signed in', async () => {
    const reads: ((value: unknown) => void)[] = [];
    let answer: unknown = session;
    const client = createDevvitNotificationsBackendClient({
      request: (method) => {
        if (method === 'notifications.backend.getSession') {
          const answered = answer;
          return new Promise((resolve) => {
            reads.push(() => resolve(answered));
          });
        }
        return Promise.reject(Object.assign(new Error('x'), {
          code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
          message: 'another player (host code NOTIFICATIONS_SESSION_CHANGED)',
          retryable: true,
        }));
      },
    });
    const first = client.refreshSession();
    reads.shift()?.(undefined);
    await first;
    const announced: string[] = [];
    client.onAuthenticated((next) => announced.push(next.player));
    // A read the server answered while nobody was logged in is still settling when bob logs in.
    answer = { session: null };
    const stale = client.refreshSession();
    const answerStale = reads.shift();
    answer = { session: { id: `devvit:${bob}`, player: bob } };
    const refused = client.listNotices();
    await flushJobs();
    answerStale?.(undefined);
    await stale;
    await flushJobs();
    expect(reads).toHaveLength(1);
    reads.shift()?.(undefined);
    await expect(refused).rejects.toMatchObject({ hostCode: 'NOTIFICATIONS_SESSION_CHANGED' });
    expect(client.session()?.player).toBe(bob);
    expect(announced).toEqual([bob]);
  });

  it('reads again on the next call when the re-read after a stale logged-out answer fails', async () => {
    const reads: ((value: unknown) => void)[] = [];
    const failures: ((error: unknown) => void)[] = [];
    let answer: unknown = session;
    let calls = 0;
    const client = createDevvitNotificationsBackendClient({
      request: (method) => {
        if (method === 'notifications.backend.getSession') {
          const answered = answer;
          return new Promise((resolve, reject) => {
            reads.push(() => resolve(answered));
            failures.push(reject);
          });
        }
        calls += 1;
        return Promise.reject(Object.assign(new Error('x'), {
          code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
          message: 'another player (host code NOTIFICATIONS_SESSION_CHANGED)',
          retryable: true,
        }));
      },
      retryIntervalMs: 0,
    });
    const first = client.refreshSession();
    reads.shift()?.(undefined);
    failures.shift();
    await first;
    answer = { session: null };
    const stale = client.refreshSession();
    const answerStale = reads.shift();
    failures.shift();
    const refused = client.listNotices();
    await flushJobs();
    answerStale?.(undefined);
    await stale;
    await flushJobs();
    // The second read fails (offline): the session stays cleared.
    reads.shift();
    failures.shift()?.(Object.assign(new Error('offline'), { code: 'DEVVIT_BRIDGE_NETWORK_ERROR', retryable: true }));
    await expect(refused).rejects.toMatchObject({ hostCode: 'NOTIFICATIONS_SESSION_CHANGED' });
    // The next read of the session, or the next call, finds none and reads again; bob is announced.
    const announced: string[] = [];
    client.onAuthenticated((next) => announced.push(next.player));
    answer = { session: { id: `devvit:${bob}`, player: bob } };
    expect(client.session()).toBeUndefined();
    await expect(client.listConsent()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await flushJobs();
    expect(reads).toHaveLength(1);
    reads.shift()?.(undefined);
    await flushJobs();
    expect(announced).toEqual([bob]);
    expect(calls).toBe(1);
  });

  it('clears a timed-out session read, so the next one asks again', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const client = createDevvitNotificationsBackendClient({
      request: () => {
        reads += 1;
        return reads === 1 ? new Promise(() => {}) : Promise.resolve(session);
      },
      timeoutMs: 1000,
    });
    const first = expect(client.refreshSession()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    await expect(client.refreshSession()).resolves.toEqual({ id: `devvit:${alice}`, player: alice });
    expect(reads).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits the retry interval from when a failed read settled, and retries on a clock that went back', async () => {
    let clock = 0;
    const failures: ((error: unknown) => void)[] = [];
    const client = createDevvitNotificationsBackendClient({
      request: () => new Promise((_resolve, reject) => {
        failures.push(reject);
      }),
      now: () => clock,
    });
    expect(client.session()).toBeUndefined();
    expect(failures).toHaveLength(1);
    // The read fails 15 seconds later: the next read waits 5 seconds from then.
    clock = 15_000;
    failures.shift()?.(Object.assign(new Error('timeout'), { code: 'DEVVIT_BRIDGE_NETWORK_ERROR', retryable: true }));
    await flushJobs();
    client.session();
    await flushJobs();
    expect(failures).toHaveLength(0);
    clock = 20_000;
    client.session();
    expect(failures).toHaveLength(1);
    failures.shift()?.(Object.assign(new Error('offline'), { code: 'DEVVIT_BRIDGE_NETWORK_ERROR', retryable: true }));
    await flushJobs();
    clock = 0;
    client.session();
    expect(failures).toHaveLength(1);
  });

  it('reads the session on the first call that finds none', async () => {
    const methods: string[] = [];
    const client = createDevvitNotificationsBackendClient({
      request: async (method) => {
        methods.push(method);
        return session;
      },
    });
    const announced: string[] = [];
    client.onAuthenticated((next) => announced.push(next.player));
    await expect(client.listNotices()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await flushJobs();
    expect(announced).toEqual([alice]);
    expect(methods).toEqual(['notifications.backend.getSession']);
    expect(client.session()?.player).toBe(alice);
  });

  it('tries a failed first read again on the next call, but not a settled one', async () => {
    const methods: string[] = [];
    let answer: () => unknown = () => {
      throw Object.assign(new Error('Failed to fetch'), { code: 'DEVVIT_BRIDGE_NETWORK_ERROR', retryable: true });
    };
    const client = createDevvitNotificationsBackendClient({
      request: async (method) => {
        methods.push(method);
        return answer();
      },
      retryIntervalMs: 0,
    });
    await expect(client.refreshSession()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    answer = () => ({ session: null });
    await expect(client.listNotices()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await flushJobs();
    expect(methods).toEqual(['notifications.backend.getSession', 'notifications.backend.getSession']);
    // A logged-out answer settles the read: calls no longer ask again (Reddit reloads the post after login).
    await expect(client.listNotices()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await flushJobs();
    expect(methods).toHaveLength(2);

    // Nor does a server that serves no backend, which a retry cannot change.
    const oldServerMethods: string[] = [];
    const oldServer = createDevvitNotificationsBackendClient({
      request: async (method) => {
        oldServerMethods.push(method);
        throw Object.assign(new Error('Unsupported'), { code: 'UNSUPPORTED_METHOD', retryable: false });
      },
    });
    await expect(oldServer.listConsent()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await flushJobs();
    await expect(oldServer.listConsent()).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await flushJobs();
    expect(oldServerMethods).toEqual(['notifications.backend.getSession']);
  });

  it('unbinds the current player and treats a refusal for a user who left as nothing to unbind', async () => {
    const answers: (() => unknown)[] = [];
    const methods: string[] = [];
    const client = createDevvitNotificationsBackendClient({
      request: async (method, payload) => {
        methods.push(method);
        if (method === 'notifications.backend.getSession') {
          return session;
        }
        expect(payload).toEqual({ expectedPlayer: alice, provider: 'devvit' });
        return answers.shift()?.();
      },
    });
    await client.refreshSession();
    answers.push(() => ({ unregistered: true }));
    await client.unregisterEndpoint({ provider: 'devvit', player: alice });
    answers.push(() => {
      throw Object.assign(new Error('x'), {
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        message: 'signed out (host code NOTIFICATIONS_SIGNED_OUT)',
        retryable: true,
      });
    });
    await expect(client.unregisterEndpoint({ provider: 'devvit', player: alice })).resolves.toBeUndefined();
    answers.push(() => {
      throw Object.assign(new Error('x'), { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', message: 'busy', retryable: true });
    });
    await expect(client.unregisterEndpoint({ provider: 'devvit', player: alice })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
    expect(methods.filter((method) => method === 'notifications.backend.unregisterEndpoint')).toHaveLength(3);
  });

  it.each(['INVALID_BRIDGE_REQUEST', 'NOTIFICATIONS_V2_UNAVAILABLE'])(
    'reads %s from a server that predates the backend methods as configuration-required',
    async (code) => {
      const client = createDevvitNotificationsBackendClient({
        request: async () => {
          throw Object.assign(new Error('old server'), { code, retryable: false });
        },
      });
      await expect(client.refreshSession()).rejects.toMatchObject({
        code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
        retryable: false,
      });
    },
  );
});

describe('createDevvitNotificationsBackendBridgeHandler', () => {
  const request = (method: string, payload: unknown): BridgeRequest => ({
    id: 'r',
    method: method as BridgeRequest['method'],
    payload,
    meta: { target: 'reddit', appVersion: '1', buildId: 'test', sentAt: '2026-10-24T03:00:00Z' },
  });
  const failing = (error: unknown) => {
    const fail = async (): Promise<never> => {
      throw error;
    };
    return {
      recordConsent: fail,
      listConsent: fail,
      registerEndpoint: fail,
      unregisterEndpoint: fail,
      setReminder: fail,
      cancelReminder: fail,
      listNotices: fail,
      recordNoticeShown: fail,
    };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the service text on the server and logs failures other than the consent write cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const internal = createDevvitNotificationsBackendBridgeHandler({
      service: failing(new Error('redis: WRONGTYPE at key mpgd:secret')),
      context: () => ({ userId: alice }),
    });
    const answer = await internal.request(request('notifications.backend.listConsent', { expectedPlayer: alice }));
    expect(answer).toEqual({
      id: 'r',
      ok: false,
      error: {
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        message: 'notifications.backend.listConsent failed on the Devvit server.',
        retryable: true,
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const capped = createDevvitNotificationsBackendBridgeHandler({
      service: failing(new NotificationConsentRateLimitError(60)),
      context: () => ({ userId: alice }),
    });
    const throttled = await capped.request(request('notifications.backend.recordConsent', {
      expectedPlayer: alice,
      record: { kind: 'topic-preference', topic: 'daily-puzzle', state: 'granted', source: 'player', at: '2026-10-24T03:00:00Z' },
    }));
    expect(throttled).toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports a context it cannot read instead of answering logged out', async () => {
    const failures: unknown[] = [];
    for (const context of [
      () => {
        throw new TypeError('context is not available outside a request');
      },
      () => ({ userId: 'alice' }),
    ]) {
      const handler = createDevvitNotificationsBackendBridgeHandler({
        service: failing(new Error('unused')),
        context,
        onError: (error) => failures.push(error),
      });
      const answer = await handler.request(request('notifications.backend.getSession', { protocol: 'mpgd.notifications.v2' }));
      expect(answer).toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' } });
    }
    expect(failures).toHaveLength(2);
    for (const context of [() => ({}), () => ({ userId: null })]) {
      const loggedOut = createDevvitNotificationsBackendBridgeHandler({
        service: failing(new Error('unused')),
        context,
      });
      await expect(loggedOut.request(request('notifications.backend.getSession', { protocol: 'mpgd.notifications.v2' })))
        .resolves.toEqual({ id: 'r', ok: true, data: { session: null } });
    }
  });
});

describe('createDevvitNotificationsBackend', () => {
  const bridgeFor = (users: { current: string | undefined }, methods: string[]) => ({
    async request(request: BridgeRequest): Promise<BridgeResponse> {
      methods.push(request.method);
      if (request.method === 'notifications.backend.getSession') {
        return {
          id: request.id,
          ok: true,
          data: { session: users.current === undefined ? null : { id: `devvit:${users.current}`, player: users.current } },
        };
      }
      return { id: request.id, ok: true, data: { records: [] } };
    },
  });

  it('loads its client chunk, reads the session at once, and forwards the announcement', async () => {
    const methods: string[] = [];
    const announced: string[] = [];
    const backend = createDevvitNotificationsBackend({
      appVersion: '1',
      buildId: 'test',
      bridge: bridgeFor({ current: alice }, methods),
      load: async () => backendClientModule,
    });
    backend.onAuthenticated((session) => announced.push(session.player));
    expect(backend.session()).toBeUndefined();
    // The loader is injected, so the chunk and the session read settle in promise jobs alone.
    await flushJobs();
    expect(methods).toEqual(['notifications.backend.getSession']);
    expect(announced).toEqual([alice]);
    expect(backend.session()).toEqual({ id: `devvit:${alice}`, player: alice });
    await expect(backend.listConsent()).resolves.toEqual([]);
    expect(methods.at(-1)).toBe('notifications.backend.listConsent');
  });

  it('loads a chunk that failed again from session(), at most once per retry interval', async () => {
    let attempts = 0;
    let clock = 0;
    const backend = createDevvitNotificationsBackend({
      appVersion: '1',
      buildId: 'test',
      bridge: bridgeFor({ current: alice }, []),
      now: () => clock,
      load: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('chunk failed');
        }
        return backendClientModule;
      },
    });
    await flushJobs();
    expect(backend.session()).toBeUndefined();
    await flushJobs();
    expect(attempts).toBe(1);
    // A clock that went backwards does not hold the retry back.
    clock = -60_000;
    expect(backend.session()).toBeUndefined();
    await flushJobs();
    expect(attempts).toBe(2);
    expect(backend.session()).toEqual({ id: `devvit:${alice}`, player: alice });
    // Options the client refuses are not a load to retry.
    const refused = createDevvitNotificationsBackend({
      appVersion: '1',
      buildId: 'test',
      bridge: bridgeFor({ current: alice }, []),
      timeoutMs: 0,
      load: async () => backendClientModule,
    });
    await expect(refused.listNotices()).rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    // Unbinding before anything loaded sends nothing.
    await expect(refused.unregisterEndpoint({ provider: 'devvit', player: alice })).resolves.toBeUndefined();
  });

  it('answers a chunk that did not load as retryable, and loads again on the next call', async () => {
    let attempts = 0;
    const methods: string[] = [];
    const backend = createDevvitNotificationsBackend({
      appVersion: '1',
      buildId: 'test',
      bridge: bridgeFor({ current: alice }, methods),
      load: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('chunk failed');
        }
        return backendClientModule;
      },
    });
    await flushJobs();
    expect(attempts).toBe(1);
    await expect(backend.refreshSession()).resolves.toEqual({ id: `devvit:${alice}`, player: alice });
    expect(attempts).toBe(2);
    const failing = createDevvitNotificationsBackend({
      appVersion: '1',
      buildId: 'test',
      bridge: bridgeFor({ current: alice }, []),
      load: async () => {
        throw new Error('chunk failed');
      },
    });
    await expect(failing.listNotices()).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
  });
});
