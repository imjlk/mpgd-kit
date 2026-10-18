import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import type { NotificationDispatchJob } from '@mpgd/game-services/notifications';
import { Miniflare } from 'miniflare';

import { createWorkerFetchHandler, type GameServicesWorkerEnv } from './handler.js';
import {
  consumeNotificationDispatchBatch,
  deliverWorkerNotification,
  endWorkerNotificationSession,
  runScheduledNotifications,
} from './notificationsHandler.js';

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
const serviceAccount = JSON.stringify({
  type: 'service_account',
  project_id: 'mpgd-worker-test',
  private_key_id: 'worker-test-key',
  private_key: pemOf(btoa(String.fromCharCode(...pkcs8))),
  client_email: 'sender@mpgd-worker-test.iam.gserviceaccount.com',
});

// Google stands in through fetch: token grants and FCM sends are recorded, nothing leaves the process.
const sends: { readonly token: string; readonly channel: unknown; readonly body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === 'https://oauth2.googleapis.com/token') {
    return Response.json({ access_token: 'worker-access-token', expires_in: 3600 });
  }
  if (url === 'https://fcm.googleapis.com/v1/projects/mpgd-worker-test/messages:send') {
    const body = JSON.parse(String(init?.body)) as {
      readonly message: { readonly token: string; readonly android?: { readonly notification?: { readonly channel_id?: unknown } } };
    };
    sends.push({ token: body.message.token, channel: body.message.android?.notification?.channel_id, body: String(init?.body) });
    return Response.json({ name: `projects/mpgd-worker-test/messages/${sends.length}` });
  }
  return realFetch(input, init);
}) as typeof fetch;

const catalog = {
  version: '2026-10-19',
  defaultLocale: 'ko',
  topics: [
    {
      id: 'friend-challenge',
      purpose: 'service',
      channels: ['remote'],
      route: '/?entry=challenge',
      copy: { ko: { title: '도전', body: '{{name}}님이 도전했어요.' } },
      targets: { android: { channelId: 'social' }, ios: {} },
    },
  ],
};
const sessions: Readonly<Record<string, { playerId: string; sessionId: string; installationId: string }>> = {
  'Bearer player-1': { playerId: 'p-1', sessionId: 's-1', installationId: 'install-1' },
  'Bearer player-1-ios': { playerId: 'p-1', sessionId: 's-2', installationId: 'install-2' },
  'Bearer broken': { playerId: '', sessionId: 's', installationId: 'i' } as never,
  'Bearer bad-expiry': { playerId: 'p-9', sessionId: 's-9', installationId: 'i-9', expiresAt: 'tomorrow' } as never,
};
const auth = {
  async authenticateNotificationSession({ authorization }: { readonly authorization: string }) {
    return sessions[authorization] ?? null;
  },
};
const env = {
  MPGD_STORE: 'memory',
  MPGD_NOTIFICATIONS_CATALOG: catalog,
  FCM_SERVICE_ACCOUNT: serviceAccount,
  GAME_SERVICES_NOTIFICATIONS_AUTH: auth,
} satisfies GameServicesWorkerEnv;
const base = 'https://game-services-worker.test/game-services/notifications';
const fetchWorker = createWorkerFetchHandler(env);
const call = async (path: string, init: { method?: string; authorization?: string; body?: unknown } = {}) => {
  const response = await fetchWorker(
    new Request(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(init.authorization === undefined ? {} : { authorization: init.authorization }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
    headers: response.headers,
  };
};

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'notifications-routes' },
});

try {
  // The registry is public; session routes need a session.
  const providers = await call('/providers');
  assert.equal(providers.status, 200);
  assert.deepEqual(providers.body.targets, { android: 'fcm', ios: 'fcm' });
  assert.equal(providers.body.protocolVersion, '2.0.0-draft.1');
  assert.equal(providers.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call('/consent')).status, 401);
  assert.equal((await call('/consent', { authorization: 'Bearer nobody' })).status, 401);
  assert.equal((await call('/consent', { authorization: 'Bearer broken' })).status, 500);
  assert.equal(
    (await call('/consent', { method: 'DELETE', authorization: 'Bearer player-1' })).status,
    405,
  );
  assert.equal((await call('/elsewhere', { authorization: 'Bearer player-1' })).status, 404);
  assert.equal((await call('/providers', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call('/consent', { authorization: 'Bearer bad-expiry' })).status, 500);
  assert.equal((await call('/', { authorization: 'Bearer player-1' })).status, 404);
  const preflight = await fetchWorker(new Request(`${base}/consent`, { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get('access-control-allow-headers'),
    'Content-Type, Authorization',
  );
  // Session answers are never cached.
  assert.equal(
    (await call('/consent', { authorization: 'Bearer player-1' })).headers.get('cache-control'),
    'no-store',
  );
  // A body past 64 KiB is refused while it streams, whatever Content-Length says.
  const oversize = await fetchWorker(new Request(`${base}/consent`, {
    method: 'POST',
    headers: { authorization: 'Bearer player-1' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk = 0; chunk < 20; chunk += 1) {
          controller.enqueue(new TextEncoder().encode(' '.repeat(4096)));
        }
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit));
  assert.equal(oversize.status, 413);

  // Endpoints: the installation is the session's; the target picks the mapping.
  const registration = (value: string) => ({
    provider: 'fcm',
    address: { kind: 'fcm-token', value, permission: 'granted' },
    locale: 'ko-KR',
    timeZone: 'Asia/Seoul',
  });
  const missingTarget = await call('/endpoints', {
    authorization: 'Bearer player-1',
    body: { registration: registration('tok-a') },
  });
  assert.deepEqual(
    [missingTarget.status, missingTarget.body.error],
    [400, 'NOTIFICATIONS_INVALID_INPUT'],
  );
  assert.equal((await call('/endpoints', {
    authorization: 'Bearer player-1',
    body: { registration: registration('tok-a'), target: 'android', installationId: 'someone-else' },
  })).status, 200);
  assert.equal((await call('/endpoints', {
    authorization: 'Bearer player-1-ios',
    body: { registration: registration('tok-b'), target: 'ios' },
  })).status, 200);
  // A field of the wrong type is a 400, never another request.
  for (const [path, body] of [
    ['/endpoints/unregister', { provider: 5 }],
    ['/endpoints', { registration: registration('tok-x'), target: 7 }],
    [
      '/notices/shown',
      {
        notice: {
          kind: 'consent-result',
          record: { kind: 'advertising', at: '2026-10-19T03:00:00Z' },
          dueBy: '2026-11-02',
        },
        channel: 'push',
      },
    ],
  ] as const) {
    const refused = await call(path, { authorization: 'Bearer player-1', body });
    assert.deepEqual(
      [path, refused.status, refused.body.error],
      [path, 400, 'NOTIFICATIONS_INVALID_INPUT'],
    );
  }
  const malformed = await fetchWorker(
    new Request(`${base}/endpoints`, {
      method: 'POST',
      headers: { authorization: 'Bearer player-1' },
      body: '{',
    }),
  );
  assert.equal(malformed.status, 400);

  // Consent: dated by the backend; a provider record is refused.
  const consent = await call('/consent', {
    authorization: 'Bearer player-1',
    body: {
      record: {
        kind: 'topic-preference',
        topic: 'friend-challenge',
        state: 'granted',
        source: 'player',
        at: '1999-01-01T00:00:00Z',
      },
    },
  });
  assert.equal(consent.status, 200);
  assert.notEqual((consent.body.record as { readonly at: string }).at, '1999-01-01T00:00:00Z');
  const forged = await call('/consent', {
    authorization: 'Bearer player-1',
    body: {
      record: {
        kind: 'host-agreement',
        topic: 'friend-challenge',
        state: 'denied',
        source: 'provider',
      },
    },
  });
  assert.deepEqual([forged.status, forged.body.error], [400, 'NOTIFICATIONS_INVALID_INPUT']);
  assert.equal(
    ((await call('/consent', { authorization: 'Bearer player-1' })).body.records as unknown[]).length,
    1,
  );
  // Without the Korean rules there are no notices to list or record.
  assert.deepEqual((await call('/notices', { authorization: 'Bearer player-1' })).body.notices, []);
  assert.equal((await call('/notices/shown', {
    authorization: 'Bearer player-1',
    body: { notice: { kind: 'consent-result', record: { kind: 'advertising', at: '2026-10-19T03:00:00Z' }, dueBy: '2026-11-02' } },
  })).status, 200);

  // A game server sends through the service binding; FCM gets each device with its target's channel.
  assert.deepEqual(
    await deliverWorkerNotification(env, {
      idempotencyKey: 'worker-send-1',
      player: 'p-1',
      topic: 'friend-challenge',
      templateData: { name: 'Mina' },
    }),
    { status: 'delivered', alreadyProcessed: false },
  );
  assert.deepEqual(
    sends.map((send) => [send.token, send.channel]),
    [
      ['tok-a', 'social'],
      ['tok-b', undefined],
    ],
  );
  assert.ok(sends[0]?.body.includes('Mina님이 도전했어요.'));
  await assert.rejects(
    deliverWorkerNotification(env, {
      idempotencyKey: 'worker-send-1',
      player: 'p-1',
      topic: 'friend-challenge',
    }),
    { code: 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT' },
  );
  // Ending a session unbinds what it registered; an explicit unbind removes the other.
  await endWorkerNotificationSession(env, { sessionId: 's-2' });
  assert.equal(
    (await call('/endpoints/unregister', { authorization: 'Bearer player-1', body: { provider: 'fcm' } })).status,
    200,
  );
  assert.deepEqual(
    await deliverWorkerNotification(env, { idempotencyKey: 'worker-send-2', player: 'p-1', topic: 'friend-challenge', templateData: { name: 'A' } }),
    { status: 'unavailable', reason: 'no-endpoint' },
  );

  // A queue needs D1: the consumer runs in another isolate than the send.
  const memoryQueue = {
    ...env,
    NOTIFICATIONS_QUEUE: {} as Queue<NotificationDispatchJob>,
  } satisfies GameServicesWorkerEnv;
  assert.equal(
    (await createWorkerFetchHandler(memoryQueue)(new Request(`${base}/providers`))).status,
    500,
  );

  // With a queue, the fan-out runs in the consumer.
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  const migration = await readFile(
    new URL('../migrations/0007_notifications.sql', import.meta.url),
    'utf8',
  );
  const statements = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .filter((statement) => statement.trim() !== '');
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  const queued: NotificationDispatchJob[] = [];
  const queueEnv = {
    ...env,
    MPGD_STORE: 'd1',
    DB: db,
    NOTIFICATIONS_QUEUE: {
      async sendBatch(messages: Iterable<MessageSendRequest<NotificationDispatchJob>>) {
        for (const message of messages) {
          queued.push(message.body);
        }
      },
    } as unknown as Queue<NotificationDispatchJob>,
  } satisfies GameServicesWorkerEnv;
  const queueFetch = createWorkerFetchHandler(queueEnv);
  await queueFetch(
    new Request(`${base}/endpoints`, {
      method: 'POST',
      headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
      body: JSON.stringify({ registration: registration('tok-q'), target: 'android' }),
    }),
  );
  const queuedSend = {
    idempotencyKey: 'worker-queued',
    player: 'p-1',
    topic: 'friend-challenge',
    templateData: { name: 'Q' },
  };
  assert.deepEqual(await deliverWorkerNotification(queueEnv, queuedSend), { status: 'in-flight' });
  assert.deepEqual(queued, [
    { sendKey: 'worker-queued', provider: 'fcm', rowKey: 'worker-queued:install-1' },
  ]);
  const acks: unknown[] = [];
  const batch = (messages: readonly { readonly body: unknown; readonly attempts?: number }[]) => ({
    queue: 'notifications',
    messages: messages.map((message, index) => ({
      id: `m-${index}`,
      timestamp: new Date(),
      attempts: message.attempts ?? 1,
      body: message.body,
      ack: () => acks.push('ack'),
      retry: (options?: unknown) => acks.push(['retry', options]),
    })),
    ackAll() {},
    retryAll() {},
  }) as unknown as MessageBatch<unknown>;
  // The first attempt's connection drops: ambiguous, so the job is done and the row waits for its lease.
  const sendCount = sends.length;
  const googleFetch = globalThis.fetch;
  let dropNext = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (dropNext && String(input instanceof Request ? input.url : input).includes('messages:send')) {
      dropNext = false;
      throw new TypeError('fetch failed');
    }
    return googleFetch(input, init);
  }) as typeof fetch;
  await consumeNotificationDispatchBatch(
    queueEnv,
    batch([{ body: queued[0] }, { body: { nope: true } }]),
  );
  globalThis.fetch = googleFetch;
  assert.deepEqual(acks.splice(0), ['ack', 'ack']);
  assert.equal(sends.length, sendCount);
  assert.deepEqual(await deliverWorkerNotification(queueEnv, queuedSend), { status: 'in-flight' });
  // A job the store cannot settle is retried by the queue with a growing delay.
  await deliverWorkerNotification(queueEnv, { ...queuedSend, idempotencyKey: 'worker-queued-2' });
  await consumeNotificationDispatchBatch(
    { ...queueEnv, DB: brokenDb(db, /^\s*UPDATE/u) } satisfies GameServicesWorkerEnv,
    batch([{ body: queued[1], attempts: 2 }]),
  );
  assert.deepEqual(acks.splice(0), [['retry', { delaySeconds: 20 }]]);
  // A misconfigured Worker acknowledges: the rows stay due for the cron.
  await consumeNotificationDispatchBatch(
    { ...queueEnv, MPGD_NOTIFICATIONS_CATALOG: { version: 'x' } } satisfies GameServicesWorkerEnv,
    batch([{ body: queued[1] }]),
  );
  assert.deepEqual(acks.splice(0), ['ack']);
  await consumeNotificationDispatchBatch(queueEnv, batch([{ body: queued[1] }]));
  assert.deepEqual(acks.splice(0), ['ack']);
  assert.equal(sends.at(-1)?.token, 'tok-q');
  // The cron replays the ambiguous row after its lease, even when the purge fails.
  // The lease is moved into the past in place of waiting five minutes.
  const stored = await db.prepare('SELECT send_json FROM notification_sends WHERE send_key = ?')
    .bind('worker-queued')
    .first<{ readonly send_json: string }>();
  const expired = JSON.parse(stored?.send_json ?? '{}') as {
    rows: { state: { leaseUntil?: string } }[];
  };
  for (const row of expired.rows) {
    if (row.state.leaseUntil !== undefined) {
      row.state.leaseUntil = '2026-01-01T00:00:00Z';
    }
  }
  await db.prepare('UPDATE notification_sends SET send_json = ?, due_at_ms = ? WHERE send_key = ?')
    .bind(JSON.stringify(expired), Date.parse('2026-01-01T00:00:00Z'), 'worker-queued')
    .run();
  await runScheduledNotifications(
    { ...queueEnv, DB: brokenDb(db, /^\s*DELETE/u) } satisfies GameServicesWorkerEnv,
  );
  assert.deepEqual(await deliverWorkerNotification(queueEnv, queuedSend), {
    status: 'delivered',
    alreadyProcessed: true,
  });

  // Without a catalog the routes are not mounted; a broken catalog fails closed at 500.
  assert.equal(
    (await createWorkerFetchHandler({ MPGD_STORE: 'memory' })(new Request(`${base}/providers`))).status,
    404,
  );
  const broken = {
    ...env,
    MPGD_NOTIFICATIONS_CATALOG: { version: 'x', defaultLocale: 'ko', topics: [{ id: 'x' }] },
  } satisfies GameServicesWorkerEnv;
  assert.equal(
    (await createWorkerFetchHandler(broken)(new Request(`${base}/providers`))).status,
    500,
  );
  await assert.rejects(deliverWorkerNotification(broken, {}), {
    code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
  });
  // Without the session binding, only the public registry is served.
  const { GAME_SERVICES_NOTIFICATIONS_AUTH: _auth, ...unauthenticated } = env;
  assert.equal(
    (await createWorkerFetchHandler(unauthenticated)(new Request(`${base}/consent`, { headers: { authorization: 'Bearer player-1' } }))).status,
    404,
  );
  assert.equal(
    (await createWorkerFetchHandler(unauthenticated)(new Request(`${base}/providers`))).status,
    200,
  );
  console.info('Worker notifications routes passed.');
} finally {
  globalThis.fetch = realFetch;
  await miniflare.dispose();
}

/** The database with matching statements refused (and every batch), as an unavailable D1 answers. */
function brokenDb(db: D1Database, pattern: RegExp): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (pattern.test(sql)) {
            throw new Error('D1 is unavailable.');
          }
          return target.prepare(sql);
        };
      }
      if (property === 'batch') {
        return async () => {
          throw new Error('D1 is unavailable.');
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A PEM block of a key generated by this test; the markers are joined at run time. */
function pemOf(base64: string): string {
  const label = ['PRIVATE', 'KEY'].join(' ');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}
