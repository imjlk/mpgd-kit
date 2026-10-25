import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createGuestSessionCoordinator,
  createGuestSessionHttpBackend,
  guestIdentityHttpRoutes,
} from '@mpgd/game-services/guest-session';
import type { SecureCredentialStore } from '@mpgd/platform';

import { deriveAppAccountToken, deriveObfuscatedAccountId } from './accountBinding.js';
import {
  createIdentityBindings,
  createIdentityFetchHandler,
  identityRequestBodyLimitBytes,
  resolveIdentityService,
  type GameIdentityWorkerEnv,
} from './handler.js';
import { createMemoryIdentityStore, type IdentityStore } from './store.js';

const base = 'https://identity.example.test';
const start = Date.parse('2030-01-01T00:00:00.000Z');

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function read(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const env: GameIdentityWorkerEnv = { MPGD_STORE: 'memory' };

// Routes, statuses, and headers.
{
  const store = createMemoryIdentityStore();
  let clock = start;
  const fetch = createIdentityFetchHandler(env, { store, now: () => clock });
  const issuedResponse = await fetch(
    post(guestIdentityHttpRoutes.issueGuest, { installationId: 'install-http-1' }),
  );
  assert.equal(issuedResponse.headers.get('cache-control'), 'no-store');
  assert.equal(issuedResponse.headers.get('access-control-allow-origin'), '*');
  const issued = await read(issuedResponse);
  assert.equal(issued.status, 200);
  assert.equal(issued.body.identityLevel, 'guest');
  const refreshed = await read(await fetch(post(guestIdentityHttpRoutes.refresh, {
    refreshToken: issued.body.refreshToken,
  })));
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.sessionFamilyId, issued.body.sessionFamilyId);
  clock += 8 * 24 * 60 * 60_000; // past the 7-day retry grace
  assert.deepEqual(await read(await fetch(post(guestIdentityHttpRoutes.refresh, {
    refreshToken: issued.body.refreshToken,
  }))), { status: 401, body: { error: 'GUEST_SESSION_REJECTED' } });
  assert.deepEqual(
    await read(await fetch(post(guestIdentityHttpRoutes.revoke, { refreshToken: 'unknown' }))),
    {
      status: 200,
      body: {},
    },
  );
  assert.deepEqual(await read(await fetch(post(guestIdentityHttpRoutes.bindAccount, {
    refreshToken: refreshed.body.refreshToken,
    externalProof: 'proof',
    idempotencyKey: 'bind-1',
  }))), { status: 501, body: { error: 'ACCOUNT_BINDING_UNSUPPORTED' } });
  assert.deepEqual(
    await read(await fetch(post(guestIdentityHttpRoutes.issueGuest, { installationId: 'x' }))),
    {
      status: 400,
      body: { error: 'INVALID_REQUEST' },
    },
  );
  for (const body of ['not json', '[]', 'null', 'x'.repeat(identityRequestBodyLimitBytes + 1)]) {
    assert.equal((await fetch(post(guestIdentityHttpRoutes.issueGuest, body))).status, 400);
  }
  const wrongMethod = await fetch(new Request(`${base}${guestIdentityHttpRoutes.refresh}`));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
  assert.equal(
    (await fetch(new Request(`${base}/identity/v1/other`, { method: 'POST' }))).status,
    404,
  );
  const preflight = await fetch(
    new Request(`${base}${guestIdentityHttpRoutes.refresh}`, { method: 'OPTIONS' }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(preflight.headers.get('access-control-max-age'), '86400');
}

// The address limit runs before the store, keyed by the client address only.
{
  const keys: string[] = [];
  let allow = true;
  const limited: GameIdentityWorkerEnv = {
    MPGD_STORE: 'memory',
    IDENTITY_ISSUE_RATE_LIMITER: {
      async limit({ key }) {
        keys.push(key);
        return { success: allow };
      },
    },
  };
  const fetch = createIdentityFetchHandler(limited, {
    store: createMemoryIdentityStore(),
    now: () => start,
  });
  const request = () =>
    post(
      guestIdentityHttpRoutes.issueGuest,
      { installationId: 'install-http-2' },
      { 'CF-Connecting-IP': '203.0.113.7' },
    );
  assert.equal((await fetch(request())).status, 200);
  allow = false;
  assert.deepEqual(await read(await fetch(request())), {
    status: 429,
    body: { error: 'RATE_LIMITED' },
  });
  assert.deepEqual(keys, ['guest:203.0.113.7', 'guest:203.0.113.7']);
  // Refreshes are not limited by address.
  assert.equal(
    (await fetch(post(guestIdentityHttpRoutes.refresh, { refreshToken: 'x' }))).status,
    401,
  );
  assert.equal(keys.length, 2);
}

// A store or configuration failure is 503 UNAVAILABLE, logged by name only.
{
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const broken = {
      async createGuest() {
        throw new TypeError('D1_ERROR with mpgd_rt_secret');
      },
    } as unknown as IdentityStore;
    const fetch = createIdentityFetchHandler(env, { store: broken });
    assert.deepEqual(
      await read(await fetch(post(guestIdentityHttpRoutes.issueGuest, { installationId: 'install-http-3' }))),
      { status: 503, body: { error: 'UNAVAILABLE' } },
    );
    for (const misconfigured of [
      {},
      { MPGD_STORE: 'd1' },
      { MPGD_STORE: 'memory', IDENTITY_REFRESH_IDLE_DAYS: 'soon' },
      { MPGD_STORE: 'memory', IDENTITY_ACCESS_TOKEN_TTL_SECONDS: '0' },
    ] as const satisfies readonly GameIdentityWorkerEnv[]) {
      const response = await createIdentityFetchHandler(misconfigured)(
        new Request(`http://localhost:8788${guestIdentityHttpRoutes.issueGuest}`, {
          method: 'POST',
          body: JSON.stringify({ installationId: 'install-http-4' }),
        }),
      );
      assert.equal(response.status, 503);
    }
    assert.equal(JSON.stringify(errors).includes('mpgd_rt_secret'), false);
    assert.deepEqual(errors[0], ['[identity] request failed:', 'TypeError']);
    // A configuration error says which setting, so the 503 can be fixed from the log.
    assert.deepEqual(
      errors.slice(1).map((args) => String(args[1]).split(':')[0]),
      [
        'IdentityConfigurationError',
        'IdentityConfigurationError',
        'IdentityConfigurationError',
        'IdentityConfigurationError',
      ],
    );
    assert.match(String(errors[3]?.[1]), /IDENTITY_REFRESH_IDLE_DAYS must be a whole number/u);
    // A short inactivity window alone is accepted: the default grace stays inside it.
    const shortWindow = await createIdentityFetchHandler({ MPGD_STORE: 'memory', IDENTITY_REFRESH_IDLE_DAYS: '2' })(
      new Request(`http://localhost:8788${guestIdentityHttpRoutes.issueGuest}`, {
        method: 'POST',
        body: JSON.stringify({ installationId: 'install-http-6' }),
      }),
    );
    assert.equal(shortWindow.status, 200);
  } finally {
    console.error = original;
  }
}

// The memory store serves local development hosts only.
{
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const fetch = createIdentityFetchHandler({ MPGD_STORE: 'memory' });
    const body = { installationId: 'install-http-5' };
    assert.deepEqual(await read(await fetch(post(guestIdentityHttpRoutes.issueGuest, body))), {
      status: 503,
      body: { error: 'UNAVAILABLE' },
    });
    assert.match(String(errors[0]?.[0]), /local development hosts only/u);
    for (const host of ['http://localhost:8788', 'http://10.0.2.2:8788', 'http://game.localhost']) {
      const response = await fetch(
        new Request(`${host}${guestIdentityHttpRoutes.issueGuest}`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
      assert.equal(response.status, 200);
    }
  } finally {
    console.error = original;
  }
}

// The service bindings the game-services Worker calls.
{
  const store = createMemoryIdentityStore();
  const ended: string[] = [];
  const service = resolveIdentityService(
    {
      MPGD_STORE: 'memory',
      GAME_SERVICES: {
        async endNotificationSession({ sessionId }) {
          ended.push(sessionId);
          return { ok: true, value: { unbound: 1 } };
        },
      },
    },
    { store, now: () => start },
  );
  const bindings = createIdentityBindings(service);
  const issued = await service.issueGuest({ installationId: 'install-binding-1' });
  assert.ok(issued.ok);
  const authorization = `Bearer ${issued.value.accessToken}`;
  assert.deepEqual(await bindings.ingressAuth.authenticateGameServicesRequest({ authorization }), {
    playerId: issued.value.serverUserId,
  });
  assert.deepEqual(
    await bindings.notificationSessions.authenticateNotificationSession({ authorization }),
    {
      playerId: issued.value.serverUserId,
      sessionId: issued.value.sessionFamilyId,
      installationId: 'install-binding-1',
      expiresAt: '2030-06-30T00:00:00.000Z',
    },
  );
  assert.equal(
    await bindings.googlePlayAccountBinding.resolveObfuscatedAccountId({ playerId: issued.value.serverUserId }),
    await deriveObfuscatedAccountId(issued.value.serverUserId),
  );
  assert.equal(
    await bindings.appStoreAccountBinding.resolveAppAccountToken({ playerId: issued.value.serverUserId }),
    await deriveAppAccountToken(issued.value.serverUserId),
  );
  for (const unknown of ['Bearer nope', '']) {
    assert.equal(
      await bindings.ingressAuth.authenticateGameServicesRequest({ authorization: unknown }),
      null,
    );
    assert.equal(
      await bindings.notificationSessions.authenticateNotificationSession({ authorization: unknown }),
      null,
    );
  }
  assert.equal(
    await bindings.googlePlayAccountBinding.resolveObfuscatedAccountId({ playerId: 'ios-local-player' }),
    null,
  );
  assert.equal(
    await bindings.appStoreAccountBinding.resolveAppAccountToken({ playerId: 'ios-local-player' }),
    null,
  );
  // Logout ends the notification session through the game-services binding.
  await service.revoke({ refreshToken: issued.value.refreshToken });
  assert.deepEqual(ended, [issued.value.sessionFamilyId]);
  assert.equal(await bindings.ingressAuth.authenticateGameServicesRequest({ authorization }), null);

  // A `{ ok: false }` answer from the game-services Worker is logged, not thrown.
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const failing = resolveIdentityService(
      {
        MPGD_STORE: 'memory',
        GAME_SERVICES: {
          async endNotificationSession() {
            return { ok: false, error: { code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' } };
          },
        },
      },
      { store, now: () => start },
    );
    const other = await failing.issueGuest({ installationId: 'install-binding-2' });
    assert.ok(other.ok);
    await failing.revoke({ refreshToken: other.value.refreshToken });
    assert.deepEqual(warnings, [['[identity] endNotificationSession failed: Error']]);
  } finally {
    console.warn = original;
  }
}

// The coordinator over the HTTP backend against this Worker, end to end on the client side.
{
  const store = createMemoryIdentityStore();
  let clock = start;
  const worker = createIdentityFetchHandler(env, { store, now: () => clock });
  const values = new Map<string, string>();
  const credentials: SecureCredentialStore = {
    async load({ key }) {
      return values.get(key) ?? null;
    },
    async save({ key, value }) {
      values.set(key, value);
    },
    async remove({ key }) {
      values.delete(key);
    },
  };
  const backend = createGuestSessionHttpBackend({
    baseUrl: base,
    fetch: ((request: Request) => worker(request)) as typeof globalThis.fetch,
  });
  const coordinator = createGuestSessionCoordinator({
    backend,
    credentials,
    installationId: 'install-client-1',
    now: () => clock,
  });
  const first = await coordinator.start();
  clock += 20 * 60_000;
  const refreshed = await coordinator.refresh();
  assert.equal(refreshed.serverUserId, first.serverUserId);
  assert.equal(refreshed.sessionFamilyId, first.sessionFamilyId);
  // A restart restores the same player and family from secure storage.
  const restarted = createGuestSessionCoordinator({
    backend,
    credentials,
    installationId: 'install-client-1',
    now: () => clock,
  });
  const restored = await restarted.start();
  assert.equal(restored.serverUserId, first.serverUserId);
  assert.equal(restored.sessionFamilyId, first.sessionFamilyId);
  // The first coordinator's token was rotated away by the restart: using it is a replay,
  // which ends the family for both.
  clock += 8 * 24 * 60 * 60_000; // past the 7-day retry grace
  await assert.rejects(coordinator.refresh(), { code: 'GUEST_SESSION_REJECTED' });
  await assert.rejects(restarted.refresh(), { code: 'GUEST_SESSION_REJECTED' });
  // Logout clears the dead token; the next start is a new guest.
  await restarted.logout();
  const fresh = await createGuestSessionCoordinator({
    backend,
    credentials,
    installationId: 'install-client-1',
    now: () => clock,
  }).start();
  assert.notEqual(fresh.serverUserId, first.serverUserId);
}

// A refresh that lost a race answers 503 UNAVAILABLE (retry), never 401.
{
  const store = createMemoryIdentityStore();
  let hold: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const paused: IdentityStore = {
    ...store,
    async rotate(input) {
      if (hold !== undefined) {
        const wait = hold;
        hold = undefined;
        entered?.();
        await wait;
      }
      return store.rotate(input);
    },
  };
  const fetch = createIdentityFetchHandler(env, { store: paused, now: () => start });
  const issued = await read(
    await fetch(post(guestIdentityHttpRoutes.issueGuest, { installationId: 'install-http-race' })),
  );
  let release: (() => void) | undefined;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredRotate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const abandoned = fetch(
    post(guestIdentityHttpRoutes.refresh, { refreshToken: issued.body.refreshToken }),
  );
  await enteredRotate;
  const second = await read(
    await fetch(post(guestIdentityHttpRoutes.refresh, { refreshToken: issued.body.refreshToken })),
  );
  await fetch(post(guestIdentityHttpRoutes.refresh, { refreshToken: second.body.refreshToken }));
  release?.();
  assert.deepEqual(await read(await abandoned), { status: 503, body: { error: 'UNAVAILABLE' } });
}

// The [[ratelimits]] binding wrangler.toml recommends needs Wrangler 4.36.0 or later
// (developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): the declared
// range must not admit an older Wrangler.
{
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    readonly devDependencies: Readonly<Record<string, string>>;
  };
  const wranglerConfig = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(wranglerConfig, /\[\[ratelimits\]\]/u);
  const range = /^\^(\d+)\.(\d+)\.(\d+)$/u.exec(manifest.devDependencies.wrangler ?? '');
  assert.ok(range !== null, 'wrangler is a caret range');
  const [major, minor] = [Number(range[1]), Number(range[2])];
  assert.ok(
    major > 4 || (major === 4 && minor >= 36),
    `wrangler ${manifest.devDependencies.wrangler} admits < 4.36.0`,
  );
}

console.info('Guest identity Worker HTTP routes and bindings passed.');
