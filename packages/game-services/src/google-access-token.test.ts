import assert from 'node:assert/strict';

import {
  createGoogleAccessTokenSource,
  GoogleAccessTokenError,
  googleTokenEndpoint,
  parseGoogleServiceAccount,
} from './google-access-token.js';
import {
  createGooglePlayPublisherAccessTokenSource,
  createGooglePlayPublisherClient,
  googlePlayPublisherScope,
} from './google-play-publisher-client.js';

// A key generated for this run only: no real Google credential is involved.
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
const keyBase64 = btoa(String.fromCharCode(...pkcs8));
const pem = pemOf(keyBase64.match(/.{1,64}/gu)?.join('\n') ?? '');
/** A stretch of the key's base64, which no error may show. */
const keyMaterial = keyBase64.slice(100, 164);
const clientEmail = 'play-verifier@mpgd-test-project.iam.gserviceaccount.com';
const keyFile = {
  type: 'service_account',
  project_id: 'mpgd-test-project',
  private_key_id: 'play-key-1',
  private_key: pem,
  client_email: clientEmail,
};
const serviceAccount = parseGoogleServiceAccount(JSON.stringify(keyFile));
const start = Date.parse('2026-11-23T03:00:00Z');
const otherScope = 'https://www.googleapis.com/auth/devstorage.read_only';

interface Exchange {
  readonly url: string;
  readonly init: RequestInit;
}

/** Google's token endpoint: `answer` decides each reply, else a fresh `token-<n>`. */
function fakeGoogle(answer?: (exchange: Exchange, count: number) => Response | Promise<Response>) {
  const exchanges: Exchange[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const exchange = { url, init };
    exchanges.push(exchange);
    return (
      answer?.(exchange, exchanges.length)
      ?? Response.json({
        access_token: `token-${exchanges.length}`,
        expires_in: 3599,
        token_type: 'Bearer',
      })
    );
  };
  return { fetch, exchanges };
}

function assertionOf(exchange: Exchange | undefined): string {
  return new URLSearchParams(String(exchange?.init.body)).get('assertion') ?? '';
}

// The key file: the fields a token needs, with or without a project, and errors that show no value.
{
  assert.deepEqual(
    { ...serviceAccount, privateKey: serviceAccount.privateKey === pem },
    { clientEmail, privateKey: true, privateKeyId: 'play-key-1' },
  );
  const { project_id: _project, private_key_id: _keyId, ...minimal } = keyFile;
  assert.deepEqual(parseGoogleServiceAccount(minimal), { clientEmail, privateKey: pem });
  for (const [bad, message] of [
    // Cut short: JSON.parse would quote the text, key and all.
    [JSON.stringify(keyFile).slice(0, -2), /^The Google service account is not JSON\.$/u],
    ['[]', /must be an object/u],
    [{ ...keyFile, client_email: ' ' }, /has no client_email/u],
    [{ ...keyFile, private_key: undefined }, /has no private_key/u],
    [{ ...keyFile, type: 'authorized_user' }, /not a service account key/u],
  ] as const) {
    assert.throws(
      () => parseGoogleServiceAccount(bad),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, message);
        assertRedacted(error, [keyMaterial]);
        return true;
      },
    );
  }
}

// The Play Developer API source signs for its scope and plugs into the publisher client.
{
  assert.equal(googlePlayPublisherScope, 'https://www.googleapis.com/auth/androidpublisher');
  const now = start;
  const google = fakeGoogle();
  const tokens = createGooglePlayPublisherAccessTokenSource({
    serviceAccount,
    fetch: google.fetch,
    now: () => now,
  });
  const publisher: Exchange[] = [];
  let unauthorized = false;
  const client = createGooglePlayPublisherClient({
    getAccessToken: tokens.get,
    invalidateAccessToken: tokens.invalidate,
    fetch: async (url, init) => {
      publisher.push({ url: String(url), init: init ?? {} });
      if (unauthorized) {
        unauthorized = false;
        return new Response(null, { status: 401 });
      }
      return Response.json({ purchaseStateContext: { purchaseState: 'PURCHASED' } });
    },
  });
  const purchase = {
    packageName: 'dev.mpgd.game',
    purchaseToken: 'purchase-token',
    signal: new AbortController().signal,
  };
  await client.getProductPurchaseV2(purchase);
  await client.getProductPurchaseV2(purchase);
  // One token for both requests.
  assert.equal(google.exchanges.length, 1);
  const [exchange] = google.exchanges;
  assert.equal(exchange?.url, googleTokenEndpoint);
  assert.equal(exchange?.init.method, 'POST');
  // A redirect is never followed with the assertion.
  assert.equal(exchange?.init.redirect, 'manual');
  assert.ok(exchange?.init.signal instanceof AbortSignal);
  const form = new URLSearchParams(String(exchange?.init.body));
  assert.deepEqual([...form.keys()].sort(), ['assertion', 'grant_type']);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const jwt = await verifyJwt(assertionOf(exchange));
  assert.deepEqual(jwt.header, { alg: 'RS256', typ: 'JWT', kid: 'play-key-1' });
  assert.deepEqual(jwt.claims, {
    iss: clientEmail,
    scope: googlePlayPublisherScope,
    aud: googleTokenEndpoint,
    iat: now / 1000,
    exp: now / 1000 + 3600,
  });
  assert.deepEqual(
    publisher.map(({ init }) => new Headers(init.headers).get('authorization')),
    ['Bearer token-1', 'Bearer token-1'],
  );
  // Play refuses the token (revoked early): the client drops it, and the next request mints anew.
  unauthorized = true;
  await assert.rejects(client.getProductPurchaseV2(purchase), /HTTP 401/u);
  await client.getProductPurchaseV2(purchase);
  assert.equal(google.exchanges.length, 2);
  assert.equal(new Headers(publisher.at(-1)?.init.headers).get('authorization'), 'Bearer token-2');
}

// A cached token answers until five minutes before it expires; then a new one is minted.
{
  let now = start;
  const google = fakeGoogle((_exchange, count) =>
    Response.json({ access_token: `token-${count}`, expires_in: 600, token_type: 'Bearer' }),
  );
  const tokens = createGoogleAccessTokenSource({
    serviceAccount,
    scope: otherScope,
    fetch: google.fetch,
    now: () => now,
  });
  assert.equal(await tokens.get(), 'token-1');
  assert.equal((await verifyJwt(assertionOf(google.exchanges[0]))).claims.scope, otherScope);
  now += 299_000;
  assert.equal(await tokens.get(), 'token-1');
  assert.equal(google.exchanges.length, 1);
  // Google said 600 seconds: refreshed after 300.
  now += 2_000;
  assert.equal(await tokens.get(), 'token-2');
  assert.equal(google.exchanges.length, 2);
  // `invalidate` drops only the token it names.
  tokens.invalidate('token-1');
  assert.equal(await tokens.get(), 'token-2');
  tokens.invalidate('token-2');
  assert.equal(await tokens.get(), 'token-3');
  // The request timer is cleared once a token request settles.
  const timers = activeTimers();
  tokens.invalidate('token-3');
  assert.equal(await tokens.get(), 'token-4');
  assert.equal(activeTimers(), timers);
  assert.throws(
    () => createGoogleAccessTokenSource({ serviceAccount, scope: ' ' }),
    /OAuth scope/u,
  );
  assert.throws(
    () => createGoogleAccessTokenSource({ serviceAccount, scope: `${otherScope}\n` }),
    /OAuth scope/u,
  );
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createGoogleAccessTokenSource({ serviceAccount, scope: otherScope, timeoutMs }),
      /timeout must be a positive number/u,
    );
  }
}

// Concurrent callers share one token request; a caller's signal ends only its own wait.
{
  let release: (() => void) | undefined;
  const google = fakeGoogle(async (_exchange, count) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json({ access_token: `token-${count}`, expires_in: 3600 });
  });
  const tokens = createGoogleAccessTokenSource({
    serviceAccount,
    scope: otherScope,
    fetch: google.fetch,
    now: () => start,
  });
  // An aborted signal starts no request.
  const reason = new Error('the caller gave up');
  await assert.rejects(tokens.get(AbortSignal.abort(reason)), (error) => error === reason);
  assert.equal(google.exchanges.length, 0);
  const leaving = new AbortController();
  const first = tokens.get();
  const second = tokens.get();
  const leaver = tokens.get(leaving.signal);
  while (release === undefined) {
    await tick();
  }
  leaving.abort(reason);
  await assert.rejects(leaver, (error) => error === reason);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['token-1', 'token-1']);
  // The shared request went on, and its token is cached.
  assert.equal(await tokens.get(new AbortController().signal), 'token-1');
  assert.equal(google.exchanges.length, 1);
}

// Each token request is bounded in time, even when the fetch ignores its signal.
{
  let started = Date.now();
  const silent = fakeGoogle(() => new Promise<Response>(() => undefined));
  const hung = createGoogleAccessTokenSource({
    serviceAccount,
    scope: otherScope,
    fetch: silent.fetch,
    timeoutMs: 50,
  });
  await assert.rejects(hung.get(), { code: 'TOKEN_NETWORK_ERROR', retryable: true });
  assert.ok(Date.now() - started < 5_000, 'a silent token endpoint answers at the timeout');
  assert.equal(silent.exchanges[0]?.init.signal?.aborted, true, 'the request is told to stop');
  // An answer that comes after the deadline anyway is cancelled, not left open.
  let answerLate: ((response: Response) => void) | undefined;
  let lateCancelled = false;
  const late = fakeGoogle(
    () =>
      new Promise<Response>((resolve) => {
        answerLate = resolve;
      }),
  );
  await assert.rejects(
    createGoogleAccessTokenSource({
      serviceAccount,
      scope: otherScope,
      fetch: late.fetch,
      timeoutMs: 50,
    }).get(),
    { code: 'TOKEN_NETWORK_ERROR' },
  );
  while (answerLate === undefined) {
    await tick();
  }
  answerLate(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          lateCancelled = true;
        },
      }),
    ),
  );
  await tick();
  assert.equal(lateCancelled, true, 'a late answer is cancelled');
  // A body that stalls after its first bytes is bounded by the same timeout, and cancelled.
  let cancelled = false;
  const stalling = fakeGoogle(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"access_token":"tok'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  started = Date.now();
  await assert.rejects(
    createGoogleAccessTokenSource({
      serviceAccount,
      scope: otherScope,
      fetch: stalling.fetch,
      timeoutMs: 50,
    }).get(),
    { code: 'TOKEN_NETWORK_ERROR', retryable: true },
  );
  assert.ok(Date.now() - started < 5_000, 'a stalled body answers at the timeout');
  await tick();
  assert.equal(cancelled, true, 'the stalled body is cancelled');
}

// A token request that never settles (its request context ended) is given up after its timeout.
{
  let clock = start;
  const google = fakeGoogle((_exchange, count) =>
    count === 1
      ? new Promise<Response>(() => undefined)
      : Response.json({ access_token: `token-${count}`, expires_in: 3600 }),
  );
  const tokens = createGoogleAccessTokenSource({
    serviceAccount,
    scope: otherScope,
    fetch: google.fetch,
    now: () => clock,
    timeoutMs: 1_000,
  });
  const first = tokens.get();
  while (google.exchanges.length === 0) {
    await tick();
  }
  // By the source's clock the first request is past its timeout and a second
  // later, as if its timer had never run.
  clock += 2_000;
  assert.equal(await tokens.get(), 'token-2');
  assert.equal(google.exchanges.length, 2);
  await assert.rejects(first, { code: 'TOKEN_NETWORK_ERROR' });
  // The abandoned request's failure does not displace the newer token.
  assert.equal(await tokens.get(), 'token-2');
  assert.equal(google.exchanges.length, 2);
}

// A caller already waiting on such a request stops at its deadline by its own
// timer, and drops the request so the next caller starts a new one.
{
  let clock = start;
  let answerFirst: ((response: Response) => void) | undefined;
  const google = fakeGoogle((_exchange, count) =>
    count === 1
      ? new Promise<Response>((resolve) => {
          answerFirst = resolve;
        })
      : Response.json({ access_token: `token-${count}`, expires_in: 3600 }),
  );
  const tokens = createGoogleAccessTokenSource({
    serviceAccount,
    scope: otherScope,
    fetch: google.fetch,
    now: () => clock,
    // The request's own timer stays out of this test; the waiter's ends it.
    timeoutMs: 60_000,
  });
  const first = tokens.get();
  while (answerFirst === undefined) {
    await tick();
  }
  // By the source's clock the request is 50 ms from being given up.
  clock += 60_950;
  const started = Date.now();
  await assert.rejects(tokens.get(), { code: 'TOKEN_NETWORK_ERROR', retryable: true });
  assert.ok(Date.now() - started < 5_000, 'a waiter is released at the deadline');
  // No failure is remembered: the next caller starts a new request at once.
  assert.equal(await tokens.get(), 'token-2');
  assert.equal(google.exchanges.length, 2);
  // The dropped request answers after all: its caller gets that token, the cache keeps the newer.
  answerFirst(Response.json({ access_token: 'late-token', expires_in: 3600 }));
  assert.equal(await first, 'late-token');
  assert.equal(await tokens.get(), 'token-2');
}

// Answers are bounded in size, and an oversized body is cancelled.
{
  for (const status of [200, 400]) {
    let cancelled = false;
    let pulled = 0;
    const google = fakeGoogle(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new TextEncoder().encode(' '.repeat(4096)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status },
        ),
    );
    await assert.rejects(
      createGoogleAccessTokenSource({ serviceAccount, scope: otherScope, fetch: google.fetch }).get(),
      { code: status === 200 ? 'TOKEN_MALFORMED_RESPONSE' : 'TOKEN_HTTP_400' },
    );
    await tick();
    assert.equal(cancelled, true, `an endless ${status} body is cancelled`);
    assert.ok(pulled < 10, 'reading stops past 16 KiB');
  }
}

// Errors show a code, never the key, the signed assertion, the token, or Google's answer.
{
  const cases: readonly {
    readonly name: string;
    readonly answer: (exchange: Exchange) => Response | Promise<Response>;
    readonly code: string;
    readonly retryable: boolean;
    readonly retryAfterSeconds?: number;
    readonly secrets?: readonly string[];
  }[] = [
    {
      name: 'a fetch error that quotes the request',
      answer: (exchange) => {
        throw new TypeError(`fetch failed: ${String(exchange.init.body)}`);
      },
      code: 'TOKEN_NETWORK_ERROR',
      retryable: true,
    },
    {
      name: 'a refusal that echoes the assertion and a token',
      answer: (exchange) =>
        Response.json(
          {
            error: 'invalid_grant',
            error_description: `bad ${assertionOf(exchange)}`,
            access_token: 'leaked-token-in-refusal',
          },
          { status: 400 },
        ),
      code: 'TOKEN_INVALID_GRANT',
      retryable: false,
      secrets: ['leaked-token-in-refusal'],
    },
    {
      name: 'an outage',
      answer: () => new Response('upstream detail', { status: 503, headers: { 'retry-after': '7' } }),
      code: 'TOKEN_HTTP_503',
      retryable: true,
      retryAfterSeconds: 7,
      secrets: ['upstream detail'],
    },
    {
      name: 'an answer that is not JSON but holds a token',
      answer: () => new Response('ya29.token-in-a-broken-body {', { status: 200 }),
      code: 'TOKEN_MALFORMED_RESPONSE',
      retryable: true,
      secrets: ['token-in-a-broken-body'],
    },
    {
      name: 'a token that would inject a header',
      answer: () => Response.json({ access_token: 'token-with\r\nx-evil: 1', expires_in: 3600 }),
      code: 'TOKEN_MALFORMED_RESPONSE',
      retryable: true,
      secrets: ['token-with'],
    },
    {
      name: 'a token that is not a bearer token',
      answer: () =>
        Response.json({ access_token: 'mac-token-value', token_type: 'mac', expires_in: 3600 }),
      code: 'TOKEN_MALFORMED_RESPONSE',
      retryable: true,
      secrets: ['mac-token-value'],
    },
    {
      name: 'a token too long for a header',
      answer: () => Response.json({ access_token: 'a'.repeat(8193), expires_in: 3600 }),
      code: 'TOKEN_MALFORMED_RESPONSE',
      retryable: true,
      secrets: ['a'.repeat(64)],
    },
    {
      name: 'a redirect the fetch followed',
      answer: () => {
        const followed = Response.json({ access_token: 'token-from-elsewhere', expires_in: 3600 });
        Object.defineProperty(followed, 'redirected', { value: true });
        return followed;
      },
      code: 'TOKEN_REDIRECTED',
      retryable: false,
      secrets: ['token-from-elsewhere'],
    },
    {
      name: 'a redirect the fetch did not follow',
      answer: () =>
        new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } }),
      code: 'TOKEN_HTTP_302',
      retryable: false,
    },
  ];
  for (const failure of cases) {
    let clock = start;
    const google = fakeGoogle((exchange) => failure.answer(exchange));
    const tokens = createGoogleAccessTokenSource({
      serviceAccount,
      scope: otherScope,
      fetch: google.fetch,
      now: () => clock,
    });
    let caught: unknown;
    try {
      await tokens.get();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof GoogleAccessTokenError, failure.name);
    assert.equal(caught.name, 'GoogleAccessTokenError');
    assert.equal(
      caught.message,
      `Google access token request failed: ${failure.code}.`,
      failure.name,
    );
    assert.equal(caught.code, failure.code, failure.name);
    assert.equal(caught.retryable, failure.retryable, failure.name);
    assert.equal(caught.retryAfterSeconds, failure.retryAfterSeconds, failure.name);
    assert.equal(caught.cause, undefined, failure.name);
    assertRedacted(caught, [
      keyMaterial,
      assertionOf(google.exchanges[0]),
      ...(failure.secrets ?? []),
    ]);
    // No token was kept: once the failure stops answering, a new request is made.
    clock += 30_001;
    await tokens.get().catch(() => undefined);
    assert.equal(google.exchanges.length, 2, failure.name);
  }
  // A key that cannot sign: the cause names the step and holds no key material.
  const google = fakeGoogle();
  await assert.rejects(
    createGoogleAccessTokenSource({
      serviceAccount: { ...serviceAccount, privateKey: pemOf(keyBase64.slice(0, 200)) },
      scope: otherScope,
      fetch: google.fetch,
    }).get(),
    (error: unknown) => {
      assert.ok(error instanceof GoogleAccessTokenError);
      assert.equal(error.code, 'TOKEN_KEY_UNUSABLE');
      assert.equal(error.retryable, false);
      assert.ok(error.cause instanceof TypeError);
      assert.match(error.cause.message, /^The Google service account private key/u);
      assertRedacted(error, [keyBase64.slice(100, 164)]);
      return true;
    },
  );
  assert.equal(google.exchanges.length, 0);
}

console.info('Google access token source tests passed.');

/** Everything an error shows: its text, stack, and fields, and its causes'. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    parts.push(String(current), current.stack ?? '', JSON.stringify({ ...current }));
    current = current.cause;
  }
  return parts.join('\n');
}

function assertRedacted(error: unknown, secrets: readonly string[]): void {
  const text = errorText(error);
  for (const secret of secrets) {
    assert.ok(secret.length >= 4, 'a secret to look for');
    assert.ok(!text.includes(secret), `an error shows ${JSON.stringify(secret.slice(0, 12))}…`);
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replace(/-/gu, '+').replace(/_/gu, '/');
  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as Record<
    string,
    unknown
  >;
}

async function verifyJwt(
  assertion: string,
): Promise<{ readonly header: unknown; readonly claims: Record<string, unknown> }> {
  const [header = '', claims = '', signature = ''] = assertion.split('.');
  const bytes = Uint8Array.from(
    atob(
      signature.replace(/-/gu, '+').replace(/_/gu, '/')
        + '='.repeat((4 - (signature.length % 4)) % 4),
    ),
    (char) => char.charCodeAt(0),
  );
  assert.ok(
    await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      keys.publicKey,
      bytes,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
    'the JWT verifies with the service account key',
  );
  return { header: decodeSegment(header), claims: decodeSegment(claims) };
}

function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 1);
  });
}

/** A PEM block of a key generated by this test; the markers are joined at run time. */
function pemOf(base64: string): string {
  const label = ['PRIVATE', 'KEY'].join(' ');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}
