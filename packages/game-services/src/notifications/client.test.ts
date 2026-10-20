import assert from 'node:assert/strict';

import { NotificationError, type NotificationConsentRecord } from '@mpgd/platform/notifications';

import {
  createGameServicesNotificationsClient,
  GameServicesNotificationsRequestError,
  type GameServicesNotificationIdentity,
  type GameServicesNotificationSession,
  type GameServicesNotificationsFetch,
} from './client.js';

/**
 * The client's own contract: the requests it sends for a session, and how it
 * maps the Worker's answers to the codes the runtime acts on. The runtime's
 * scenarios through this client run in `client-conformance.test.ts` and, against
 * the real Worker handler, in the game-services Worker's tests.
 */

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

function identityOf(initial?: GameServicesNotificationSession) {
  let current = initial;
  const listeners = new Set<(session: GameServicesNotificationSession) => void>();
  const identity: GameServicesNotificationIdentity = {
    current: () => current,
    onAuthenticated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    identity,
    signIn(session: GameServicesNotificationSession | undefined) {
      current = session;
      if (session !== undefined) {
        for (const listener of [...listeners]) {
          listener(session);
        }
      }
    },
  };
}

/** A fetch that records each request and answers from `answer`. */
function fakeFetch(answer: (sent: Sent) => { status: number; body?: unknown; text?: string; headers?: Record<string, string> }) {
  const sent: Sent[] = [];
  const fetch: GameServicesNotificationsFetch = async (url, init) => {
    const request: Sent = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
    };
    sent.push(request);
    const reply = answer(request);
    const headers = new Map(
      Object.entries(reply.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    return {
      status: reply.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)),
    };
  };
  return { fetch, sent };
}

const session = { playerId: 'p-1', sessionId: 's-1' };
const record: NotificationConsentRecord = {
  kind: 'topic-preference',
  topic: 'daily-ready',
  state: 'granted',
  source: 'player',
  at: '2026-10-20T01:00:00.000Z',
};

async function rejection(work: Promise<unknown>): Promise<GameServicesNotificationsRequestError> {
  try {
    await work;
  } catch (error) {
    assert.ok(
      error instanceof GameServicesNotificationsRequestError,
      `expected a request error, got ${String(error)}`,
    );
    assert.ok(error instanceof NotificationError);
    return error;
  }
  assert.fail('expected a rejection');
}

// Requests: the session's headers, the route, the body, and never a player or installation.
{
  const { identity } = identityOf(session);
  const { fetch, sent } = fakeFetch((request) => {
    switch (`${request.method} ${new URL(request.url).pathname}`) {
      case 'GET /game-services/notifications/consent':
        return { status: 200, body: { records: [record] } };
      case 'POST /game-services/notifications/consent':
        return { status: 200, body: { record } };
      case 'POST /game-services/notifications/reminders':
        return { status: 200, body: { status: 'scheduled' } };
      case 'POST /game-services/notifications/reminders/cancel':
        return { status: 200, body: { cancelled: true } };
      case 'GET /game-services/notifications/notices':
        return {
          status: 200,
          body: {
            notices: [
              {
                kind: 'consent-result',
                record: {
                  kind: 'advertising',
                  state: 'granted',
                  at: '2026-10-20T01:00:00.000Z',
                  textVersion: '1',
                },
                dueBy: '2026-11-03',
                variant: 'consent-result.advertising.granted',
              },
            ],
          },
        };
      case 'GET /game-services/notifications/providers':
        return {
          status: 200,
          body: {
            protocolVersion: '2.0.0-draft.1',
            providers: [
              {
                provider: 'fcm',
                purposes: ['service', 'requested', 'advertising'],
                addressing: 'device',
                content: 'free-form',
                permission: { scope: 'app', serverReadable: false, allowance: 'persistent' },
                expiry: true,
                actions: true,
                link: false,
                mappingFields: ['channelId'],
              },
            ],
            targets: { android: 'fcm', ios: 'fcm' },
          },
        };
      default:
        return { status: 200, body: {} };
    }
  });
  let resolved = 0;
  const client = createGameServicesNotificationsClient({
    baseUrl: 'https://services.example/',
    identity,
    fetch,
    headers: { 'X-Game': 'demo' },
    getHeaders: () => {
      resolved += 1;
      return { Authorization: 'Bearer token-1' };
    },
    target: 'android',
  });
  assert.deepEqual(client.session(), { id: 's-1', player: 'p-1' });
  assert.deepEqual(await client.listConsent(), [record]);
  await client.recordConsent(record);
  await client.registerEndpoint({
    provider: 'fcm',
    address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
    timeZone: 'Asia/Seoul',
  });
  await client.unregisterEndpoint({ provider: 'fcm', player: 'p-1' });
  assert.equal(
    await client.setReminder({ key: 'energy', topic: 'daily-ready', fireAt: '2026-10-21T00:00:00Z' }),
    'scheduled',
  );
  assert.equal(await client.cancelReminder({ key: 'energy' }), true);
  const listed = await client.listNotices();
  assert.equal(listed.length, 1);
  await client.recordNotice({
    kind: 'consent-result',
    record: { kind: 'advertising', at: '2026-10-20T01:00:00.000Z' },
    dueBy: '2026-11-03',
    channel: 'in-game',
  });
  const providers = await client.getProviders();
  assert.deepEqual(providers.targets, { android: 'fcm', ios: 'fcm' });
  assert.equal(providers.providers[0]?.provider, 'fcm');

  assert.deepEqual(
    sent.map((request) => `${request.method} ${request.url}`),
    [
      'GET https://services.example/game-services/notifications/consent',
      'POST https://services.example/game-services/notifications/consent',
      'POST https://services.example/game-services/notifications/endpoints',
      'POST https://services.example/game-services/notifications/endpoints/unregister',
      'POST https://services.example/game-services/notifications/reminders',
      'POST https://services.example/game-services/notifications/reminders/cancel',
      'GET https://services.example/game-services/notifications/notices',
      'POST https://services.example/game-services/notifications/notices/shown',
      'GET https://services.example/game-services/notifications/providers',
    ],
  );
  assert.deepEqual(
    sent.map((request) => request.body),
    [
      undefined,
      { record },
      {
        registration: {
          provider: 'fcm',
          address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
          timeZone: 'Asia/Seoul',
        },
        target: 'android',
      },
      { provider: 'fcm' },
      { reminder: { key: 'energy', topic: 'daily-ready', fireAt: '2026-10-21T00:00:00Z' } },
      { key: 'energy' },
      undefined,
      {
        notice: {
          kind: 'consent-result',
          record: { kind: 'advertising', at: '2026-10-20T01:00:00.000Z' },
          dueBy: '2026-11-03',
        },
        channel: 'in-game',
      },
      undefined,
    ],
  );
  // Session routes carry the resolver's credentials; the public registry read does not ask for them.
  for (const request of sent.slice(0, -1)) {
    assert.equal(request.headers['authorization'], 'Bearer token-1');
    assert.equal(request.headers['x-game'], 'demo');
  }
  assert.equal(sent.at(-1)?.headers['authorization'], undefined);
  assert.equal(sent.at(-1)?.headers['x-game'], 'demo');
  assert.equal(resolved, sent.length - 1);
  // A body only on POST, always JSON.
  for (const request of sent) {
    assert.equal(
      request.headers['content-type'],
      request.method === 'POST' ? 'application/json' : undefined,
    );
  }
  // No request names a player or an installation: the Worker reads them from the session.
  assert.ok(!JSON.stringify(sent.map((request) => request.body)).includes('p-1'));
  assert.ok(!JSON.stringify(sent.map((request) => request.body)).includes('installation'));
}

// Sessions: none means no request; refreshes are not authentications; another player's unbind is never sent.
{
  const { identity, signIn } = identityOf(undefined);
  const { fetch, sent } = fakeFetch(() => ({ status: 200, body: {} }));
  const client = createGameServicesNotificationsClient({
    baseUrl: 'https://services.example',
    identity,
    fetch,
  });
  assert.equal(client.session(), undefined);
  const refused = await rejection(client.listConsent());
  assert.equal(refused.code, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
  assert.equal(refused.retryable, true);
  assert.equal(refused.status, 0);
  await rejection(client.setReminder({ key: 'k', topic: 't', fireAt: '2026-10-21T00:00:00Z' }));
  // Without a session there is nothing to unbind: the session's end unbound it.
  await client.unregisterEndpoint({ provider: 'fcm', player: 'p-1' });
  assert.equal(sent.length, 0);

  const announced: unknown[] = [];
  const unsubscribe = client.onAuthenticated((started) => announced.push(started));
  // A runtime that subscribes while a session is current does not take it, or its refresh, as a sign-in.
  {
    const { identity: restored, signIn: refresh } = identityOf(session);
    const seen: unknown[] = [];
    createGameServicesNotificationsClient({ baseUrl: 'https://services.example', identity: restored, fetch })
      .onAuthenticated((started) => seen.push(started));
    refresh({ ...session });
    refresh({ playerId: 'p-1', sessionId: 's-9' });
    assert.deepEqual(seen, [{ id: 's-9', player: 'p-1' }]);
  }
  signIn(session);
  signIn({ ...session }); // A token refresh of the same session.
  signIn({ playerId: 'p-2', sessionId: 's-2' }); // An account switch.
  signIn({ playerId: '', sessionId: 's-3' }); // Not a session.
  assert.deepEqual(announced, [
    { id: 's-1', player: 'p-1' },
    { id: 's-2', player: 'p-2' },
  ]);
  unsubscribe();
  signIn({ playerId: 'p-3', sessionId: 's-4' });
  assert.equal(announced.length, 2);

  // The unbind of the player who left is not sent for the player signed in now.
  await client.unregisterEndpoint({ provider: 'fcm', player: 'p-1' });
  assert.equal(sent.length, 0);
}

// Answers: Worker statuses map to the codes the runtime acts on.
{
  const { identity } = identityOf(session);
  const cases: readonly {
    readonly status: number;
    readonly body?: unknown;
    readonly text?: string;
    readonly headers?: Record<string, string>;
    readonly code: string;
    readonly retryable: boolean;
    readonly serverCode?: string;
    readonly retryAfterSeconds?: number;
  }[] = [
    { status: 401, body: { error: 'UNAUTHORIZED' }, code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true, serverCode: 'UNAUTHORIZED' },
    { status: 404, body: { error: 'UNKNOWN_ENDPOINT' }, code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false, serverCode: 'UNKNOWN_ENDPOINT' },
    { status: 405, body: { error: 'METHOD_NOT_ALLOWED' }, code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false },
    { status: 400, body: { error: 'NOTIFICATIONS_INVALID_INPUT', message: 'bad key' }, code: 'NOTIFICATIONS_INVALID_INPUT', retryable: false },
    { status: 400, body: { error: 'BAD_REQUEST' }, code: 'NOTIFICATIONS_INVALID_INPUT', retryable: false },
    { status: 413, body: { error: 'PAYLOAD_TOO_LARGE' }, code: 'NOTIFICATIONS_INVALID_INPUT', retryable: false },
    { status: 409, body: { error: 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT', message: 'k' }, code: 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT', retryable: false },
    {
      status: 429,
      body: { error: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', message: 'Too many consent records today; retry in 30 s.' },
      headers: { 'Retry-After': '30' },
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
      retryAfterSeconds: 30,
    },
    {
      status: 503,
      body: { error: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' },
      headers: { 'Retry-After': '5' },
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
      retryAfterSeconds: 5,
    },
    { status: 500, body: { error: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' }, code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false },
    { status: 500, body: { error: 'INTERNAL_ERROR' }, code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true },
    { status: 502, text: '<html>Bad gateway</html>', code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true },
    { status: 403, text: 'Forbidden', code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false },
    { status: 408, text: 'Request Timeout', code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true },
    { status: 425, text: 'Too Early', code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true },
    {
      status: 503,
      text: 'Unavailable',
      headers: { 'Retry-After': ' 7 ' },
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
      retryAfterSeconds: 7,
    },
    {
      status: 503,
      text: 'Unavailable',
      headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    },
    {
      status: 503,
      text: 'Unavailable',
      headers: { 'Retry-After': '1e3' },
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    },
    // A success that breaks the route's contract is the Worker's fault, never retried.
    { status: 200, text: 'not json', code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false },
    { status: 200, body: { records: 'none' }, code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false },
    { status: 200, body: { records: [{ kind: 'mystery' }] }, code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', retryable: false },
  ];
  for (const expected of cases) {
    const { fetch } = fakeFetch(() => ({
      status: expected.status,
      ...(expected.body === undefined ? {} : { body: expected.body }),
      ...(expected.text === undefined ? {} : { text: expected.text }),
      ...(expected.headers === undefined ? {} : { headers: expected.headers }),
    }));
    const client = createGameServicesNotificationsClient({
      baseUrl: 'https://services.example',
      identity,
      fetch,
    });
    const error = await rejection(client.listConsent());
    const label = `${expected.status} ${JSON.stringify(expected.body ?? expected.text)}`;
    assert.equal(error.code, expected.code, label);
    assert.equal(error.retryable, expected.retryable, label);
    assert.equal(error.status, expected.status, label);
    assert.equal(error.route, '/consent', label);
    if (expected.serverCode !== undefined) {
      assert.equal(error.serverCode, expected.serverCode, label);
    }
    assert.equal(error.retryAfterSeconds, expected.retryAfterSeconds, label);
  }

  // A route-specific contract break: a reminder status the runtime does not know.
  const { fetch: oddStatus } = fakeFetch(() => ({ status: 200, body: { status: 'queued' } }));
  const reminders = createGameServicesNotificationsClient({
    baseUrl: 'https://services.example',
    identity,
    fetch: oddStatus,
  });
  assert.equal(
    (await rejection(reminders.setReminder({ key: 'k', topic: 't', fireAt: '2026-10-21T00:00:00Z' }))).code,
    'NOTIFICATIONS_CONFIGURATION_REQUIRED',
  );
  const { fetch: oddCancel } = fakeFetch(() => ({ status: 200, body: { cancelled: 'yes' } }));
  assert.equal(
    (await rejection(createGameServicesNotificationsClient({ baseUrl: 'https://services.example', identity, fetch: oddCancel })
      .cancelReminder({ key: 'k' }))).code,
    'NOTIFICATIONS_CONFIGURATION_REQUIRED',
  );

  // No answer: the request failed, retryable, with the cause kept.
  const offline = new TypeError('Failed to fetch');
  const unreachable = createGameServicesNotificationsClient({
    baseUrl: 'https://services.example',
    identity,
    fetch: async () => {
      throw offline;
    },
  });
  const failed = await rejection(unreachable.listNotices());
  assert.equal(failed.code, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
  assert.equal(failed.status, 0);
  assert.equal(failed.cause, offline);

  // A header resolver that fails sends nothing and leaks nothing it threw.
  const { fetch: unused, sent } = fakeFetch(() => ({ status: 200, body: {} }));
  const noCredentials = createGameServicesNotificationsClient({
    baseUrl: 'https://services.example',
    identity,
    fetch: unused,
    getHeaders: () => {
      throw new Error('refresh token rt-secret expired');
    },
  });
  const unresolved = await rejection(noCredentials.listConsent());
  assert.equal(unresolved.code, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
  assert.equal(sent.length, 0);
  assert.ok(!unresolved.message.includes('rt-secret'));
  assert.ok(!String((unresolved.cause as Error | undefined)?.message).includes('rt-secret'));
}

// Inputs.
{
  const { identity } = identityOf(session);
  assert.throws(
    () => createGameServicesNotificationsClient({ baseUrl: ' / ', identity }),
    NotificationError,
  );
  assert.throws(
    () =>
      createGameServicesNotificationsClient({ baseUrl: 'https://x.example', identity, target: '' }),
    NotificationError,
  );
}

console.info('notifications client: requests, sessions, and answer mapping passed');
