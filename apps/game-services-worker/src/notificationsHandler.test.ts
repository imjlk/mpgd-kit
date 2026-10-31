import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import {
  isInsideNotificationHoldWindow,
  type NotificationDispatchJob,
} from '@mpgd/game-services/notifications';
import { Miniflare } from 'miniflare';

import {
  createWorkerFetchHandler,
  createWorkerService,
  type GameServicesWorkerEnv,
} from './handler.js';
import {
  asWorkerNotificationRpcResult,
  consumeNotificationDispatchBatch,
  deliverWorkerNotification,
  deliverWorkerNotificationBulk,
  endWorkerNotificationSession,
  notificationCronOperationsUsed,
  notificationCronPeriodSeconds,
  notificationFailureCause,
  resolveWorkerNotifications,
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
let holdGoogleFetch: Promise<void> | undefined;
let noteGoogleFetchEntered: (() => void) | undefined;
let unauthorizedSendsLeft = 0;
let countGoogleFetches = false;
let googleFetchCount = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const google = url === 'https://oauth2.googleapis.com/token'
    || url === 'https://fcm.googleapis.com/v1/projects/mpgd-worker-test/messages:send';
  if (countGoogleFetches && google) {
    googleFetchCount += 1;
  }
  if (holdGoogleFetch !== undefined && url === 'https://oauth2.googleapis.com/token') {
    noteGoogleFetchEntered?.();
    noteGoogleFetchEntered = undefined;
    await holdGoogleFetch;
  }
  if (url === 'https://oauth2.googleapis.com/token') {
    return Response.json({ access_token: 'worker-access-token', expires_in: 3600 });
  }
  if (url === 'https://fcm.googleapis.com/v1/projects/mpgd-worker-test/messages:send' && unauthorizedSendsLeft > 0) {
    unauthorizedSendsLeft -= 1;
    return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
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
  'Bearer chatty': { playerId: 'p-chatty', sessionId: 's-chatty', installationId: 'install-chatty' },
  'Bearer endpoint-chatty': {
    playerId: 'p-endpoint',
    sessionId: 's-endpoint',
    installationId: 'install-endpoint',
  },
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
  // A guest session writing endpoints in a loop is capped per day, like consent.
  const registerAgain = () =>
    call('/endpoints', {
      authorization: 'Bearer endpoint-chatty',
      body: { registration: registration('tok-loop'), target: 'android' },
    });
  for (let index = 0; index < 200; index += 1) {
    assert.equal((await registerAgain()).status, 200);
  }
  const endpointCapped = await registerAgain();
  assert.deepEqual(
    [endpointCapped.status, endpointCapped.body.error],
    [429, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE'],
  );
  assert.ok(
    Number(endpointCapped.headers.get('retry-after')) > 86_000,
    endpointCapped.headers.get('retry-after') ?? 'no Retry-After',
  );
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
  // A client writing consent in a loop is capped per day and told when to retry.
  const toggle = (index: number) =>
    call('/consent', {
      authorization: 'Bearer chatty',
      body: {
        record: {
          kind: 'topic-preference',
          topic: 'friend-challenge',
          state: index % 2 === 0 ? 'granted' : 'withdrawn',
          source: 'player',
        },
      },
    });
  for (let index = 0; index < 200; index += 1) {
    assert.equal((await toggle(index)).status, 200);
  }
  const capped = await toggle(200);
  assert.deepEqual(
    [capped.status, capped.body.error],
    [429, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE'],
  );
  assert.ok(
    Number(capped.headers.get('retry-after')) > 86_000,
    capped.headers.get('retry-after') ?? 'no Retry-After',
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
      ['tok-b', 'mpgd-service'],
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
  // Server reminders: set and cancel by key over the session routes; the cron fires them.
  const reminder = (fireAt: string) => ({
    key: 'rematch',
    topic: 'friend-challenge',
    fireAt,
    templateData: { name: 'Jun' },
  });
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.deepEqual(
    (await call('/reminders', { authorization: 'Bearer player-1', body: { reminder: reminder(past) } })).body,
    { status: 'scheduled' },
  );
  assert.deepEqual(
    (await call('/reminders', { authorization: 'Bearer player-1', body: { reminder: reminder(past) } })).body,
    { status: 'replaced' },
  );
  for (const body of [{ reminder: { ...reminder(past), fireAt: 'soon' } }, { reminder: 'x' }, {}]) {
    const refused = await call('/reminders', { authorization: 'Bearer player-1', body });
    assert.deepEqual([refused.status, refused.body.error], [400, 'NOTIFICATIONS_INVALID_INPUT']);
  }
  assert.equal((await call('/reminders', { authorization: 'Bearer player-1' })).status, 405);
  assert.equal((await call('/reminders', { body: { reminder: reminder(past) } })).status, 401);
  assert.equal(
    (await call('/reminders/cancel', { authorization: 'Bearer nobody', body: { key: 'k' } })).status,
    401,
  );
  for (const body of [{ reminder: [] }, { reminder: { key: 1 } }, { reminder: null }]) {
    assert.equal(
      (await call('/reminders', { authorization: 'Bearer player-1', body })).status,
      400,
    );
  }
  assert.equal(
    (await call('/reminders/cancel', { authorization: 'Bearer player-1', body: { key: 5 } })).status,
    400,
  );
  assert.deepEqual(
    (await call('/reminders/cancel', { authorization: 'Bearer player-1', body: { key: 'rematch' } })).body,
    { cancelled: true },
  );
  assert.deepEqual(
    (await call('/reminders/cancel', { authorization: 'Bearer player-1', body: { key: 'rematch' } })).body,
    { cancelled: false },
  );
  assert.equal(
    (await call('/reminders/cancel', { authorization: 'Bearer player-1', body: {} })).status,
    400,
  );
  await call('/reminders', {
    authorization: 'Bearer player-1',
    body: { reminder: reminder(past) },
  });
  const sentBeforeCron = sends.length;
  await runScheduledNotifications(env);
  assert.deepEqual(
    sends.slice(sentBeforeCron).map((send) => send.token),
    ['tok-a', 'tok-b'],
  );
  assert.ok(sends.at(-1)?.body.includes('Jun님이 도전했어요.'));
  await runScheduledNotifications(env);
  assert.equal(sends.length, sentBeforeCron + 2, 'a fired reminder is sent once');

  // One cron run drains more than one batch: three reminders with a batch of one.
  {
    const batched = {
      ...env,
      MPGD_NOTIFICATIONS_DUE_BATCH: '1',
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '20',
    };
    const batchedFetch = createWorkerFetchHandler(batched);
    const post = (path: string, body: unknown) =>
      batchedFetch(
        new Request(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    await post('/endpoints', { registration: registration('tok-batch'), target: 'android' });
    for (const key of ['b-1', 'b-2', 'b-3']) {
      await post('/reminders', { reminder: { ...reminder(past), key } });
    }
    const before = sends.length;
    await runScheduledNotifications(batched);
    assert.equal(sends.length - before, 3, 'three batches in one cron run');
  }

  // A wall budget longer than the cron period is rejected; a longer period accepts it.
  {
    assert.equal(notificationCronPeriodSeconds('* * * * *'), 60);
    assert.equal(notificationCronPeriodSeconds('*/5 * * * *'), 300);
    assert.equal(notificationCronPeriodSeconds('0 * * * *'), 3600);
    const over = {
      ...env,
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '120',
    };
    const post = (path: string, body: unknown) =>
      createWorkerFetchHandler(over)(
        new Request(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    await post('/endpoints', { registration: registration('tok-over'), target: 'android' });
    await post('/reminders', { reminder: { ...reminder(past), key: 'over-budget' } });
    const before = sends.length;
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await runScheduledNotifications(over, { cron: '* * * * *' });
    } finally {
      console.error = realError;
    }
    assert.equal(
      sends.length,
      before,
      'a budget longer than the minute cron does not run the scheduler',
    );
    assert.ok(
      errors.some((args) => String(args[0]).includes('not shorter than the cron period')),
      errors.map((args) => String(args[0])).join('\n'),
    );
    await runScheduledNotifications(over, { cron: '*/5 * * * *' });
    assert.equal(sends.length - before, 1, 'the same budget fits a five-minute cron');
  }

  // The subrequest budget stops a full-batch loop before the next round, then a later run finishes.
  {
    const settings = { budget: '1' };
    const tight = {
      ...env,
      MPGD_NOTIFICATIONS_DUE_BATCH: '1',
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '20',
      get MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET() {
        return settings.budget;
      },
    };
    const post = (path: string, body: unknown) =>
      createWorkerFetchHandler(tight)(
        new Request(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    await post('/endpoints', { registration: registration('tok-tight'), target: 'android' });
    for (const key of ['t-1', 't-2', 't-3']) {
      await post('/reminders', { reminder: { ...reminder(past), key } });
    }
    const before = sends.length;
    await runScheduledNotifications(tight, { cron: '* * * * *' });
    assert.ok(sends.length - before < 3, `tight run sent ${sends.length - before}`);
    assert.ok(
      notificationCronOperationsUsed(tight) <= 1,
      String(notificationCronOperationsUsed(tight)),
    );
    settings.budget = '1000';
    await runScheduledNotifications(tight, { cron: '* * * * *' });
    assert.equal(sends.length - before, 3, 'the backlog drains once the budget allows');
  }

  // A wall budget equal to the cron period still overlaps the next trigger.
  {
    assert.equal(notificationCronPeriodSeconds('5/15 * * * *'), 15 * 60);
    assert.equal(notificationCronPeriodSeconds('0/15 * * * *'), 15 * 60);
    assert.equal(notificationCronPeriodSeconds('5-59/15 * * * *'), 15 * 60);
    const equal = {
      ...env,
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '60',
    };
    const post = (path: string, body: unknown) =>
      createWorkerFetchHandler(equal)(
        new Request(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    await post('/endpoints', { registration: registration('tok-equal'), target: 'android' });
    await post('/reminders', { reminder: { ...reminder(past), key: 'equal-budget' } });
    const before = sends.length;
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await runScheduledNotifications(equal, { cron: '* * * * *' });
    } finally {
      console.error = realError;
    }
    assert.equal(
      sends.length,
      before,
      'a 60s budget on a one-minute cron does not run the scheduler',
    );
    assert.ok(
      errors.some((args) => String(args[0]).includes('not shorter than the cron period')),
      errors.map((args) => String(args[0])).join('\n'),
    );
    const stepped = {
      ...env,
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '1200',
    };
    const postStepped = (path: string, body: unknown) =>
      createWorkerFetchHandler(stepped)(
        new Request(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    await postStepped('/endpoints', { registration: registration('tok-step'), target: 'android' });
    await postStepped('/reminders', { reminder: { ...reminder(past), key: 'stepped-cron' } });
    const beforeStep = sends.length;
    await runScheduledNotifications(stepped, { cron: '5/15 * * * *' });
    assert.equal(
      sends.length,
      beforeStep,
      'a 20-minute budget does not fit a cron that fires every 15 minutes',
    );
  }

  // Purge is counted before the first round, so a budget that cannot cover that round leaves the item untouched.
  {
    const tightRound = {
      ...env,
      MPGD_NOTIFICATIONS_DUE_BATCH: '1',
      MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET: '12',
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '20',
    };
    const post = (path: string, body: unknown) =>
      createWorkerFetchHandler(tightRound)(
        new Request(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    await post('/endpoints', { registration: registration('tok-reserve'), target: 'android' });
    await post('/reminders', { reminder: { ...reminder(past), key: 'reserve' } });
    const before = sends.length;
    await runScheduledNotifications(tightRound, { cron: '* * * * *' });
    assert.equal(
      sends.length,
      before,
      'the scheduler does not start a round purge already made unaffordable',
    );
  }

  // A cold FCM 401 retry is four fetches, and each one is counted.
  {
    const postOn = async (
      target: GameServicesWorkerEnv,
      key: string,
      token: string,
    ) => {
      const fetchTarget = createWorkerFetchHandler(target);
      const post = (path: string, body: unknown) =>
        fetchTarget(
          new Request(`${base}${path}`, {
            method: 'POST',
            headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      await post('/endpoints', { registration: registration(token), target: 'android' });
      await post('/reminders', { reminder: { ...reminder(past), key } });
    };
    // Two deployments: the same configuration would share one service and memory store.
    const warm = {
      ...env,
      MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET: '1000',
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '20',
      MPGD_TEST_DEPLOYMENT: 'warm',
    };
    const cold = {
      ...env,
      MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET: '1000',
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '20',
      MPGD_TEST_DEPLOYMENT: 'cold',
    };
    await postOn(warm, 'warm-fcm', 'tok-warm');
    await postOn(cold, 'cold-fcm', 'tok-cold');
    countGoogleFetches = true;
    googleFetchCount = 0;
    try {
      await runScheduledNotifications(warm, { cron: '*/5 * * * *' });
      const warmFetches = googleFetchCount;
      const warmUsed = notificationCronOperationsUsed(warm);
      googleFetchCount = 0;
      unauthorizedSendsLeft = 1;
      await runScheduledNotifications(cold, { cron: '*/5 * * * *' });
      const coldFetches = googleFetchCount;
      const coldUsed = notificationCronOperationsUsed(cold);
      assert.equal(warmFetches, 2, 'a cached-miss send is a token grant and one messages:send');
      assert.equal(coldFetches, 4, 'a bare 401 retries the token grant and the send');
      assert.ok(
        coldUsed - warmUsed >= coldFetches - warmFetches,
        `warm used ${warmUsed} (${warmFetches} fetches), cold used ${coldUsed} (${coldFetches} fetches)`,
      );
    } finally {
      countGoogleFetches = false;
      unauthorizedSendsLeft = 0;
      googleFetchCount = 0;
    }
  }

  // A client route on the same env is not charged to a cron that is awaiting provider I/O.
  {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      noteGoogleFetchEntered = resolve;
    });
    holdGoogleFetch = new Promise((resolve) => {
      release = resolve;
    });
    const shared = {
      ...env,
      MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET: '40',
      MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS: '20',
    };
    const sharedFetch = createWorkerFetchHandler(shared);
    await sharedFetch(
      new Request(`${base}/endpoints`, {
        method: 'POST',
        headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
        body: JSON.stringify({ registration: registration('tok-shared'), target: 'android' }),
      }),
    );
    await sharedFetch(
      new Request(`${base}/reminders`, {
        method: 'POST',
        headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
        body: JSON.stringify({ reminder: { ...reminder(past), key: 'shared-budget' } }),
      }),
    );
    const running = runScheduledNotifications(shared, { cron: '* * * * *' });
    try {
      await Promise.race([
        entered,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('cron did not reach the FCM token fetch')), 5_000);
        }),
      ]);
      const statuses: number[] = [];
      for (let index = 0; index < 80; index += 1) {
        const response = await sharedFetch(
          new Request(`${base}/consent`, { headers: { authorization: 'Bearer player-1' } }),
        );
        statuses.push(response.status);
      }
      assert.ok(
        statuses.every((status) => status === 200),
        statuses.join(','),
      );
    } finally {
      release();
      holdGoogleFetch = undefined;
      noteGoogleFetchEntered = undefined;
      await running;
    }
  }

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
  const migration = (await Promise.all(
    ['0007_notifications.sql', '0008_notification_scheduler.sql'].map((file) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')),
  )).join('\n');
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
      throw new TypeError('fetch failed for tok-q');
    }
    return googleFetch(input, init);
  }) as typeof fetch;
  const dropLogs: string[] = [];
  const errorBefore = console.error;
  console.error = (...parts: unknown[]) => {
    dropLogs.push(parts.map(String).join(' '));
  };
  try {
    await consumeNotificationDispatchBatch(
      queueEnv,
      batch([{ body: queued[0] }, { body: { nope: true } }]),
    );
  } finally {
    console.error = errorBefore;
  }
  globalThis.fetch = googleFetch;
  // A dropped provider call is an ambiguous answer, not a report: nothing quotes the token.
  assert.ok(!dropLogs.some((line) => line.includes('tok-q')), dropLogs.join('\n'));
  // A provider's own failure is logged by name only; a store's with its cause.
  const leaky = new TypeError('fetch failed for tok-q');
  assert.equal(
    notificationFailureCause(leaky, { operation: 'provider.send', fromProvider: true }),
    'TypeError',
  );
  assert.equal(
    notificationFailureCause(leaky, { operation: 'provider.other', fromProvider: true }),
    'TypeError',
  );
  assert.equal(notificationFailureCause(leaky, { operation: 'provider.send' }), 'TypeError');
  assert.equal(
    notificationFailureCause(new Error('D1 is unavailable.'), { operation: 'dispatch' }),
    'Error: D1 is unavailable.',
  );
  assert.equal(
    notificationFailureCause(new Error('no such table: notification_schedule'), {
      operation: 'scheduler.list',
    }),
    'Error: no such table: notification_schedule',
  );
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
  // A misconfigured Worker (a bad deploy) retries every job with the capped backoff and sends nothing.
  const sentBefore = sends.length;
  await consumeNotificationDispatchBatch(
    { ...queueEnv, MPGD_NOTIFICATIONS_CATALOG: { version: 'x' } } satisfies GameServicesWorkerEnv,
    batch([
      { body: queued[1], attempts: 3 },
      { body: queued[0], attempts: 9 },
    ]),
  );
  assert.deepEqual(acks.splice(0), [
    ['retry', { delaySeconds: 40 }],
    ['retry', { delaySeconds: 300 }],
  ]);
  assert.equal(sends.length, sentBefore);
  // A Worker without a catalog has notifications off and acknowledges.
  const { MPGD_NOTIFICATIONS_CATALOG: _catalog, ...withoutCatalog } = queueEnv;
  await consumeNotificationDispatchBatch(withoutCatalog, batch([{ body: queued[1] }]));
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
  const jobsBefore = queued.length;
  await runScheduledNotifications(
    { ...queueEnv, DB: brokenDb(db, /^\s*DELETE/u) } satisfies GameServicesWorkerEnv,
  );
  // With a queue bound, the cron takes the due row for the queue; the consumer sends it.
  assert.deepEqual(queued.slice(jobsBefore), [
    { sendKey: 'worker-queued', provider: 'fcm', rowKey: 'worker-queued:install-1' },
  ]);
  await consumeNotificationDispatchBatch(queueEnv, batch([{ body: queued.at(-1) }]));
  assert.deepEqual(acks.splice(0), ['ack']);
  assert.deepEqual(await deliverWorkerNotification(queueEnv, queuedSend), {
    status: 'delivered',
    alreadyProcessed: true,
  });
  // A server reminder over D1 with the queue: the cron fires it, takes its row for the queue, and the consumer sends it.
  const remindAt = new Date(Date.now() - 60_000).toISOString();
  const reminderSet = await queueFetch(
    new Request(`${base}/reminders`, {
      method: 'POST',
      headers: { authorization: 'Bearer player-1', 'content-type': 'application/json' },
      body: JSON.stringify({
        reminder: {
          key: 'd1-rematch',
          topic: 'friend-challenge',
          fireAt: remindAt,
          templateData: { name: 'D1' },
        },
      }),
    }),
  );
  assert.deepEqual(await reminderSet.json(), { status: 'scheduled' });
  const beforeReminder = { jobs: queued.length, sends: sends.length };
  await runScheduledNotifications(queueEnv);
  assert.equal(sends.length, beforeReminder.sends, 'nothing is sent inline with a queue bound');
  const reminderJobs = queued.slice(beforeReminder.jobs);
  assert.equal(reminderJobs.length, 1);
  assert.match(reminderJobs[0]?.sendKey ?? '', /^reminder:p-1:d1-rematch:/u);
  await consumeNotificationDispatchBatch(queueEnv, batch([{ body: reminderJobs[0] }]));
  assert.deepEqual(acks.splice(0), ['ack']);
  assert.equal(sends.length, beforeReminder.sends + 1);
  assert.ok(sends.at(-1)?.body.includes('D1님이 도전했어요.'));
  // A schedule table that cannot be read is logged, and the due rows still go out.
  const errorsLogged: string[] = [];
  const realError = console.error;
  console.error = (...parts: unknown[]) => {
    errorsLogged.push(parts.map(String).join(' '));
  };
  // A due row waits too: a queued send whose lease is moved into the past.
  await deliverWorkerNotification(queueEnv, {
    ...queuedSend,
    idempotencyKey: 'worker-due-while-broken',
  });
  const dueRow = await db.prepare('SELECT send_json FROM notification_sends WHERE send_key = ?')
    .bind('worker-due-while-broken')
    .first<{ readonly send_json: string }>();
  const dueSend = JSON.parse(
    dueRow?.send_json ?? '{}',
  ) as { rows: { state: { leaseUntil?: string } }[] };
  for (const row of dueSend.rows) {
    row.state.leaseUntil = '2026-01-01T00:00:00Z';
  }
  await db.prepare('UPDATE notification_sends SET send_json = ?, due_at_ms = ? WHERE send_key = ?')
    .bind(JSON.stringify(dueSend), Date.parse('2026-01-01T00:00:00Z'), 'worker-due-while-broken')
    .run();
  const jobsBeforeBroken = queued.length;
  try {
    await runScheduledNotifications(
      { ...queueEnv, DB: brokenDb(db, /notification_schedule/u) } satisfies GameServicesWorkerEnv,
    );
  } finally {
    console.error = realError;
  }
  assert.deepEqual(
    queued.slice(jobsBeforeBroken).map((job) => job.sendKey),
    ['worker-due-while-broken'],
    'the due row still goes out',
  );
  assert.ok(
    errorsLogged.some(
      (line) => line.includes('scheduler.list') && line.includes('D1 is unavailable'),
    ),
    errorsLogged.join('\n'),
  );

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
  // Without the session binding, only the public registry is served, and the Worker says why once.
  const { GAME_SERVICES_NOTIFICATIONS_AUTH: _auth, ...unauthenticated } = env;
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...parts: unknown[]) => {
    warnings.push(parts.map(String).join(' '));
  };
  try {
    assert.equal(
      (await createWorkerFetchHandler(unauthenticated)(new Request(`${base}/consent`, { headers: { authorization: 'Bearer player-1' } }))).status,
      404,
    );
    assert.equal(
      (await createWorkerFetchHandler(unauthenticated)(new Request(`${base}/reminders`, {
        method: 'POST',
        headers: { authorization: 'Bearer player-1' },
        body: '{}',
      }))).status,
      404,
    );
    assert.equal(
      (await createWorkerFetchHandler(unauthenticated)(new Request(`${base}/providers`))).status,
      200,
    );
    // A Worker with the binding, or without a catalog, says nothing about it, and neither do
    // the public registry, the cron, or a server send on a Worker without it.
    await createWorkerFetchHandler({ ...env })(
      new Request(`${base}/consent`, { headers: { authorization: 'Bearer player-1' } }),
    );
    const sendOnly = { ...unauthenticated };
    await createWorkerFetchHandler(sendOnly)(new Request(`${base}/providers`));
    await runScheduledNotifications(sendOnly);
    await deliverWorkerNotification(sendOnly, {
      idempotencyKey: 'send-only-1',
      player: 'p-none',
      topic: 'friend-challenge',
    });
    const { MPGD_NOTIFICATIONS_CATALOG: _off, ...disabled } = unauthenticated;
    await createWorkerFetchHandler(disabled)(new Request(`${base}/providers`));
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(
    warnings.filter((line) => line.includes('GAME_SERVICES_NOTIFICATIONS_AUTH')),
    [
      'Notifications: MPGD_NOTIFICATIONS_CATALOG is set but the GAME_SERVICES_NOTIFICATIONS_AUTH binding is not; '
        + 'the client session routes (consent, endpoints, notices, reminders) are off and answer 404. '
        + 'A send-only Worker can ignore this.',
    ],
  );
  // Local development sessions: the flag stands in for the session binding, on the memory store only.
  {
    const devEnv = {
      ...unauthenticated,
      MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS: 'true',
    } satisfies GameServicesWorkerEnv;
    const devFetch = createWorkerFetchHandler(devEnv);
    const devWarnings: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => {
      devWarnings.push(parts.map(String).join(' '));
    };
    // Development sessions only apply on a local development host.
    const devBase = 'http://localhost:8787/game-services/notifications';
    try {
      const devCall = async (authorization: string) =>
        (await devFetch(new Request(`${devBase}/consent`, { headers: { authorization } }))).status;
      // A well-formed header is a session: its consent records read back empty.
      const accepted = await devFetch(
        new Request(`${devBase}/consent`, {
          headers: { authorization: 'Bearer mpgd-dev.p-dev.s-dev.i-dev' },
        }),
      );
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), { records: [] });
      // Anything else is no session: 401, never another player's.
      for (const malformed of [
        'Bearer mpgd-dev.p-dev.s-dev',
        'Bearer mpgd-dev.p-dev.s-dev.i-dev.x',
        'Bearer mpgd-dev..s-dev.i-dev',
        'Bearer mpgd-dev.p dev.s-dev.i-dev',
        `Bearer mpgd-dev.${'p'.repeat(65)}.s-dev.i-dev`,
        'bearer mpgd-dev.p-dev.s-dev.i-dev',
        'Bearer player-1',
      ]) {
        assert.equal(await devCall(malformed), 401, malformed);
      }
      assert.equal((await devFetch(new Request(`${devBase}/consent`))).status, 401);
      // One warning that sessions are not authenticated, however many requests.
      assert.deepEqual(
        devWarnings.filter((line) => line.includes('MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS')),
        [
          'Notifications: MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS is on, so the session routes '
            + 'accept mpgd-dev bearer headers that anyone can write: sessions are not authenticated. '
            + 'Local development only.',
        ],
      );
      // The local development hosts: loopback, *.localhost, and the Android emulator's alias.
      const devHeader = { authorization: 'Bearer mpgd-dev.p-dev.s-dev.i-dev' };
      for (const origin of [
        'http://localhost:8787',
        'http://127.0.0.1:8787',
        'http://[::1]:8787',
        'http://game.localhost',
        'http://10.0.2.2:8787',
      ]) {
        const response = await devFetch(
          new Request(`${origin}/game-services/notifications/consent`, { headers: devHeader }),
        );
        assert.equal(response.status, 200, origin);
      }
      // Any other host (a deployment on the memory store with the flag left on) takes no
      // development session: 401, as for any header it does not recognize, logged once.
      devWarnings.length = 0;
      for (const origin of [
        'https://game-services-worker.test',
        'https://mpgd-game-services.example.workers.dev',
        'http://192.168.1.10:8787',
        'http://10.0.2.3:8787',
        'http://localhost.example.com',
        'http://127.0.0.2:8787',
      ]) {
        const response = await devFetch(
          new Request(`${origin}/game-services/notifications/consent`, { headers: devHeader }),
        );
        assert.equal(response.status, 401, origin);
        assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
      }
      assert.equal(
        (await devFetch(new Request('https://game-services-worker.test/game-services/notifications/endpoints', {
          method: 'POST',
          headers: { ...devHeader, 'content-type': 'application/json' },
          body: JSON.stringify({
            registration: { provider: 'fcm', address: { kind: 'fcm-token', value: 'tok-remote', permission: 'granted' } },
            target: 'android',
          }),
        }))).status,
        401,
      );
      assert.deepEqual(devWarnings, [
        'Notifications: a development session request to game-services-worker.test was refused; '
          + 'MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS only applies on localhost, 127.0.0.1, '
          + '[::1], *.localhost, or 10.0.2.2 (the Android emulator).',
      ]);
      // The public registry is still served on any host.
      assert.equal(
        (await devFetch(new Request('https://game-services-worker.test/game-services/notifications/providers'))).status,
        200,
      );
      // With the real binding bound the flag is ignored: a development header is not a session.
      devWarnings.length = 0;
      const boundEnv = {
        ...env,
        MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS: 'true',
      } satisfies GameServicesWorkerEnv;
      const bound = createWorkerFetchHandler(boundEnv);
      assert.equal(
        (await bound(new Request(`${base}/consent`, { headers: { authorization: 'Bearer mpgd-dev.p-dev.s-dev.i-dev' } })))
          .status,
        401,
      );
      assert.equal(
        (await bound(new Request(`${base}/consent`, { headers: { authorization: 'Bearer player-1' } }))).status,
        200,
      );
      assert.deepEqual(
        devWarnings.filter((line) => line.includes('MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS')),
        [
          'Notifications: MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS is ignored because '
            + 'GAME_SERVICES_NOTIFICATIONS_AUTH is bound.',
        ],
      );
    } finally {
      console.warn = warn;
    }
    // A runtime that hands the Worker a new env object per request (the Cloudflare Vite
    // plugin's dev server) keeps one memory store and one set of logs per configuration:
    // the consent the first request records, the second reads.
    {
      const perRequestEnv = () => ({
        ...unauthenticated,
        // Equal by value, not the same objects, as a runtime parses JSON vars again.
        MPGD_NOTIFICATIONS_CATALOG: structuredClone(catalog),
        MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS: 'true',
        MPGD_DEV_REQUEST_TEST: 'per-request',
      }) as GameServicesWorkerEnv;
      const logged: string[] = [];
      const realWarn = console.warn;
      console.warn = (...parts: unknown[]) => {
        logged.push(parts.map(String).join(' '));
      };
      try {
        const header = { authorization: 'Bearer mpgd-dev.p-req.s-req.i-req' };
        const first = perRequestEnv();
        const recorded = await createWorkerFetchHandler(first)(
          new Request('http://localhost:8787/game-services/notifications/consent', {
            method: 'POST',
            headers: { ...header, 'content-type': 'application/json' },
            body: JSON.stringify({
              record: {
                kind: 'topic-preference',
                topic: 'friend-challenge',
                state: 'granted',
                source: 'player',
              },
            }),
          }),
        );
        assert.equal(recorded.status, 200);
        const second = perRequestEnv();
        assert.notEqual(second, first);
        const read = await createWorkerFetchHandler(second)(
          new Request('http://localhost:8787/game-services/notifications/consent', {
            headers: header,
          }),
        );
        assert.equal(read.status, 200);
        const { records } = await read.json() as { readonly records: readonly { readonly topic?: string }[] };
        assert.deepEqual(
          records.map((record) => record.topic),
          ['friend-challenge'],
        );
        // One memory-store warning and one development-session warning, not one per request.
        assert.equal(
          logged.filter((line) => line.includes('Notifications use the memory store')).length,
          1,
        );
        assert.equal(
          logged.filter((line) => line.includes('sessions are not authenticated')).length,
          1,
        );
        // Another configuration keeps its own store.
        const other = await createWorkerFetchHandler({ ...perRequestEnv(), MPGD_DEV_REQUEST_TEST: 'other' } as GameServicesWorkerEnv)(
          new Request('http://localhost:8787/game-services/notifications/consent', {
            headers: header,
          }),
        );
        assert.deepEqual(await other.json(), { records: [] });
        // Values that read alike are different configurations: an array of pairs and an object,
        // undefined and null, and a class instance (by identity) and an empty object.
        const readsEmpty = async (marker: unknown) => {
          const response = await createWorkerFetchHandler(
            { ...perRequestEnv(), MPGD_DEV_REQUEST_TEST: marker } as GameServicesWorkerEnv,
          )(new Request('http://localhost:8787/game-services/notifications/consent', { headers: header }));
          return ((await response.json()) as { readonly records: readonly unknown[] }).records.length === 0;
        };
        const recordOn = async (marker: unknown) => {
          const response = await createWorkerFetchHandler(
            { ...perRequestEnv(), MPGD_DEV_REQUEST_TEST: marker } as GameServicesWorkerEnv,
          )(
            new Request('http://localhost:8787/game-services/notifications/consent', {
              method: 'POST',
              headers: { ...header, 'content-type': 'application/json' },
              body: JSON.stringify({
                record: { kind: 'topic-preference', topic: 'friend-challenge', state: 'granted', source: 'player' },
              }),
            }),
          );
          assert.equal(response.status, 200);
        };
        await recordOn({ a: 1 });
        assert.equal(await readsEmpty({ a: 1 }), false);
        assert.equal(await readsEmpty([['a', 1]]), true);
        await recordOn(null);
        assert.equal(await readsEmpty(undefined), true);
        await recordOn({});
        assert.equal(await readsEmpty(new Map()), true);
        // An env that cannot be read as data keeps its state per env object, and still serves.
        const unreadable = perRequestEnv();
        Object.defineProperty(unreadable, 'MPGD_DEV_REQUEST_TEST', {
          enumerable: true,
          get() {
            throw new Error('unreadable');
          },
        });
        const served = await createWorkerFetchHandler(unreadable)(
          new Request('http://localhost:8787/game-services/notifications/consent', {
            headers: header,
          }),
        );
        assert.equal(served.status, 200);
      } finally {
        console.warn = realWarn;
      }
    }
    // Only the fetch routes read a session, development or not: the service binding
    // (deliverNotification, endNotificationSession), the queue consumer, and the cron take no
    // Authorization, so a development session can never authenticate them.
    {
      const source = await readFile(new URL('./notificationsHandler.ts', import.meta.url), 'utf8');
      // The declaration and its two calls: createNotificationsFetchHandler, and
      // authenticateNotificationPlayer, which only the account deletion fetch
      // route (handler.ts) calls.
      assert.equal(source.match(/\bnotificationSessionAuthOf\(/gu)?.length, 3);
      const playerStart = source.indexOf('export async function authenticateNotificationPlayer');
      assert.match(
        source.slice(playerStart, source.indexOf('\nexport ', playerStart + 1)),
        /notificationSessionAuthOf\(env\)[\s\S]*isLocalDevelopmentHost/u,
      );
      const handlerSource = await readFile(new URL('./handler.ts', import.meta.url), 'utf8');
      assert.equal(handlerSource.match(/\bauthenticateNotificationPlayer\(/gu)?.length, 1);
      const deletionStart = handlerSource.indexOf(
        'async function authenticateAccountDeletionRequest',
      );
      assert.match(
        handlerSource.slice(deletionStart, handlerSource.indexOf('\n}\n', deletionStart)),
        /authenticateNotificationPlayer\(env, request\)/u,
      );
      assert.equal(source.match(/\bdevelopmentNotificationSessionAuth\b/gu)?.length, 2);
      const fetchStart = source.indexOf('export function createNotificationsFetchHandler');
      assert.match(
        source.slice(fetchStart, source.indexOf('\nexport ', fetchStart + 1)),
        /notificationSessionAuthOf\(env\)/u,
      );
      for (const entry of [
        'deliverWorkerNotification',
        'endWorkerNotificationSession',
        'consumeNotificationDispatchBatch',
        'runScheduledNotifications',
      ]) {
        const start = source.indexOf(`export async function ${entry}`);
        assert.ok(start >= 0, entry);
        assert.doesNotMatch(
          source.slice(start, source.indexOf('\nexport ', start + 1)),
          /authorization|authenticate|notificationSessionAuthOf|developmentNotificationSessionAuth|GAME_SERVICES_NOTIFICATIONS_AUTH/iu,
          entry,
        );
      }
      const entrypoint = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
      assert.doesNotMatch(entrypoint, /authorization|mpgd-dev|notificationSessionAuthOf/iu);
      // No other Worker module reads a development header.
      const modules = (await readdir(new URL('./', import.meta.url))).filter(
        (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'notificationsHandler.ts',
      );
      assert.ok(modules.includes('index.ts') && modules.includes('handler.ts'));
      for (const file of modules) {
        const other = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
        assert.doesNotMatch(
          other,
          /parseDevelopmentNotificationSessionAuthorization|mpgd-dev/u,
          file,
        );
      }
    }
    // Never with the durable store: the Worker refuses to start, with or without the binding.
    const durable = {
      MPGD_STORE: 'd1',
      DB: {} as D1Database,
      MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS: 'true',
    } satisfies GameServicesWorkerEnv;
    for (const refused of [durable, { ...durable, GAME_SERVICES_NOTIFICATIONS_AUTH: auth }]) {
      assert.throws(
        () => createWorkerFetchHandler(refused),
        /MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS=true is refused when MPGD_STORE is d1/,
      );
      assert.throws(() => createWorkerService(refused), /refused when MPGD_STORE is d1/);
    }
    // The notification entry points that do not go through fetch refuse it too: the
    // service-binding RPCs answer a configuration error, the queue retries, the cron skips,
    // and the reason is logged once.
    {
      const durableNotifications = {
        ...durable,
        MPGD_NOTIFICATIONS_CATALOG: catalog,
        FCM_SERVICE_ACCOUNT: serviceAccount,
      } satisfies GameServicesWorkerEnv;
      const logged: string[] = [];
      const realError = console.error;
      console.error = (...parts: unknown[]) => {
        logged.push(parts.map(String).join(' '));
      };
      try {
        await assert.rejects(
          deliverWorkerNotification(durableNotifications, {
            idempotencyKey: 'durable-dev-1',
            player: 'p-1',
            topic: 'friend-challenge',
          }),
          { code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' },
        );
        const rpc = await asWorkerNotificationRpcResult(() =>
          deliverWorkerNotification(durableNotifications, {
            idempotencyKey: 'durable-dev-2',
            player: 'p-1',
            topic: 'friend-challenge',
          }),
        );
        assert.equal(rpc.ok, false);
        await assert.rejects(
          endWorkerNotificationSession(durableNotifications, { sessionId: 's-1' }),
          { code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' },
        );
        const settled: unknown[] = [];
        await consumeNotificationDispatchBatch(durableNotifications, {
          messages: [{
            body: {},
            attempts: 1,
            ack: () => settled.push('ack'),
            retry: (options: unknown) => settled.push(['retry', options]),
          }],
        } as unknown as MessageBatch<unknown>);
        assert.deepEqual(settled, [['retry', { delaySeconds: 10 }]]);
        // The cron does nothing: the DB stub would throw on any call.
        await runScheduledNotifications(durableNotifications);
      } finally {
        console.error = realError;
      }
      assert.equal(
        logged.filter((line) =>
          line.includes('MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS=true is refused when MPGD_STORE is d1'),
        ).length,
        1,
      );
    }
    // The refusal comes first, so another refused setting does not hide it.
    assert.throws(
      () =>
        createWorkerFetchHandler({ ...durable, MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE: 'true' }),
      /MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS=true is refused/,
    );
    // A value other than "true" is off.
    const offEnv = {
      ...unauthenticated,
      MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS: 'yes' as 'true',
    };
    const realWarn2 = console.warn;
    console.warn = () => undefined;
    try {
      assert.equal(
        (await createWorkerFetchHandler(offEnv)(
          new Request(`${base}/consent`, { headers: { authorization: 'Bearer mpgd-dev.p-dev.s-dev.i-dev' } }),
        )).status,
        404,
      );
    } finally {
      console.warn = realWarn2;
    }
  }
  // The Apps in Toss provider serves `ait` behind its mTLS binding and the identity resolver.
  const partnerCalls: { readonly url: string; readonly headers: Headers; readonly body: string }[] = [];
  const aitEnv = {
    MPGD_STORE: 'memory',
    MPGD_NOTIFICATIONS_CATALOG: {
      version: '2026-10-19',
      defaultLocale: 'ko',
      topics: [
        {
          id: 'energy-full',
          purpose: 'service',
          channels: ['remote'],
          route: '/?entry=energy',
          copy: { ko: { title: '에너지', body: '에너지가 가득 찼어요.' } },
          targets: { ait: { templateSetCode: 'my-game-energy-full', agreement: 'none' } },
        },
      ],
    },
    MPGD_AIT_NOTIFICATIONS: JSON.stringify({ recipientKey: 'toss-user' }),
    AIT_PARTNER_MTLS: {
      async fetch(input: string, init?: RequestInit) {
        partnerCalls.push({
          url: input,
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return Response.json({
          resultType: 'SUCCESS',
          success: {
            msgCount: 1,
            sentPushCount: 1,
            sentInboxCount: 0,
            sentSmsCount: 0,
            sentAlimtalkCount: 0,
            sentFriendtalkCount: 0,
            detail: {
              sentPush: [{ contentId: 'c-1' }],
              sentInbox: [],
              sentSms: [],
              sentAlimtalk: [],
              sentFriendtalk: [],
            },
            fail: { sentPush: [], sentInbox: [], sentSms: [], sentAlimtalk: [], sentFriendtalk: [] },
          },
        });
      },
    },
    GAME_SERVICES_NOTIFICATIONS_IDENTITY: {
      async resolveNotificationRecipient({ provider, playerId }: { readonly provider: string; readonly playerId: string }) {
        return provider === 'apps-in-toss' && playerId === 'p-ait' ? 'toss-user-1' : null;
      },
    },
  } satisfies GameServicesWorkerEnv;
  const aitProviders = await createWorkerFetchHandler(aitEnv)(new Request(`${base}/providers`));
  assert.equal(aitProviders.status, 200);
  assert.deepEqual(((await aitProviders.json()) as { readonly targets: unknown }).targets, {
    ait: 'apps-in-toss',
  });
  assert.deepEqual(
    await deliverWorkerNotification(aitEnv, { idempotencyKey: 'ait-1', player: 'p-ait', topic: 'energy-full' }),
    { status: 'delivered', alreadyProcessed: false },
  );
  assert.deepEqual(
    partnerCalls.map((call) => [
      call.url,
      call.headers.get('x-toss-user-key'),
      (JSON.parse(call.body) as { readonly templateSetCode?: unknown }).templateSetCode,
    ]),
    [
      [
        'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-message',
        'toss-user-1',
        'my-game-energy-full',
      ],
    ],
  );
  // A player the identity service cannot resolve has no recipient there.
  assert.deepEqual(
    await deliverWorkerNotification(aitEnv, { idempotencyKey: 'ait-2', player: 'p-other', topic: 'energy-full' }),
    { status: 'unavailable', reason: 'no-endpoint' },
  );
  assert.equal(partnerCalls.length, 1);
  // Half a configuration, or no identity resolver, is a misconfigured Worker.
  const { AIT_PARTNER_MTLS: _mtls, ...settingsOnly } = aitEnv;
  const { MPGD_AIT_NOTIFICATIONS: _settings, ...bindingOnly } = aitEnv;
  const { GAME_SERVICES_NOTIFICATIONS_IDENTITY: _identity, ...noIdentity } = aitEnv;
  for (const [broken, reason] of [
    [settingsOnly, /needs both the AIT_PARTNER_MTLS binding and MPGD_AIT_NOTIFICATIONS/u],
    [bindingOnly, /needs both the AIT_PARTNER_MTLS binding and MPGD_AIT_NOTIFICATIONS/u],
    [noIdentity, /needs the GAME_SERVICES_NOTIFICATIONS_IDENTITY binding/u],
    [
      { ...aitEnv, MPGD_AIT_NOTIFICATIONS: { recipientKey: 'phone' } },
      /^MPGD_AIT_NOTIFICATIONS\.recipientKey must be/u,
    ],
    [
      { ...aitEnv, MPGD_AIT_NOTIFICATIONS: { recipientKey: 'toss-user', agreementCodes: ['x'] } },
      /has no field agreementCodes/u,
    ],
    [
      { ...aitEnv, MPGD_AIT_NOTIFICATIONS: { recipientKey: 'toss-user', agreementErrorCodes: [1] } },
      /agreementErrorCodes must be a list of strings/u,
    ],
    [
      { ...aitEnv, MPGD_AIT_NOTIFICATIONS: { recipientKey: 'toss-user', timeoutMs: 0 } },
      /^MPGD_AIT_NOTIFICATIONS: /u,
    ],
    [
      { ...aitEnv, MPGD_AIT_NOTIFICATIONS: { recipientKey: 'toss-user', baseUrl: 'not a url' } },
      /^MPGD_AIT_NOTIFICATIONS: /u,
    ],
    // An agreement reason the provider could never match (empty, or over the
    // 1,024 characters of a reachedFailReason it reads) is refused at startup.
    [
      { ...aitEnv, MPGD_AIT_NOTIFICATIONS: { recipientKey: 'toss-user', agreementFailReasons: ['  '] } },
      /^MPGD_AIT_NOTIFICATIONS: agreementFailReasons\[0\]: entries must be 1 to 1024 characters/u,
    ],
    [
      {
        ...aitEnv,
        MPGD_AIT_NOTIFICATIONS: {
          recipientKey: 'toss-user',
          agreementFailReasons: ['NOT_AGREED', 'x'.repeat(1_025)],
        },
      },
      /^MPGD_AIT_NOTIFICATIONS: agreementFailReasons\[1\]: entries must be 1 to 1024 characters/u,
    ],
    [
      {
        ...aitEnv,
        MPGD_AIT_NOTIFICATIONS: { recipientKey: 'toss-user', baseUrl: 'https://evil.example' },
      },
      /host must be apps-in-toss-api\.toss\.im/u,
    ],
    // The starter's sender placeholder fails closed: the Worker does not start.
    [
      {
        ...aitEnv,
        MPGD_NOTIFICATIONS_DEPLOYMENT: {
          advertisingRules: 'kr',
          advertisingSender: { name: 'Studio', contact: 'REPLACE-WITH-SENDER-PHONE-OR-ADDRESS' },
        },
      },
      /placeholder in advertisingSender\.contact/u,
    ],
  ] as const) {
    const refused = await createWorkerFetchHandler(broken)(new Request(`${base}/providers`));
    assert.equal(refused.status, 500);
    // The body names the configuration, so clients stop retrying it.
    assert.deepEqual(await refused.json(), { error: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    const resolved = resolveWorkerNotifications(broken);
    assert.ok(
      resolved.status === 'misconfigured' && reason.test(resolved.error.message),
      resolved.status,
    );
  }
  // A partner answer named as a missing agreement records the provider's denial.
  const agreementEnv = {
    ...aitEnv,
    MPGD_AIT_NOTIFICATIONS: { recipientKey: 'toss-user', agreementErrorCodes: ['4100'] },
    AIT_PARTNER_MTLS: {
      async fetch() {
        return Response.json({
          resultType: 'FAIL',
          error: { errorCode: '4100', reason: 'not agreed' },
        });
      },
    },
  } satisfies GameServicesWorkerEnv;
  assert.deepEqual(
    await deliverWorkerNotification(agreementEnv, { idempotencyKey: 'ait-3', player: 'p-ait', topic: 'energy-full' }),
    { status: 'unavailable', reason: 'provider-rejected' },
  );
  const agreementService = resolveWorkerNotifications(agreementEnv);
  assert.ok(agreementService.status === 'ready');
  assert.deepEqual(
    (await agreementService.service.listConsent({ player: 'p-ait', sessionId: 's-ait', installationId: 'i-ait' }))
      .map((record) => [record.kind, record.topic, record.state, record.source]),
    [['host-agreement', 'energy-full', 'denied', 'provider']],
  );

  // Bulk sends (BK1): only the service binding serves them, never a client session route.
  for (const path of ['/bulk', '/sends', '/sends/bulk', '/deliver']) {
    const refusedBulk = await call(path, {
      authorization: 'Bearer player-1',
      body: {
        idempotencyKey: 'client-bulk',
        provider: 'fcm',
        topic: 'friend-challenge',
        recipients: [{ player: 'p-1' }],
      },
    });
    assert.deepEqual([path, refusedBulk.status], [path, 404]);
  }
  // Through the binding, the Apps in Toss provider takes 50 or more recipients in one send-bulk-message call.
  const bulkCalls: { readonly url: string; readonly body: string }[] = [];
  const bulkEnv = {
    ...aitEnv,
    MPGD_NOTIFICATIONS_BULK_RECIPIENTS: '55',
    AIT_PARTNER_MTLS: {
      async fetch(input: string, init?: RequestInit) {
        bulkCalls.push({ url: input, body: String(init?.body) });
        const sent = input.endsWith('/send-bulk-message')
          ? (JSON.parse(String(init?.body)) as { readonly contextList: readonly unknown[] }).contextList.length
          : 1;
        return Response.json({
          resultType: 'SUCCESS',
          success: {
            msgCount: sent,
            sentPushCount: sent,
            sentInboxCount: 0,
            sentSmsCount: 0,
            sentAlimtalkCount: 0,
            sentFriendtalkCount: 0,
            detail: {
              sentPush: [],
              sentInbox: [],
              sentSms: [],
              sentAlimtalk: [],
              sentFriendtalk: [],
            },
            fail: { sentPush: [], sentInbox: [], sentSms: [], sentAlimtalk: [], sentFriendtalk: [] },
          },
        });
      },
    },
    GAME_SERVICES_NOTIFICATIONS_IDENTITY: {
      async resolveNotificationRecipient({ playerId }: { readonly provider: string; readonly playerId: string }) {
        return playerId.startsWith('p-bulk-')
          ? String(1_000 + Number(playerId.slice('p-bulk-'.length)))
          : null;
      },
    },
  } satisfies GameServicesWorkerEnv;
  const bulkSend = {
    idempotencyKey: 'event-halloween',
    provider: 'apps-in-toss',
    topic: 'energy-full',
    recipients: Array.from({ length: 60 }, (_, index) => ({ player: `p-bulk-${index + 1}` })),
  };
  // Apps in Toss holds bulk messages from 21:00 to 08:00 in Seoul; from 20:55 the service sends one by one.
  const held = isInsideNotificationHoldWindow(
    { start: '20:55', end: '08:00', timeZone: 'Asia/Seoul' },
    Date.now(),
  );
  const firstBulk = await asWorkerNotificationRpcResult(() =>
    deliverWorkerNotificationBulk(bulkEnv, bulkSend),
  );
  assert.ok(firstBulk.ok);
  assert.deepEqual(firstBulk.value.summary, {
    delivered: 55,
    alreadyProcessed: 0,
    deferred: 0,
    inFlight: 0,
    suppressed: 0,
    unavailable: 0,
    notAttempted: 5,
    failed: 0,
  });
  assert.deepEqual(
    firstBulk.value.providerCalls,
    held ? { batch: 0, single: 55 } : { batch: 1, single: 0 },
  );
  if (!held) {
    assert.equal(bulkCalls.length, 1);
    assert.equal(
      bulkCalls[0]?.url,
      'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-bulk-message',
    );
    const sentBody = JSON.parse(bulkCalls[0]?.body ?? '{}') as {
      readonly templateSetCode: string;
      readonly contextList: readonly { readonly userKey: unknown }[];
    };
    assert.equal(sentBody.templateSetCode, 'my-game-energy-full');
    assert.deepEqual(sentBody.contextList[0], { userKey: 1001, context: {} });
  }
  // The same call again: the 55 answer from the ledger, and the other 5 (under 50) go one by one.
  bulkCalls.length = 0;
  const secondBulk = await asWorkerNotificationRpcResult(() =>
    deliverWorkerNotificationBulk(bulkEnv, bulkSend),
  );
  assert.ok(secondBulk.ok);
  assert.deepEqual(
    [
      secondBulk.value.summary.alreadyProcessed,
      secondBulk.value.summary.delivered,
      secondBulk.value.providerCalls,
    ],
    [55, 5, { batch: 0, single: 5 }],
  );
  assert.ok(bulkCalls.every((partnerCall) => partnerCall.url.endsWith('/send-message')));
  // A malformed bulk send keeps its code across the binding.
  assert.deepEqual(
    await asWorkerNotificationRpcResult(() => deliverWorkerNotificationBulk(bulkEnv, { ...bulkSend, recipients: [] })),
    {
      ok: false,
      error: {
        code: 'NOTIFICATIONS_INVALID_INPUT',
        message: 'Invalid bulk send: recipients: expected 1 to 10000 recipients.',
        retryable: false,
      },
    },
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
