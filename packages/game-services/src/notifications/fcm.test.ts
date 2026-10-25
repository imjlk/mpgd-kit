import assert from 'node:assert/strict';

import type { NotificationRemoteDeliveryRequest } from './delivery-provider.js';
import {
  buildFcmMessage,
  classifyFcmError,
  createFcmAccessTokenSource,
  createFcmDeliveryProvider,
  createFcmProviderRegistration,
  FcmAccessTokenError,
  fcmCollapseId,
  fcmMessagingScope,
  fcmShellRenderedDataKeys,
  fcmTokenEndpoint,
  parseFcmServiceAccount,
} from './fcm.js';

// A key generated for this run only: no real Firebase credential is involved.
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
const pem = pemOf(btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/gu)?.join('\n') ?? '');
const keyFile = JSON.stringify({
  type: 'service_account',
  project_id: 'mpgd-test-project',
  private_key_id: 'test-key-1',
  private_key: pem,
  client_email: 'fcm-sender@mpgd-test-project.iam.gserviceaccount.com',
});
const serviceAccount = parseFcmServiceAccount(keyFile);

assert.deepEqual(
  { ...serviceAccount, privateKey: serviceAccount.privateKey === pem },
  {
    projectId: 'mpgd-test-project',
    clientEmail: 'fcm-sender@mpgd-test-project.iam.gserviceaccount.com',
    privateKey: true,
    privateKeyId: 'test-key-1',
  },
);
for (const bad of [
  '{',
  '[]',
  JSON.stringify({ project_id: 'p' }),
  JSON.stringify({ ...JSON.parse(keyFile), type: 'authorized_user' }),
]) {
  assert.throws(
    () => parseFcmServiceAccount(bad),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!error.message.includes('PRIVATE KEY'));
      return true;
    },
  );
}

function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/gu, '+').replace(/_/gu, '/');
  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
}

async function verifyJwt(assertion: string): Promise<{ readonly header: unknown; readonly claims: unknown }> {
  const [header = '', claims = '', signature = ''] = assertion.split('.');
  const bytes = Uint8Array.from(
    atob(
      signature.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (signature.length % 4)) % 4),
    ),
    (char) => char.charCodeAt(0),
  );
  assert.ok(
    await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, bytes, new TextEncoder().encode(`${header}.${claims}`)),
    'the JWT verifies with the service account key',
  );
  return { header: decodeSegment(header), claims: decodeSegment(claims) };
}

interface Exchange {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeGoogle(handlers: {
  token?: (exchange: Exchange) => Response | Promise<Response>;
  send?: (exchange: Exchange) => Response | Promise<Response>;
}) {
  const exchanges: Exchange[] = [];
  let tokens = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const exchange = { url, init };
    exchanges.push(exchange);
    if (url === fcmTokenEndpoint) {
      tokens += 1;
      return handlers.token?.(exchange) ?? Response.json({ access_token: `token-${tokens}`, expires_in: 3599, token_type: 'Bearer' });
    }
    return handlers.send?.(exchange) ?? Response.json({ name: 'projects/mpgd-test-project/messages/1' });
  };
  return { fetch, exchanges, tokenCount: () => tokens };
}

const request: NotificationRemoteDeliveryRequest = {
  idempotencyKey: 'send-1:install-1',
  sendKey: 'send-1',
  provider: 'fcm',
  player: 'p-1',
  topic: {
    id: 'sale',
    purpose: 'advertising',
    channels: ['remote'],
    route: '/shop',
    optOutRoute: '/settings/ads',
    mapping: { channelId: 'promotions' },
  },
  recipient: {
    kind: 'device',
    installationId: 'install-1',
    address: { kind: 'fcm-token', value: 'device-token' },
  },
  content: {
    title: '(광고) 세일',
    body: '(광고) 02-000-0000\n세일 중\n무료 수신거부: 수신거부 버튼',
    route: '/shop',
    actions: [{ id: 'advertising-opt-out', title: '수신거부', route: '/settings/ads' }],
    source: 'catalog',
  },
  expiresAt: '2026-10-19T12:00:00Z',
  data: { offer: 'autumn' },
  at: '2026-10-19T03:00:00Z',
};

// The message: content, data, channel, expiry as android.ttl and apns-expiration, and the opt-out category.
{
  const collapseId = fcmCollapseId(request.sendKey);
  assert.equal(collapseId.length, 64);
  assert.equal(new TextEncoder().encode(collapseId).byteLength, 64);
  assert.equal(await sha256Hex(request.sendKey), collapseId);
  assert.equal(fcmCollapseId('x'.repeat(200)).length, 64);
  assert.notEqual(fcmCollapseId('send-1'), fcmCollapseId('send-2'));
  const built = buildFcmMessage(request);
  assert.deepEqual(built, {
    status: 'ready',
    message: {
      token: 'device-token',
      notification: {
        title: '(광고) 세일',
        body: '(광고) 02-000-0000\n세일 중\n무료 수신거부: 수신거부 버튼',
      },
      data: {
        offer: 'autumn',
        topic: 'sale',
        route: '/shop',
      },
      android: {
        collapse_key: collapseId,
        ttl: '32400s',
        notification: { channel_id: 'promotions' },
      },
      apns: {
        headers: {
          'apns-collapse-id': collapseId,
          'apns-expiration': String(Date.parse('2026-10-19T12:00:00Z') / 1000),
        },
        payload: { aps: { category: 'mpgd-advertising' } },
      },
    },
  });
  const { expiresAt: _expiresAt, ...unexpiring } = request;
  const plain = buildFcmMessage({
    ...unexpiring,
    topic: {
      id: 'friend-challenge',
      purpose: 'service',
      channels: ['remote'],
      route: '/',
      mapping: {},
    },
    content: { title: 'T', body: 'B', route: '/', source: 'catalog' },
    data: {},
  });
  // Without a channelId a push posts to the purpose's default channel, and only advertising names a category.
  // The collapse id is still set, so a replay does not show a second notification.
  assert.deepEqual(plain, {
    status: 'ready',
    message: {
      token: 'device-token',
      notification: { title: 'T', body: 'B' },
      data: { topic: 'friend-challenge', route: '/' },
      android: { collapse_key: collapseId, notification: { channel_id: 'mpgd-service' } },
      apns: { headers: { 'apns-collapse-id': collapseId } },
    },
  });
  for (const [change, reason] of [
    [
      {
        recipient: {
          kind: 'device',
          installationId: 'i',
          address: { kind: 'fcm-installation', value: 'fid' },
        },
      },
      /installation ids \(fcm-installation\) are reserved and refused until FCM can send to them/u,
    ],
    [{ recipient: { kind: 'platform-user', id: 'u' } }, /registration tokens/u],
    [{ content: { route: '/', source: 'host-template' } }, /title and a body/u],
    [{ data: { route: '/evil' } }, /reserved/u],
    [{ data: { topic: 'other' } }, /reserved/u],
    [{ data: { aps: '{}' } }, /reserved/u],
    [{ data: { collapse_key: 'x' } }, /reserved/u],
    [{ data: { 'google.c.a.e': '1' } }, /reserved/u],
    [{ data: { from: 'x' } }, /reserved/u],
    [{ data: { big: 'x'.repeat(5000) } }, /at most 3840/u],
    [{ data: { googleFoo: '1' } }, /reserved/u],
    [{ data: { gcmX: '1' } }, /reserved/u],
    [{ data: { '': '1' } }, /reserved/u],
    [{ data: JSON.parse('{"__proto__":"x"}') as Record<string, string> }, /reserved/u],
    [{ data: { count: 3 } }, /not a string/u],
    [{ expiresAt: '2026-10-19T03:00:00.500Z' }, /expires before/u],
    [{ expiresAt: 'soon' }, /not a timestamp/u],
  ] as const) {
    const result = buildFcmMessage({ ...request, ...change } as NotificationRemoteDeliveryRequest);
    assert.equal(result.status, 'invalid');
    assert.match(result.status === 'invalid' ? result.reason : '', reason);
  }
}

// An advertising send to an endpoint whose shell renders advertising (an
// Android installation with the kit's renderer) is a data message: no
// `notification` block, so the shell's messaging service gets it in the
// background too, with everything the gate rendered and the expiry.
{
  const collapseId = fcmCollapseId(request.sendKey);
  const renderer = {
    ...request,
    recipient: {
      kind: 'device',
      installationId: 'install-1',
      address: { kind: 'fcm-token', value: 'device-token', rendersAdvertising: true },
    },
  } as const satisfies NotificationRemoteDeliveryRequest;
  assert.deepEqual(buildFcmMessage(renderer), {
    status: 'ready',
    message: {
      token: 'device-token',
      data: {
        offer: 'autumn',
        topic: 'sale',
        route: '/shop',
        'mpgd.render': 'advertising',
        'mpgd.title': '(광고) 세일',
        'mpgd.body': '(광고) 02-000-0000\n세일 중\n무료 수신거부: 수신거부 버튼',
        'mpgd.channel': 'promotions',
        'mpgd.actionTitle': '수신거부',
        'mpgd.expiresAt': String(Date.parse('2026-10-19T12:00:00Z')),
      },
      // Normal priority (FCM's default): no `priority` key.
      android: { collapse_key: collapseId, ttl: '32400s' },
    },
  });
  assert.deepEqual(Object.values(fcmShellRenderedDataKeys).sort(), [
    'mpgd.actionTitle',
    'mpgd.body',
    'mpgd.channel',
    'mpgd.expiresAt',
    'mpgd.render',
    'mpgd.title',
  ]);
  // Without an expiry or an action (the rules are `none`), those keys are
  // left out; the channel falls back to the purpose's.
  const { expiresAt: _expiresAt, ...unexpiring } = renderer;
  assert.deepEqual(
    buildFcmMessage({
      ...unexpiring,
      topic: { ...request.topic, mapping: {} },
      content: { title: 'Sale', body: 'On now', route: '/shop', source: 'catalog' },
      data: {},
    }),
    {
      status: 'ready',
      message: {
        token: 'device-token',
        data: {
          topic: 'sale',
          route: '/shop',
          'mpgd.render': 'advertising',
          'mpgd.title': 'Sale',
          'mpgd.body': 'On now',
          'mpgd.channel': 'mpgd-advertising',
        },
        android: { collapse_key: collapseId },
      },
    },
  );
  // Other purposes stay notification messages on the same endpoint.
  const service = buildFcmMessage({
    ...renderer,
    topic: {
      id: 'friend-challenge',
      purpose: 'service',
      channels: ['remote'],
      route: '/',
      mapping: {},
    },
    content: { title: 'T', body: 'B', route: '/', source: 'catalog' },
    data: {},
  });
  assert.equal(service.status, 'ready');
  assert.deepEqual(service.status === 'ready' ? service.message['notification'] : undefined, {
    title: 'T',
    body: 'B',
  });
  // The size check covers the data message too, and a send may not use the renderer's keys.
  for (const [data, reason] of [
    [{ big: 'x'.repeat(5000) }, /at most 3840/u],
    [{ 'mpgd.title': 'spoof' }, /reserved/u],
    [{ 'MPGD.action': 'advertising-opt-out' }, /reserved/u],
  ] as const) {
    const result = buildFcmMessage({ ...renderer, data });
    assert.equal(result.status, 'invalid');
    assert.match(result.status === 'invalid' ? result.reason : '', reason);
  }
}

// Error mapping (RFC "Delivery providers").
{
  const fcmError = (status: number, errorCode: string | undefined, extra: object[] = []) => ({
    status,
    body: {
      error: {
        code: status,
        status: errorCode === undefined ? 'UNKNOWN' : 'FAILED',
        details: [
          ...(errorCode === undefined ? [] : [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }]),
          ...extra,
        ],
      },
    },
  });
  assert.deepEqual(classifyFcmError(fcmError(404, 'UNREGISTERED')), { status: 'unregistered' });
  // Without an answer that names the token, an INVALID_ARGUMENT keeps the endpoint.
  assert.deepEqual(classifyFcmError(fcmError(400, 'INVALID_ARGUMENT')), {
    status: 'rejected',
    reason: 'configuration',
    providerCode: 'INVALID_ARGUMENT',
  });
  assert.deepEqual(
    classifyFcmError(
      fcmError(400, 'INVALID_ARGUMENT', [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{ field: 'message.token', description: 'Invalid registration token' }],
        },
      ]),
    ),
    { status: 'unregistered' },
  );
  assert.deepEqual(
    classifyFcmError(
      fcmError(400, 'INVALID_ARGUMENT', [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{ field: 'message.android.ttl' }],
        },
      ]),
    ),
    { status: 'rejected', reason: 'configuration', providerCode: 'INVALID_ARGUMENT' },
  );
  assert.deepEqual(
    classifyFcmError({ ...fcmError(429, 'QUOTA_EXCEEDED'), retryAfterSeconds: 120 }),
    {
      status: 'rate-limited',
      retryAfterSeconds: 120,
    },
  );
  assert.deepEqual(classifyFcmError(fcmError(429, 'QUOTA_EXCEEDED')), {
    status: 'rate-limited',
    retryAfterSeconds: 60,
  });
  assert.deepEqual(classifyFcmError(fcmError(503, 'UNAVAILABLE')), {
    status: 'ambiguous',
    providerCode: 'UNAVAILABLE',
  });
  assert.deepEqual(classifyFcmError(fcmError(500, 'INTERNAL')), {
    status: 'ambiguous',
    providerCode: 'INTERNAL',
  });
  for (const code of ['SENDER_ID_MISMATCH', 'THIRD_PARTY_AUTH_ERROR']) {
    assert.deepEqual(classifyFcmError(fcmError(403, code)), {
      status: 'rejected',
      reason: 'configuration',
      providerCode: code,
    });
  }
  assert.deepEqual(classifyFcmError({ status: 502, body: 'Bad gateway' }), {
    status: 'ambiguous',
    providerCode: 'HTTP_502',
  });
  assert.deepEqual(classifyFcmError({ status: 429, body: undefined }), {
    status: 'rate-limited',
    retryAfterSeconds: 60,
  });
  assert.deepEqual(
    classifyFcmError({ status: 400, body: { error: { status: 'FAILED_PRECONDITION' } } }),
    {
      status: 'rejected',
      reason: 'configuration',
      providerCode: 'FAILED_PRECONDITION',
    },
  );
}

// Sends: one signed token for many sends, refreshed before it expires, and minted again after a 401.
{
  let now = Date.parse('2026-10-19T03:00:00Z');
  const google = fakeGoogle({});
  const provider = createFcmDeliveryProvider({
    serviceAccount,
    fetch: google.fetch,
    now: () => now,
  });
  assert.equal(provider.id, 'fcm');
  assert.deepEqual(await provider.send(request), {
    status: 'accepted',
    providerMessageId: 'projects/mpgd-test-project/messages/1',
  });
  assert.deepEqual(await provider.send(request), {
    status: 'accepted',
    providerMessageId: 'projects/mpgd-test-project/messages/1',
  });
  assert.equal(google.tokenCount(), 1);
  const [tokenRequest, send] = google.exchanges;
  const form = new URLSearchParams(String(tokenRequest?.init.body));
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const jwt = await verifyJwt(form.get('assertion') ?? '');
  assert.deepEqual(jwt.header, { alg: 'RS256', typ: 'JWT', kid: 'test-key-1' });
  assert.deepEqual(jwt.claims, {
    iss: serviceAccount.clientEmail,
    scope: fcmMessagingScope,
    aud: fcmTokenEndpoint,
    iat: now / 1000,
    exp: now / 1000 + 3600,
  });
  assert.equal(send?.url, 'https://fcm.googleapis.com/v1/projects/mpgd-test-project/messages:send');
  assert.equal(new Headers(send?.init.headers).get('authorization'), 'Bearer token-1');
  assert.deepEqual(JSON.parse(String(send?.init.body)), {
    message: (buildFcmMessage(request) as { message: unknown }).message,
  });
  // 55 minutes later the cached token is within its refresh margin.
  now += 55 * 60 * 1000;
  await provider.send(request);
  assert.equal(google.tokenCount(), 2);
  // Concurrent sends share one token request.
  const concurrent = fakeGoogle({});
  const shared = createFcmDeliveryProvider({
    serviceAccount,
    fetch: concurrent.fetch,
    now: () => now,
  });
  await Promise.all([shared.send(request), shared.send(request), shared.send(request)]);
  assert.equal(concurrent.tokenCount(), 1);

  let unauthorized = 1;
  const revoked = fakeGoogle({
    send: () => {
      if (unauthorized > 0) {
        unauthorized -= 1;
        return Response.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, { status: 401 });
      }
      return Response.json({ name: 'm-2' });
    },
  });
  const retrying = createFcmDeliveryProvider({
    serviceAccount,
    fetch: revoked.fetch,
    now: () => now,
  });
  assert.deepEqual(await retrying.send(request), { status: 'accepted', providerMessageId: 'm-2' });
  assert.equal(revoked.tokenCount(), 2);
  const alwaysUnauthorized = fakeGoogle({
    send: () => Response.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, { status: 401 }),
  });
  assert.deepEqual(
    await createFcmDeliveryProvider({ serviceAccount, fetch: alwaysUnauthorized.fetch, now: () => now }).send(request),
    { status: 'rejected', reason: 'configuration', providerCode: 'UNAUTHENTICATED' },
  );
}

// Failures before or around the send.
{
  const now = () => Date.parse('2026-10-19T03:00:00Z');
  const send = (google: ReturnType<typeof fakeGoogle>) =>
    createFcmDeliveryProvider({ serviceAccount, fetch: google.fetch, now }).send(request);
  // An invalid message is never sent.
  const unsent = fakeGoogle({});
  assert.deepEqual(
    await createFcmDeliveryProvider({ serviceAccount, fetch: unsent.fetch, now }).send({ ...request, data: { topic: 'x' } }),
    { status: 'rejected', reason: 'configuration', providerCode: 'INVALID_MESSAGE' },
  );
  assert.equal(unsent.exchanges.length, 0);
  // A Firebase installation id is reserved: refused with its own code, and nothing is fetched.
  assert.deepEqual(
    await createFcmDeliveryProvider({ serviceAccount, fetch: unsent.fetch, now }).send({
      ...request,
      recipient: { kind: 'device', installationId: 'i', address: { kind: 'fcm-installation', value: 'fid' } },
    }),
    { status: 'rejected', reason: 'configuration', providerCode: 'INSTALLATION_ID_RESERVED' },
  );
  assert.equal(unsent.exchanges.length, 0);
  // A refused grant is configuration; an unavailable token endpoint sent nothing and waits.
  assert.deepEqual(
    await send(fakeGoogle({ token: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) })),
    { status: 'rejected', reason: 'configuration', providerCode: 'TOKEN_INVALID_GRANT' },
  );
  assert.deepEqual(
    await send(fakeGoogle({ token: () => new Response('down', { status: 503, headers: { 'retry-after': '30' } }) })),
    { status: 'rate-limited', retryAfterSeconds: 30 },
  );
  assert.deepEqual(
    await send(fakeGoogle({ token: () => Promise.reject(new TypeError('fetch failed')) })),
    { status: 'rate-limited', retryAfterSeconds: 60 },
  );
  // A dropped send connection may have delivered.
  assert.deepEqual(
    await send(fakeGoogle({ send: () => Promise.reject(new TypeError('fetch failed')) })),
    { status: 'ambiguous', providerCode: 'NETWORK_ERROR' },
  );
  assert.deepEqual(
    await send(fakeGoogle({
      send: () => Response.json(
        { error: { code: 429, details: [{ errorCode: 'QUOTA_EXCEEDED' }] } },
        { status: 429, headers: { 'retry-after': '90' } },
      ),
    })),
    { status: 'rate-limited', retryAfterSeconds: 90 },
  );
  // An outage is remembered for five seconds, then the token source asks again.
  let outageClock = now();
  let fail = true;
  const flaky = fakeGoogle({
    token: () => {
      if (fail) {
        fail = false;
        return new Response('down', { status: 500 });
      }
      return Response.json({ access_token: 'late-token', expires_in: 3600 });
    },
  });
  const tokens = createFcmAccessTokenSource({
    serviceAccount,
    fetch: flaky.fetch,
    now: () => outageClock,
  });
  await assert.rejects(tokens.get(), { name: 'FcmAccessTokenError', retryable: true });
  await assert.rejects(tokens.get(), { name: 'FcmAccessTokenError', retryable: true });
  outageClock += 5_001;
  assert.equal(await tokens.get(), 'late-token');
  // A key that cannot be imported names no key material.
  const broken = createFcmAccessTokenSource({
    serviceAccount: {
      ...serviceAccount,
      privateKey: pemOf('AAAA'),
    },
    fetch: flaky.fetch,
    now,
  });
  await assert.rejects(broken.get(), (error: unknown) => {
    assert.ok(error instanceof FcmAccessTokenError);
    assert.equal(error.code, 'TOKEN_KEY_UNUSABLE');
    assert.equal(error.retryable, false);
    // The cause names the failing step and holds no key material.
    assert.ok(error.cause instanceof TypeError);
    assert.ok(!String((error.cause as Error).message).includes('AAAA'));
    return true;
  });
  assert.throws(
    () => createFcmDeliveryProvider({ serviceAccount, projectId: 'Bad Project' }),
    /project id/u,
  );
}

// Configuration failures answer at once, without hammering Google.
{
  const now = () => Date.parse('2026-10-19T03:00:00Z');
  // APNs auth is missing: a 401 that names THIRD_PARTY_AUTH_ERROR mints no new token.
  const apns = fakeGoogle({
    send: () =>
      Response.json(
        {
          error: {
            code: 401,
            status: 'UNAUTHENTICATED',
            details: [{ errorCode: 'THIRD_PARTY_AUTH_ERROR' }],
          },
        },
        { status: 401 },
      ),
  });
  assert.deepEqual(
    await createFcmDeliveryProvider({ serviceAccount, fetch: apns.fetch, now }).send(request),
    { status: 'rejected', reason: 'configuration', providerCode: 'THIRD_PARTY_AUTH_ERROR' },
  );
  assert.equal(apns.tokenCount(), 1);
  // A key that cannot sign is configuration, and the refusal is remembered for a while.
  const google = fakeGoogle({});
  const broken = createFcmDeliveryProvider({
    serviceAccount: {
      ...serviceAccount,
      privateKey: pemOf('AAAA'),
    },
    fetch: google.fetch,
    now,
  });
  for (let send = 0; send < 3; send += 1) {
    assert.deepEqual(await broken.send(request), {
      status: 'rejected',
      reason: 'configuration',
      providerCode: 'TOKEN_KEY_UNUSABLE',
    });
  }
  assert.equal(google.exchanges.length, 0);
  // A refused grant is asked again only after 30 seconds, and its code is sanitized.
  let clock = now();
  const refusing = fakeGoogle({
    token: () => Response.json({ error: 'invalid grant: <bad>' }, { status: 400 }),
  });
  const refused = createFcmDeliveryProvider({
    serviceAccount,
    fetch: refusing.fetch,
    now: () => clock,
  });
  for (let send = 0; send < 3; send += 1) {
    assert.deepEqual(await refused.send(request), {
      status: 'rejected',
      reason: 'configuration',
      providerCode: 'TOKEN_INVALID_GRANT_BAD_',
    });
  }
  assert.equal(refusing.tokenCount(), 1);
  clock += 30_001;
  await refused.send(request);
  assert.equal(refusing.tokenCount(), 2);
  // A service-account file whose key keeps its newlines escaped still signs.
  const escaped = fakeGoogle({});
  const escapedKey = createFcmDeliveryProvider({
    serviceAccount: { ...serviceAccount, privateKey: pem.replace(/\n/gu, '\\n') },
    fetch: escaped.fetch,
    now,
  });
  assert.equal((await escapedKey.send(request)).status, 'accepted');
  await verifyJwt(
    new URLSearchParams(String(escaped.exchanges[0]?.init.body)).get('assertion') ?? '',
  );
  // Retry-After as an HTTP date reads the provider's clock, and is capped at a day.
  for (const [header, seconds] of [
    [new Date(now() + 120_000).toUTCString(), 120],
    ['9999999', 86_400],
  ] as const) {
    const limited = fakeGoogle({
      send: () =>
        Response.json(
          { error: { code: 429, details: [{ errorCode: 'QUOTA_EXCEEDED' }] } },
          { status: 429, headers: { 'retry-after': header } },
        ),
    });
    assert.deepEqual(
      await createFcmDeliveryProvider({ serviceAccount, fetch: limited.fetch, now }).send(request),
      { status: 'rate-limited', retryAfterSeconds: seconds },
    );
  }
  // Legacy domain-scoped project ids are accepted; a trailing or doubled separator is not.
  assert.equal(createFcmDeliveryProvider({ serviceAccount, projectId: 'my-game-12345' }).id, 'fcm');
  for (const bad of [
    'my-project:',
    'my-project.',
    'example..com:proj',
    'my-project-',
    'my-.x',
    'a-.b:c',
  ]) {
    assert.throws(
      () => createFcmDeliveryProvider({ serviceAccount, projectId: bad }),
      /project id/u,
      bad,
    );
  }
  assert.equal(
    createFcmDeliveryProvider({ serviceAccount, projectId: 'example.com:my-project' }).id,
    'fcm',
  );
}

// Lateness keeps its own code; FCM's codes are sanitized; a token outage is not asked once per send.
{
  const now = () => Date.parse('2026-10-19T03:00:00Z');
  const google = fakeGoogle({});
  assert.deepEqual(
    await createFcmDeliveryProvider({ serviceAccount, fetch: google.fetch, now })
      .send({ ...request, expiresAt: '2026-10-19T03:00:00.400Z' }),
    { status: 'rejected', reason: 'configuration', providerCode: 'MESSAGE_EXPIRED' },
  );
  assert.equal(google.exchanges.length, 0);
  assert.deepEqual(
    classifyFcmError({ status: 400, body: { error: { status: 'weird status!\n<b>' } } }),
    { status: 'rejected', reason: 'configuration', providerCode: 'WEIRD_STATUS_B_' },
  );
  let clock = now();
  const down = fakeGoogle({ token: () => new Response('down', { status: 503 }) });
  const provider = createFcmDeliveryProvider({
    serviceAccount,
    fetch: down.fetch,
    now: () => clock,
  });
  for (let send = 0; send < 3; send += 1) {
    assert.deepEqual(await provider.send(request), {
      status: 'rate-limited',
      retryAfterSeconds: 60,
    });
  }
  assert.equal(down.tokenCount(), 1);
  clock += 5_001;
  await provider.send(request);
  assert.equal(down.tokenCount(), 2);
}

// A refresh that fails inside the refresh margin keeps sending with the token that still works.
{
  let clock = Date.parse('2026-10-19T03:00:00Z');
  let down = false;
  const google = fakeGoogle({
    token: () => (down
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '40' } })
      : Response.json({ access_token: 'first-token', expires_in: 3600 })),
  });
  const tokens = createFcmAccessTokenSource({
    serviceAccount,
    fetch: google.fetch,
    now: () => clock,
  });
  assert.equal(await tokens.get(), 'first-token');
  down = true;
  clock += 56 * 60 * 1000;
  // Inside the margin the refresh fails, but the token has four minutes left.
  assert.equal(await tokens.get(), 'first-token');
  assert.equal(await tokens.get(), 'first-token');
  assert.equal(google.tokenCount(), 2);
  // The outage asked for 40 s: nobody asks again before that.
  clock += 30_000;
  assert.equal(await tokens.get(), 'first-token');
  assert.equal(google.tokenCount(), 2);
  clock += 11_000;
  await tokens.get();
  assert.equal(google.tokenCount(), 3);
}

// A usable token does not wait for a refresh that is under way.
{
  let clock = Date.parse('2026-10-19T03:00:00Z');
  let release: (() => void) | undefined;
  let grants = 0;
  const google = fakeGoogle({
    token: async () => {
      grants += 1;
      if (grants === 1) {
        return Response.json({ access_token: 'old-token', expires_in: 3600 });
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ access_token: 'new-token', expires_in: 3600 });
    },
  });
  const tokens = createFcmAccessTokenSource({
    serviceAccount,
    fetch: google.fetch,
    now: () => clock,
  });
  assert.equal(await tokens.get(), 'old-token');
  clock += 56 * 60 * 1000;
  const refreshing = tokens.get();
  // The first caller in the margin starts the refresh; the next one does not wait for it.
  assert.equal(await tokens.get(), 'old-token');
  while (release === undefined) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  release();
  assert.equal(await refreshing, 'new-token');
  assert.equal(await tokens.get(), 'new-token');
}

// The registration wires FCM into the registry for android and ios, registration tokens only.
{
  const registration = createFcmProviderRegistration({
    serviceAccount,
    fetch: fakeGoogle({}).fetch,
  });
  assert.equal(registration.entry.provider, 'fcm');
  assert.deepEqual(registration.targets, ['android', 'ios']);
  assert.deepEqual(registration.addressKinds, ['fcm-token']);
}

console.info('FCM delivery provider tests passed.');

/** A PEM block of a key generated by this test; the markers are joined at run time. */
function pemOf(base64: string): string {
  const label = ['PRIVATE', 'KEY'].join(' ');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
