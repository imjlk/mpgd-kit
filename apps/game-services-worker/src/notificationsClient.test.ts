import assert from 'node:assert/strict';

import { resolveNotificationTopicsForTarget, type NotificationTopicCatalog } from '@mpgd/catalog';
import {
  createGameServicesNotificationsClient,
  GameServicesNotificationsRequestError,
  type GameServicesNotificationSession,
} from '@mpgd/game-services/notifications/client';
import { NotificationError, type NotificationCapabilities } from '@mpgd/platform/notifications';
import { createNotificationConformanceHost } from '@mpgd/platform/notifications-conformance';
import {
  createMemoryNotificationRuntimeStorage,
  createNotificationRuntime,
} from '@mpgd/platform/notifications-runtime';

import { createWorkerFetchHandler, type GameServicesWorkerEnv } from './handler.js';
import { deliverWorkerNotification } from './notificationsHandler.js';

/**
 * End to end: the production notifications runtime calls the real Worker
 * handler in process through the game-services notifications client, with
 * the memory store, a fake `GAME_SERVICES_NOTIFICATIONS_AUTH` binding, and
 * FCM answered through a stubbed `fetch`. Nothing leaves the process.
 */

// A service-account key generated for this run: no real Firebase credential.
const keys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
const label = ['PRIVATE', 'KEY'].join(' ');
const serviceAccount = JSON.stringify({
  type: 'service_account',
  project_id: 'mpgd-client-e2e',
  private_key_id: 'client-e2e-key',
  private_key: `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END ${label}-----\n`,
  client_email: 'sender@mpgd-client-e2e.iam.gserviceaccount.com',
});

// Google stands in through the global fetch, which only the Worker's FCM provider uses.
const fcmTokens: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === 'https://oauth2.googleapis.com/token') {
    return Response.json({ access_token: 'e2e-access-token', expires_in: 3600 });
  }
  if (url === 'https://fcm.googleapis.com/v1/projects/mpgd-client-e2e/messages:send') {
    const body = JSON.parse(String(init?.body)) as { readonly message: { readonly token: string } };
    fcmTokens.push(body.message.token);
    return Response.json({ name: `projects/mpgd-client-e2e/messages/${fcmTokens.length}` });
  }
  // Nothing else may leave the process.
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

let runtime: ReturnType<typeof createNotificationRuntime> | undefined;
try {
  const catalog: NotificationTopicCatalog = {
    version: '2026-10-20',
    defaultLocale: 'ko',
    topics: [
      {
        id: 'daily-ready',
        purpose: 'requested',
        channels: ['remote'],
        route: '/?entry=daily',
        copy: { ko: { title: '오늘의 퍼즐', body: '새 퍼즐이 준비됐어요.' } },
        targets: { android: { channelId: 'reminders' } },
      },
      {
        id: 'friend-challenge',
        purpose: 'service',
        channels: ['remote'],
        route: '/?entry=challenge',
        copy: { ko: { title: '도전', body: '도전장이 왔어요.' } },
        targets: { android: { channelId: 'social' } },
      },
    ],
  };

  /** The identity Worker's sessions, by bearer token; revoking one makes the Worker answer 401. */
  const issued = new Map<string, { playerId: string; sessionId: string; installationId: string }>();
  const env = {
    MPGD_STORE: 'memory',
    MPGD_NOTIFICATIONS_CATALOG: catalog,
    MPGD_NOTIFICATIONS_DEPLOYMENT: {
      advertisingRules: 'kr',
      advertisingSender: { contact: '080-000-0000' },
    },
    FCM_SERVICE_ACCOUNT: serviceAccount,
    GAME_SERVICES_NOTIFICATIONS_AUTH: {
      async authenticateNotificationSession({ authorization }: { readonly authorization: string }) {
        return issued.get(authorization) ?? null;
      },
    },
  } satisfies GameServicesWorkerEnv;
  const fetchWorker = createWorkerFetchHandler(env);

  /** Requests the client sent to the Worker. */
  let workerRequests = 0;
  // The game's identity: the current session, its bearer token, and the sign-in subscription.
  let current: (GameServicesNotificationSession & { readonly token: string }) | undefined;
  const signedIn = new Set<(session: GameServicesNotificationSession) => void>();
  const signIn = (session: GameServicesNotificationSession, token: string): void => {
    issued.set(`Bearer ${token}`, { ...session, installationId: 'install-e2e' });
    current = { ...session, token };
    for (const listener of [...signedIn]) {
      listener(session);
    }
  };

  const client = createGameServicesNotificationsClient({
    baseUrl: 'https://game-services-worker.test',
    fetch: async (url, init) => {
      workerRequests += 1;
      return fetchWorker(new Request(url, init));
    },
    identity: {
      current: () => current,
      onAuthenticated(listener) {
        signedIn.add(listener);
        return () => {
          signedIn.delete(listener);
        };
      },
    },
    getHeaders: () => (current === undefined ? {} : { Authorization: `Bearer ${current.token}` }),
    target: 'android',
  });

  // The device: a fixture FCM provider whose declaration matches the Worker's registry entry.
  const providers = await client.getProviders();
  assert.deepEqual(providers.targets, { android: 'fcm', ios: 'fcm' });
  const registryEntry = providers.providers.find((entry) => entry.provider === 'fcm');
  assert.ok(registryEntry !== undefined);
  const capabilities: NotificationCapabilities = {
    availability: 'available',
    permission: {
      scope: 'app',
      prompt: 'os',
      readable: true,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: false,
      promptLimit: 2,
      settings: true,
    },
    remote: {
      supported: true,
      purposes: ['service', 'requested', 'advertising'],
      addressing: 'device',
      content: 'free-form',
    },
    local: { supported: false },
    open: 'payload',
  };
  const topics = resolveNotificationTopicsForTarget(catalog, 'android');
  const host = createNotificationConformanceHost({
    profile: { provider: 'fcm', capabilities },
    catalog: topics,
    timeZone: 'Asia/Seoul',
  });
  runtime = createNotificationRuntime({
    provider: host.provider,
    backend: client,
    catalog: topics,
    defaultLocale: 'ko',
    registryEntry,
    storage: createMemoryNotificationRuntimeStorage(),
  });
  const deliver = (key: string) => deliverWorkerNotification(env, {
    idempotencyKey: key,
    player: 'p-e2e',
    topic: 'friend-challenge',
  });
  /** A 401 from the Worker, as the client maps it. */
  const isUnauthorized = (error: unknown): boolean =>
    error instanceof GameServicesNotificationsRequestError
    && error.status === 401
    && error.code === 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE'
    && error.retryable;
  // Another device of the same player, registered through its own session and installation.
  issued.set('Bearer token-other', {
    playerId: 'p-e2e',
    sessionId: 's-other',
    installationId: 'install-other',
  });
  const otherDevice = await fetchWorker(
    new Request('https://game-services-worker.test/game-services/notifications/endpoints', {
      method: 'POST',
      headers: { authorization: 'Bearer token-other', 'content-type': 'application/json' },
      body: JSON.stringify({
        registration: {
          provider: 'fcm',
          address: { kind: 'fcm-token', value: 'tok-other', permission: 'granted' },
        },
        target: 'android',
      }),
    }),
  );
  assert.equal(otherDevice.status, 200);
  const requestsBefore = workerRequests;

  host.issueEndpoint({ kind: 'fcm-token', value: 'tok-e2e' });
  await runtime.start();
  // Signed out: a backend call is temporarily unavailable and sends nothing.
  await assert.rejects(
    runtime.setTopicPreference({ topic: 'daily-ready', enabled: true }),
    (error: unknown) => error instanceof NotificationError && error.code === 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
  );
  assert.equal(workerRequests, requestsBefore);

  // Sign-in registers this installation with the device's permission, not yet granted: no send reaches it.
  signIn({ playerId: 'p-e2e', sessionId: 's-e2e-1' }, 'token-1');
  await runtime.runUntilIdle();
  assert.equal((await deliver('e2e-send-0') as { readonly status?: unknown }).status, 'delivered');
  assert.deepEqual(fcmTokens, ['tok-other']);
  fcmTokens.length = 0;

  // The grant re-registers it as granted, bound to this session's installation.
  host.queuePrompt('granted');
  const granted = await runtime.requestPermission({ topics: ['daily-ready'], gesture: true });
  assert.equal(granted.outcomes['daily-ready'], 'granted');
  await runtime.runUntilIdle();
  assert.deepEqual(await deliver('e2e-send-1'), { status: 'delivered', alreadyProcessed: false });
  assert.deepEqual([...fcmTokens].sort(), ['tok-e2e', 'tok-other']);
  fcmTokens.length = 0;

  // Consent records: the player's request for a requested topic, read back from GET /consent.
  await runtime.setTopicPreference({ topic: 'daily-ready', enabled: true });
  const records = await client.listConsent();
  assert.deepEqual(
    records.map((record) => [record.kind, record.topic, record.state, record.source]),
    [['topic-preference', 'daily-ready', 'granted', 'player']],
  );

  // Server reminders: set and cancel by key.
  const fireAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.deepEqual(await runtime.reminders.set({ key: 'daily', topic: 'daily-ready', fireAt }), {
    route: 'remote',
    status: 'scheduled',
  });
  assert.deepEqual(await runtime.reminders.set({ key: 'daily', topic: 'daily-ready', fireAt }), {
    route: 'remote',
    status: 'replaced',
  });
  assert.deepEqual(await runtime.reminders.cancel({ key: 'daily' }), {
    route: 'remote',
    status: 'cancelled',
  });
  assert.deepEqual(await runtime.reminders.cancel({ key: 'daily' }), {
    route: 'none',
    status: 'cancelled',
  });
  // A reminder the Worker refuses as invalid surfaces as invalid input.
  await assert.rejects(
    runtime.reminders.set({
      key: 'far',
      topic: 'daily-ready',
      fireAt: new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    (error: unknown) =>
      error instanceof GameServicesNotificationsRequestError
      && error.code === 'NOTIFICATIONS_INVALID_INPUT'
      && error.status === 400,
  );

  // Advertising consent under the Korean rules lists the result notice; recording it removes it.
  await runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: '1' });
  const notices = await runtime.notices.list();
  assert.deepEqual(
    notices.map((notice) => [notice.kind, notice.record.kind, notice.record.state, notice.variant]),
    [['consent-result', 'advertising', 'granted', 'consent-result.advertising.granted']],
  );
  const [notice] = notices;
  assert.ok(notice !== undefined);
  await runtime.notices.recordShown(notice);
  assert.deepEqual(await runtime.notices.list(), []);

  // Logout: unregister() unbinds this session's installation only; the other device still receives.
  await runtime.unregister();
  issued.delete('Bearer token-1');
  assert.equal((await deliver('e2e-send-2') as { readonly status?: unknown }).status, 'delivered');
  assert.deepEqual(fcmTokens, ['tok-other']);
  fcmTokens.length = 0;

  // The next sign-in binds the installation again.
  signIn({ playerId: 'p-e2e', sessionId: 's-e2e-2' }, 'token-2');
  await runtime.runUntilIdle();
  assert.deepEqual(await deliver('e2e-send-3'), { status: 'delivered', alreadyProcessed: false });
  assert.deepEqual([...fcmTokens].sort(), ['tok-e2e', 'tok-other']);

  // A 401 mid-session: the identity service revoked the token while the game still holds it.
  issued.delete('Bearer token-2');
  const active = runtime;
  for (const work of [
    () => active.setTopicPreference({ topic: 'daily-ready', enabled: false }),
    () => active.notices.list(),
    () => active.reminders.set({ key: 'daily', topic: 'daily-ready', fireAt }),
  ]) {
    await assert.rejects(work(), isUnauthorized);
  }
  // The read still answers from the host; the backend's 401 surfaces in the background.
  const read = await runtime.getPermission({ topics: ['daily-ready'] });
  assert.equal(read.topics['daily-ready'], 'granted');
  const background = await runtime.runUntilIdle().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(
    isUnauthorized(background)
      || (background instanceof AggregateError && background.errors.every(isUnauthorized)),
    `expected the 401 in the background, got ${String(background)}`,
  );
  console.info('notifications client end to end against the Worker handler passed');
} finally {
  runtime?.stop();
  globalThis.fetch = realFetch;
}
