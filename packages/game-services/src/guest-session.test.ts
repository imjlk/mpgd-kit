import type { SecureCredentialStore } from '@mpgd/platform';

import type { GameServicesNotificationIdentity } from './notifications/client.js';
import type { GameServicesHeaderResolver } from './request-headers.js';

import {
  createGuestServerSession,
  createGuestSessionCoordinator,
  createGuestSessionHttpBackend,
  guestIdentityHttpRoutes,
  GuestSessionCoordinatorError,
  GuestSessionHttpError,
  GuestSessionRejectedError,
  type GuestSessionBackend,
  type ServerGuestSessionCredentials,
} from './guest-session.js';

function matchesError(error: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) {
    return error instanceof Error && expected.test(error.message);
  }
  if (typeof expected === 'function') {
    return error instanceof expected;
  }
  if (typeof expected === 'object' && expected !== null && 'code' in expected) {
    return typeof error === 'object' && error !== null && 'code' in error
      && error.code === expected.code;
  }
  return false;
}

const assert = {
  equal(actual: unknown, expected: unknown, message = 'Expected equal values'): void {
    if (!Object.is(actual, expected)) {
      throw new Error(message);
    }
  },
  notEqual(actual: unknown, expected: unknown): void {
    if (Object.is(actual, expected)) {
      throw new Error('Expected unequal values');
    }
  },
  deepEqual(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  throws(operation: () => unknown, expected: unknown): void {
    try {
      operation();
    } catch (error) {
      if (matchesError(error, expected)) {
        return;
      }
      throw error;
    }
    throw new Error('Expected operation to throw');
  },
  async rejects(operation: Promise<unknown>, expected: unknown): Promise<void> {
    try {
      await operation;
    } catch (error) {
      if (matchesError(error, expected)) {
        return;
      }
      throw error;
    }
    throw new Error('Expected promise to reject');
  },
};

const now = () => Date.parse('2030-01-01T00:00:00.000Z');
const expires = '2030-01-01T01:00:00.000Z';

function session(
  accessToken: string,
  refreshToken: string,
  identityLevel: 'guest' | 'authenticated' = 'guest',
  serverUserId = 'server-user-1',
  sessionId = 'server-session-1',
): ServerGuestSessionCredentials {
  return {
    serverUserId,
    sessionId,
    identityLevel,
    accessToken,
    refreshToken,
    accessExpiresAt: expires,
  };
}

function credentialFixture() {
  const values = new Map<string, string>();
  let failLoad = false;
  let failSave = false;
  let failRemove = false;
  const credentials: SecureCredentialStore = {
    async load({ key }) {
      if (failLoad) {
        throw new Error('native load failed');
      }
      return values.get(key) ?? null;
    },
    async save({ key, value }) {
      if (failSave) {
        throw new Error('native save failed');
      }
      values.set(key, value);
    },
    async remove({ key }) {
      if (failRemove) {
        throw new Error('native remove failed');
      }
      values.delete(key);
    },
  };
  return {
    credentials,
    values,
    failNextLoad() {
      failLoad = true;
    },
    recoverLoad() {
      failLoad = false;
    },
    failNextSave() {
      failSave = true;
    },
    failNextRemove() {
      failRemove = true;
    },
    recoverRemove() {
      failRemove = false;
    },
  };
}

function backendFixture() {
  const calls = { issue: 0, refresh: 0, revoke: [] as string[], bind: [] as string[] };
  let bindResult: Awaited<ReturnType<GuestSessionBackend['bindAccount']>> = { status: 'conflict' };
  const backend: GuestSessionBackend = {
    async issueGuest({ installationId }) {
      assert.equal(installationId, 'local-install-1');
      calls.issue += 1;
      return session('access-1', 'refresh-1');
    },
    async refresh({ refreshToken }) {
      calls.refresh += 1;
      return session(`access-${calls.refresh + 1}`, `refresh-${calls.refresh + 1}`);
    },
    async revoke({ refreshToken }) {
      calls.revoke.push(refreshToken);
    },
    async bindAccount({ refreshToken, externalProof, idempotencyKey }) {
      calls.bind.push(`${refreshToken}:${externalProof}:${idempotencyKey}`);
      return bindResult;
    },
  };
  return {
    backend,
    calls,
    setBindResult(result: Awaited<ReturnType<GuestSessionBackend['bindAccount']>>) {
      bindResult = result;
    },
  };
}

{
  const native = credentialFixture();
  const server = backendFixture();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  const view = await coordinator.start();
  assert.equal(view.serverUserId, 'server-user-1');
  assert.notEqual(view.serverUserId, 'local-install-1');
  assert.equal(Object.hasOwn(view, 'accessToken'), false);
  assert.equal(Object.hasOwn(view, 'refreshToken'), false);
  assert.equal(native.values.get('mpgd.guest.refresh'), 'refresh-1');
  assert.deepEqual(coordinator.getHeaders(), { authorization: 'Bearer access-1' });
  assert.equal((await coordinator.start()).sessionId, view.sessionId);
  assert.equal(server.calls.issue, 1);
  await coordinator.logout();
  assert.deepEqual(server.calls.revoke, ['refresh-1']);
  assert.equal(native.values.size, 0);
  assert.throws(() => coordinator.getHeaders(), { code: 'GUEST_SESSION_CLOSED' });
  await assert.rejects(coordinator.start(), { code: 'GUEST_SESSION_CLOSED' });
  await assert.rejects(coordinator.refresh(), { code: 'GUEST_SESSION_CLOSED' });
  await assert.rejects(
    coordinator.bindAccount({
      externalProof: 'proof',
      idempotencyKey: 'closed-bind',
    }),
    { code: 'GUEST_SESSION_CLOSED' },
  );
}

{
  const native = credentialFixture();
  const server = backendFixture();
  native.failNextLoad();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await assert.rejects(coordinator.start(), { code: 'GUEST_SESSION_CREDENTIAL_LOAD_FAILED' });
  assert.equal(server.calls.issue, 0, 'credential loss must not silently mint a new guest');
  native.recoverLoad();
  assert.equal((await coordinator.start()).serverUserId, 'server-user-1');
}

{
  const native = credentialFixture();
  const server = backendFixture();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  const [first, second] = await Promise.all([coordinator.refresh(), coordinator.refresh()]);
  assert.deepEqual(first, second);
  assert.equal(server.calls.refresh, 1, 'concurrent refresh must share one backend call');
  assert.equal(native.values.get('mpgd.guest.refresh'), 'refresh-2');
  assert.deepEqual(coordinator.getHeaders(), { authorization: 'Bearer access-2' });

  server.setBindResult({ status: 'conflict' });
  assert.deepEqual(await coordinator.bindAccount({
    externalProof: 'verified-proof', idempotencyKey: 'bind-1',
  }), { status: 'conflict' });
  assert.equal(coordinator.getHeaders().authorization, 'Bearer access-2');
  assert.deepEqual(server.calls.bind, ['refresh-2:verified-proof:bind-1']);

  server.setBindResult({
    status: 'bound',
    session: session('foreign-access', 'foreign-refresh', 'authenticated', 'another-user'),
  });
  await assert.rejects(
    coordinator.bindAccount({
      externalProof: 'other-proof',
      idempotencyKey: 'bind-2',
    }),
    { code: 'GUEST_SESSION_OWNERSHIP_CONFLICT' },
  );
  assert.equal(coordinator.getHeaders().authorization, 'Bearer access-2');
  assert.equal(native.values.get('mpgd.guest.refresh'), 'refresh-2');

  server.setBindResult({
    status: 'bound',
    session: session(
      'bound-access',
      'bound-refresh',
      'authenticated',
      'server-user-1',
      'server-session-2',
    ),
  });
  assert.deepEqual(await coordinator.bindAccount({
    externalProof: 'owned-proof', idempotencyKey: 'bind-3',
  }), { status: 'bound' });
  assert.equal(coordinator.getHeaders().authorization, 'Bearer bound-access');
  assert.equal(native.values.get('mpgd.guest.refresh'), 'bound-refresh');
  assert.equal((await coordinator.start()).sessionId, 'server-session-2');

  server.setBindResult({
    status: 'already-bound',
    session: session(
      'retry-access',
      'retry-refresh',
      'authenticated',
      'server-user-1',
      'server-session-3',
    ),
  });
  assert.deepEqual(await coordinator.bindAccount({
    externalProof: 'owned-proof', idempotencyKey: 'bind-3',
  }), { status: 'already-bound' });
  assert.equal(coordinator.getHeaders().authorization, 'Bearer retry-access');
  assert.equal(native.values.get('mpgd.guest.refresh'), 'retry-refresh');
  assert.equal((await coordinator.start()).sessionId, 'server-session-3');
}

{
  const native = credentialFixture();
  const server = backendFixture();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  native.failNextSave();
  await assert.rejects(coordinator.refresh(), {
    code: 'GUEST_SESSION_CREDENTIAL_SAVE_FAILED',
  });
  assert.throws(() => coordinator.getHeaders(), { code: 'GUEST_SESSION_NOT_READY' });
  await coordinator.logout();
  assert.deepEqual(server.calls.revoke, ['refresh-2']);
  assert.equal(native.values.size, 0);
}

{
  const native = credentialFixture();
  let completeRefresh: ((value: ServerGuestSessionCredentials) => void) | undefined;
  let enteredRefresh: (() => void) | undefined;
  const refreshEntered = new Promise<void>((resolve) => {
    enteredRefresh = resolve;
  });
  const server = backendFixture();
  const backend: GuestSessionBackend = {
    ...server.backend,
    refresh() {
      enteredRefresh?.();
      return new Promise<ServerGuestSessionCredentials>((resolve) => {
        completeRefresh = resolve;
      });
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  const refreshing = coordinator.refresh();
  await refreshEntered;
  const loggingOut = coordinator.logout();
  assert.throws(() => coordinator.getHeaders(), { code: 'GUEST_SESSION_CLOSED' });
  completeRefresh?.(session('late-access', 'late-refresh'));
  await assert.rejects(refreshing, { code: 'GUEST_SESSION_CLOSED' });
  await loggingOut;
  assert.deepEqual(server.calls.revoke, ['late-refresh']);
  assert.equal(native.values.size, 0);
}

{
  const native = credentialFixture();
  const server = backendFixture();
  let failRevoke = true;
  const backend: GuestSessionBackend = {
    ...server.backend,
    async revoke(input) {
      if (failRevoke) {
        failRevoke = false;
        throw new Error('sensitive refresh token');
      }
      await server.backend.revoke(input);
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  await assert.rejects(coordinator.logout(), { code: 'GUEST_SESSION_LOGOUT_UNCERTAIN' });
  assert.equal(native.values.get('mpgd.guest.refresh'), 'refresh-1');
  assert.throws(() => coordinator.getHeaders(), { code: 'GUEST_SESSION_CLOSED' });
  await coordinator.logout();
  assert.deepEqual(server.calls.revoke, ['refresh-1']);
  assert.equal(native.values.size, 0);
}

{
  const native = credentialFixture();
  const server = backendFixture();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  native.failNextRemove();
  await assert.rejects(coordinator.logout(), { code: 'GUEST_SESSION_LOGOUT_UNCERTAIN' });
  assert.equal(native.values.get('mpgd.guest.refresh'), 'refresh-1');
  native.recoverRemove();
  await coordinator.logout();
  assert.deepEqual(server.calls.revoke, ['refresh-1', 'refresh-1']);
  assert.equal(native.values.size, 0);
}

{
  const native = credentialFixture();
  native.values.set('mpgd.guest.refresh', 'stored-refresh');
  native.failNextLoad();
  const server = backendFixture();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await assert.rejects(coordinator.logout(), { code: 'GUEST_SESSION_LOGOUT_UNCERTAIN' });
  assert.equal(native.values.get('mpgd.guest.refresh'), 'stored-refresh');
  native.recoverLoad();
  await coordinator.logout();
  assert.deepEqual(server.calls.revoke, ['stored-refresh']);
  assert.equal(native.values.size, 0);
}

{
  const native = credentialFixture();
  const backend: GuestSessionBackend = {
    ...backendFixture().backend,
    async issueGuest() {
      throw new Error('secret bearer token');
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  const error: unknown = await coordinator.start().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.equal(error instanceof GuestSessionCoordinatorError, true);
  if (error instanceof GuestSessionCoordinatorError) {
    assert.equal(error.code, 'GUEST_SESSION_BACKEND_FAILED');
    assert.equal(error.message.includes('secret bearer token'), false);
  }
  assert.equal(native.values.size, 0);
}

{
  const native = credentialFixture();
  const backend: GuestSessionBackend = {
    ...backendFixture().backend,
    async issueGuest() {
      return { ...session('access', 'refresh'), accessExpiresAt: '2020-01-01T00:00:00Z' };
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  assert.equal(native.values.get('mpgd.guest.refresh'), 'refresh');
  assert.throws(() => coordinator.getHeaders(), { code: 'GUEST_SESSION_NOT_READY' });
}

{
  const native = credentialFixture();
  const server = backendFixture();
  const backend: GuestSessionBackend = {
    ...server.backend,
    async refresh({ refreshToken }) {
      assert.equal(refreshToken, 'refresh-1');
      return {
        ...session('expired-access', 'rotated-refresh'),
        accessExpiresAt: '2020-01-01T00:00:00Z',
      };
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  await coordinator.refresh();
  assert.equal(native.values.get('mpgd.guest.refresh'), 'rotated-refresh');
  assert.throws(() => coordinator.getHeaders(), { code: 'GUEST_SESSION_NOT_READY' });
}

/**
 * A backend whose answers the test scripts: each issue, refresh, and bind
 * returns the next session, numbered, with the given ids.
 */
/** The ids (and optionally the access expiry) of one scripted session answer. */
type ScriptedSession = {
  readonly sessionId: string;
  readonly sessionFamilyId?: string;
  readonly accessExpiresAt?: string;
};

function familyBackend() {
  let count = 0;
  let refreshCalls = 0;
  const next = (ids: ScriptedSession) => {
    count += 1;
    return {
      ...session(`access-${count}`, `refresh-${count}`),
      ...ids,
    };
  };
  const answers = {
    issue: { sessionId: 'issued-session' } as ScriptedSession,
    refresh: [] as ScriptedSession[],
    bind: { sessionId: 'bound-session' } as ScriptedSession,
  };
  const backend: GuestSessionBackend = {
    async issueGuest() {
      return next(answers.issue);
    },
    async refresh() {
      refreshCalls += 1;
      const ids = answers.refresh.shift();
      if (ids === undefined) {
        throw new Error('no scripted refresh');
      }
      return next(ids);
    },
    async revoke() {},
    async bindAccount() {
      return { status: 'bound', session: { ...next(answers.bind), identityLevel: 'authenticated' } };
    },
  };
  return {
    backend,
    answers,
    /** Sessions answered so far (issue, refresh, and bind). */
    get count() {
      return count;
    },
    /** Refreshes the backend was asked for, answered or not. */
    get refreshCalls() {
      return refreshCalls;
    },
  };
}

// A backend without family ids: refreshes keep the first session id as the family.
{
  const native = credentialFixture();
  const server = familyBackend();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  const seen: string[] = [];
  const unsubscribe = coordinator.onSession((view) =>
    seen.push(`${view.sessionId}/${view.sessionFamilyId}`),
  );
  assert.equal(coordinator.current(), undefined);
  const started = await coordinator.start();
  assert.equal(started.sessionFamilyId, 'issued-session');
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'issued-session');
  server.answers.refresh.push({ sessionId: 'rotated-1' }, { sessionId: 'rotated-2' });
  assert.equal((await coordinator.refresh()).sessionFamilyId, 'issued-session');
  assert.equal((await coordinator.refresh()).sessionId, 'rotated-2');
  assert.equal(coordinator.current()?.sessionFamilyId, 'issued-session');
  assert.equal(coordinator.current()?.sessionId, 'rotated-2');
  assert.deepEqual(seen, [
    'issued-session/issued-session',
    'rotated-1/issued-session',
    'rotated-2/issued-session',
  ]);
  // A bound account under a new session id may be a new family on the backend: start one.
  assert.deepEqual(
    await coordinator.bindAccount({ externalProof: 'proof', idempotencyKey: 'bind-1' }),
    {
      status: 'bound',
    },
  );
  assert.equal(coordinator.current()?.sessionFamilyId, 'bound-session');
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'bound-session');
  // A bind that keeps the session id keeps the family.
  server.answers.bind = { sessionId: 'bound-session' };
  await coordinator.bindAccount({ externalProof: 'proof', idempotencyKey: 'bind-2' });
  assert.equal(coordinator.current()?.sessionFamilyId, 'bound-session');
  unsubscribe();
  server.answers.refresh.push({ sessionId: 'rotated-3' });
  await coordinator.refresh();
  assert.equal(seen.length, 5, 'an unsubscribed listener hears nothing more');
  // Logout removes the saved family with the token.
  await coordinator.logout();
  assert.equal(coordinator.current(), undefined);
  assert.equal(native.values.size, 0);
}

// Restore from secure storage keeps the saved family; a backend family id always wins.
{
  const native = credentialFixture();
  const server = familyBackend();
  const first = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await first.start();
  server.answers.refresh.push({ sessionId: 'rotated-1' });
  await first.refresh();
  // The next launch: a new coordinator over the same storage.
  server.answers.refresh.push({ sessionId: 'restored-session' });
  const second = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  const restored = await second.start();
  assert.equal(restored.sessionId, 'restored-session');
  assert.equal(restored.sessionFamilyId, 'issued-session');
  // The backend names the family: it replaces the derived one, and is saved.
  server.answers.refresh.push({ sessionId: 'rotated-2', sessionFamilyId: 'backend-family' });
  assert.equal((await second.refresh()).sessionFamilyId, 'backend-family');
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'backend-family');
  // A later answer without one continues the backend's family.
  server.answers.refresh.push({ sessionId: 'rotated-3' });
  assert.equal((await second.refresh()).sessionFamilyId, 'backend-family');
}

// Without a readable saved family, a restore starts a family at the restored session id.
{
  const native = credentialFixture();
  native.values.set('mpgd.guest.refresh', 'stored-refresh');
  const server = familyBackend();
  server.answers.refresh.push({ sessionId: 'restored-session' });
  let failFamilyLoad = true;
  const credentials: SecureCredentialStore = {
    ...native.credentials,
    async load(input) {
      if (input.key === 'mpgd.guest.refresh.family' && failFamilyLoad) {
        failFamilyLoad = false;
        throw new Error('native load failed');
      }
      return native.credentials.load(input);
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials,
    installationId: 'local-install-1',
    now,
  });
  assert.equal((await coordinator.start()).sessionFamilyId, 'restored-session');
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'restored-session');
}

// A family saved for an older token is never read for a new guest.
{
  const native = credentialFixture();
  native.values.set('mpgd.guest.refresh.family', 'stale-family');
  const server = familyBackend();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  assert.equal((await coordinator.start()).sessionFamilyId, 'issued-session');
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'issued-session');
}

// A family that cannot be saved is removed, so a restore never reads an older one.
{
  const native = credentialFixture();
  const server = familyBackend();
  const saves: string[] = [];
  let failFamilySave = false;
  const credentials: SecureCredentialStore = {
    ...native.credentials,
    async save(input) {
      if (input.key === 'mpgd.guest.refresh.family' && failFamilySave) {
        throw new Error('native save failed');
      }
      saves.push(input.key);
      return native.credentials.save(input);
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'issued-session');
  // The family is written before its token, and an unchanged family is not written again.
  server.answers.refresh.push({ sessionId: 'rotated-1' });
  await coordinator.refresh();
  assert.deepEqual(saves, [
    'mpgd.guest.refresh.family',
    'mpgd.guest.refresh',
    'mpgd.guest.refresh',
  ]);
  failFamilySave = true;
  await coordinator.bindAccount({ externalProof: 'proof', idempotencyKey: 'bind-1' });
  // The session is active with its new family; only the saved copy is gone.
  assert.equal(coordinator.current()?.sessionFamilyId, 'bound-session');
  assert.equal(native.values.has('mpgd.guest.refresh.family'), false);
  assert.equal(native.values.get('mpgd.guest.refresh'), 'refresh-3');
  // The next change writes it again.
  failFamilySave = false;
  server.answers.refresh.push({ sessionId: 'rotated-2' });
  await coordinator.refresh();
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'bound-session');
}

// A malformed family id is an invalid response; a listener that throws does not fail start().
{
  const native = credentialFixture();
  const server = familyBackend();
  server.answers.issue = { sessionId: 'issued-session', sessionFamilyId: ' ' };
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await assert.rejects(coordinator.start(), { code: 'GUEST_SESSION_INVALID_RESPONSE' });
  assert.equal(native.values.size, 0);

  const healthy = familyBackend();
  const listening = createGuestSessionCoordinator({
    backend: healthy.backend,
    credentials: credentialFixture().credentials,
    installationId: 'local-install-1',
    now,
  });
  listening.onSession(() => {
    throw new Error('listener failed');
  });
  assert.equal((await listening.start()).sessionFamilyId, 'issued-session');
}

// A backend that names the family at issue and at binding: its ids are used as sent.
{
  const native = credentialFixture();
  const server = familyBackend();
  server.answers.issue = { sessionId: 'issued-session', sessionFamilyId: 'family-a' };
  server.answers.bind = { sessionId: 'issued-session', sessionFamilyId: 'family-b' };
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  assert.equal((await coordinator.start()).sessionFamilyId, 'family-a');
  // A binding that keeps the session id still takes the family the backend names.
  await coordinator.bindAccount({ externalProof: 'proof', idempotencyKey: 'bind-1' });
  assert.equal(coordinator.current()?.sessionFamilyId, 'family-b');
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'family-b');
  // `null` reads as an omitted family id.
  server.answers.refresh.push({
    sessionId: 'rotated-1',
    sessionFamilyId: null as unknown as string,
  });
  assert.equal((await coordinator.refresh()).sessionFamilyId, 'family-b');
}

// A failed token save: no active session, and nothing announced.
{
  const native = credentialFixture();
  const server = familyBackend();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  const seen: string[] = [];
  coordinator.onSession((view) => seen.push(view.sessionId));
  await coordinator.start();
  native.failNextSave();
  server.answers.refresh.push({ sessionId: 'rotated-1' });
  await assert.rejects(coordinator.refresh(), { code: 'GUEST_SESSION_CREDENTIAL_SAVE_FAILED' });
  assert.equal(coordinator.current(), undefined);
  assert.deepEqual(seen, ['issued-session']);
}

// A new family is written before its token: when only the token save fails,
// the newer family sits next to the older token, which a restore reads as a new family.
{
  const native = credentialFixture();
  const server = familyBackend();
  let failTokenSave = false;
  const credentials: SecureCredentialStore = {
    ...native.credentials,
    async save(input) {
      if (input.key === 'mpgd.guest.refresh' && failTokenSave) {
        throw new Error('native save failed');
      }
      return native.credentials.save(input);
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials,
    installationId: 'local-install-1',
    now,
  });
  await coordinator.start();
  failTokenSave = true;
  await assert.rejects(
    coordinator.bindAccount({ externalProof: 'proof', idempotencyKey: 'bind-1' }),
    { code: 'GUEST_SESSION_CREDENTIAL_SAVE_FAILED' },
  );
  assert.equal(native.values.get('mpgd.guest.refresh.family'), 'bound-session');
  assert.equal(native.values.get('mpgd.guest.refresh'), 'refresh-1');
  await coordinator.logout();
  assert.equal(native.values.size, 0);
}

// A family removal that throws, even synchronously, fails neither a save nor logout.
{
  const native = credentialFixture();
  const server = familyBackend();
  server.answers.issue = { sessionId: 'issued-session', sessionFamilyId: null as unknown as string };
  let failFamily = false;
  const credentials: SecureCredentialStore = {
    ...native.credentials,
    async save(input) {
      if (input.key === 'mpgd.guest.refresh.family' && failFamily) {
        throw new Error('native save failed');
      }
      return native.credentials.save(input);
    },
    remove(input) {
      if (input.key === 'mpgd.guest.refresh.family' && failFamily) {
        throw new Error('native remove failed');
      }
      return native.credentials.remove(input);
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials,
    installationId: 'local-install-1',
    now,
  });
  // `null` at issue reads as omitted: the family starts at the session id.
  assert.equal((await coordinator.start()).sessionFamilyId, 'issued-session');
  failFamily = true;
  assert.deepEqual(
    await coordinator.bindAccount({ externalProof: 'proof', idempotencyKey: 'bind-1' }),
    {
      status: 'bound',
    },
  );
  assert.equal(coordinator.current()?.sessionFamilyId, 'bound-session');
  await coordinator.logout();
  assert.equal(native.values.has('mpgd.guest.refresh'), false);
}

// The server session over a coordinator: the family id is the session id the clients see.
{
  const native = credentialFixture();
  const server = familyBackend();
  let clock = now();
  const coordinator = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now: () => clock,
  });
  const serverSession = createGuestServerSession(coordinator, { now: () => clock });
  // It is the notifications client's identity and a header resolver as it stands.
  const identity: GameServicesNotificationIdentity = serverSession;
  const resolver: GameServicesHeaderResolver = serverSession.getHeaders;
  void resolver;
  const announced: string[] = [];
  identity.onAuthenticated((active) => announced.push(`${active.playerId}/${active.sessionId}`));
  assert.equal(serverSession.current(), undefined);
  await assert.rejects(serverSession.getHeaders(), { code: 'GUEST_SESSION_NOT_READY' });
  await coordinator.start();
  assert.deepEqual(serverSession.current(), {
    playerId: 'server-user-1',
    sessionId: 'issued-session',
  });
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-1' });
  assert.equal(server.count, 1);

  // Within a minute of expiry: the token is answered at once and refreshed in the background.
  const iso = (ms: number) => new Date(ms).toISOString();
  /** Lets a background refresh settle (a macrotask after every pending microtask). */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  clock = Date.parse(expires) - 30_000;
  server.answers.refresh.push({ sessionId: 'rotated-1' });
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-1' });
  await settle();
  assert.equal(server.refreshCalls, 1);
  assert.deepEqual(serverSession.current(), {
    playerId: 'server-user-1',
    sessionId: 'issued-session',
  });
  // Once per token: the new token (with the same expiry) is not refreshed again, even after the interval.
  clock += 10_000;
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-2' });
  await settle();
  assert.equal(server.refreshCalls, 1);
  // A token that lives shorter than the lead: at most one background refresh per interval.
  server.answers.refresh.push({
    sessionId: 'rotated-2',
    accessExpiresAt: iso(Date.parse(expires) + 10_000),
  });
  await coordinator.refresh();
  server.answers.refresh.push({
    sessionId: 'rotated-3',
    accessExpiresAt: iso(Date.parse(expires) + 20_000),
  });
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-3' });
  await settle();
  assert.equal(server.refreshCalls, 3);
  // access-4 is another token inside the lead, but the interval has not passed.
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-4' });
  await settle();
  assert.equal(server.refreshCalls, 3);
  clock += 10_000;
  const later = iso(Date.parse(expires) + 60 * 60 * 1000);
  server.answers.refresh.push({ sessionId: 'rotated-4', accessExpiresAt: later });
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-4' });
  await settle();
  assert.equal(server.refreshCalls, 4);
  // A failed background refresh still answers the valid token...
  clock = Date.parse(later) - 30_000;
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-5' });
  await settle();
  assert.equal(server.refreshCalls, 5);
  assert.equal(server.count, 5);
  // ...and is tried again once the token expired: concurrent callers share one refresh.
  clock = Date.parse(later);
  const latest = iso(Date.parse(later) + 60 * 60 * 1000);
  server.answers.refresh.push({ sessionId: 'rotated-5', accessExpiresAt: latest });
  assert.deepEqual(await Promise.all([serverSession.getHeaders(), serverSession.getHeaders()]), [
    { authorization: 'Bearer access-6' },
    { authorization: 'Bearer access-6' },
  ]);
  assert.equal(server.refreshCalls, 6);
  // Arm the interval at latest-30s (no refresh is scripted, so this one fails).
  clock = Date.parse(latest) - 30_000;
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-6' });
  await settle();
  assert.equal(server.refreshCalls, 7);
  const earlier = iso(Date.parse(latest) - 40 * 60 * 1000);
  server.answers.refresh.push({ sessionId: 'rotated-6', accessExpiresAt: earlier });
  await coordinator.refresh();
  // A clock that went back (before the armed interval) does not hold the background refresh off.
  clock = Date.parse(earlier) - 30_000;
  server.answers.refresh.push({ sessionId: 'rotated-7', accessExpiresAt: latest });
  assert.deepEqual(await serverSession.getHeaders(), { authorization: 'Bearer access-7' });
  await settle();
  assert.equal(server.refreshCalls, 9);
  // An expired token whose refresh fails throws the refresh's error.
  clock = Date.parse(latest);
  await assert.rejects(serverSession.getHeaders(), { code: 'GUEST_SESSION_BACKEND_FAILED' });
  assert.deepEqual(announced, ['server-user-1/issued-session']);

  // A binding that starts a new family is a new session; the refreshes were not.
  clock = now();
  const unsubscribeLater = serverSession.onAuthenticated(() => {
    throw new Error('unsubscribed');
  });
  unsubscribeLater();
  const fromNow: string[] = [];
  serverSession.onAuthenticated((active) => fromNow.push(active.sessionId));
  await coordinator.bindAccount({ externalProof: 'proof', idempotencyKey: 'bind-1' });
  assert.deepEqual(announced, ['server-user-1/issued-session', 'server-user-1/bound-session']);
  assert.deepEqual(fromNow, ['bound-session']);
  await coordinator.logout();
  assert.equal(serverSession.current(), undefined);
  await assert.rejects(serverSession.getHeaders(), { code: 'GUEST_SESSION_CLOSED' });
  assert.throws(() => createGuestServerSession(coordinator, { refreshAheadMs: -1 }), {
    code: 'GUEST_SESSION_INVALID_INPUT',
  });
}

// A refresh the backend rejects for good is GUEST_SESSION_REJECTED, not an outage.
{
  const native = credentialFixture();
  native.values.set('mpgd.guest.refresh', 'revoked-refresh');
  let rejectRefresh = true;
  const coordinator = createGuestSessionCoordinator({
    backend: {
      async issueGuest() {
        return session('access-new', 'refresh-new');
      },
      async refresh() {
        if (rejectRefresh) {
          throw new GuestSessionRejectedError();
        }
        throw new Error('outage with refresh-secret in the message');
      },
      async revoke() {},
      async bindAccount() {
        return { status: 'conflict' };
      },
    },
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await assert.rejects(coordinator.start(), { code: 'GUEST_SESSION_REJECTED' });
  rejectRefresh = false;
  // The rejected session is not tried again: no backend call until logout.
  await assert.rejects(coordinator.start(), { code: 'GUEST_SESSION_NOT_READY' });
  assert.equal(coordinator.current(), undefined);
  // Logout removes the dead token, so a new coordinator issues a new guest.
  await coordinator.logout();
  assert.equal(native.values.get('mpgd.guest.refresh'), undefined);
}

// A rejection mid-session (refresh, bindAccount) latches too, and an outage does not.
{
  const native = credentialFixture();
  const answers: (() => Promise<ServerGuestSessionCredentials>)[] = [];
  let refreshCalls = 0;
  let clock = now();
  const coordinator = createGuestSessionCoordinator({
    backend: {
      async issueGuest() {
        return session('access-1', 'refresh-1');
      },
      async refresh() {
        refreshCalls += 1;
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error('no answer');
        }
        return answer();
      },
      async revoke() {},
      async bindAccount() {
        throw new GuestSessionRejectedError();
      },
    },
    credentials: native.credentials,
    installationId: 'local-install-1',
    now: () => clock,
  });
  const serverSession = createGuestServerSession(coordinator, { now: () => clock });
  await coordinator.start();
  answers.push(async () => {
    throw new Error('outage');
  });
  await assert.rejects(coordinator.refresh(), { code: 'GUEST_SESSION_BACKEND_FAILED' });
  assert.notEqual(coordinator.current(), undefined);
  answers.push(async () => {
    throw new GuestSessionRejectedError();
  });
  clock = Date.parse(expires);
  await assert.rejects(serverSession.getHeaders(), { code: 'GUEST_SESSION_REJECTED' });
  assert.equal(coordinator.current(), undefined);
  // Later reads fail fast instead of sending the dead token again.
  await assert.rejects(serverSession.getHeaders(), { code: 'GUEST_SESSION_NOT_READY' });
  await assert.rejects(coordinator.refresh(), { code: 'GUEST_SESSION_NOT_READY' });
  assert.equal(refreshCalls, 2);

  const bound = createGuestSessionCoordinator({
    backend: {
      async issueGuest() {
        return session('access-1', 'refresh-1');
      },
      async refresh() {
        return session('access-2', 'refresh-2');
      },
      async revoke() {},
      async bindAccount() {
        throw new GuestSessionRejectedError();
      },
    },
    credentials: credentialFixture().credentials,
    installationId: 'local-install-1',
    now,
  });
  await bound.start();
  await assert.rejects(bound.bindAccount({ externalProof: 'proof', idempotencyKey: 'bind-1' }), {
    code: 'GUEST_SESSION_REJECTED',
  });
  assert.equal(bound.current(), undefined);
}

// An account deletion confirmation: asked with the current refresh token, in
// the queue with refreshes; a refused session latches like a refresh.
{
  const native = credentialFixture();
  const server = backendFixture();
  // Without the backend method: unsupported, and the backend is not asked.
  const plain = createGuestSessionCoordinator({
    backend: server.backend,
    credentials: native.credentials,
    installationId: 'local-install-1',
    now,
  });
  await plain.start();
  await assert.rejects(plain.requestAccountDeletionConfirmation(), {
    code: 'GUEST_SESSION_UNSUPPORTED',
  });
  const presented: string[] = [];
  let answer: () => Promise<unknown> = async () => ({
    confirmation: 'mpgd_dc_confirmation',
    expiresAt: '2030-01-01T00:05:00.000Z',
  });
  const backend: GuestSessionBackend = {
    ...server.backend,
    async requestAccountDeletionConfirmation({ refreshToken }) {
      presented.push(refreshToken);
      return await answer() as never;
    },
  };
  const coordinator = createGuestSessionCoordinator({
    backend,
    credentials: credentialFixture().credentials,
    installationId: 'local-install-1',
    now,
  });
  await assert.rejects(coordinator.requestAccountDeletionConfirmation(), {
    code: 'GUEST_SESSION_NOT_READY',
  });
  await coordinator.start();
  // Queued behind a refresh in flight: it presents the rotated token.
  const refreshing = coordinator.refresh();
  const confirmation = coordinator.requestAccountDeletionConfirmation();
  await refreshing;
  assert.equal(await confirmation, 'mpgd_dc_confirmation');
  assert.deepEqual(presented, [`refresh-${server.calls.refresh + 1}`]);
  // The server session exposes it.
  assert.equal(
    await createGuestServerSession(coordinator, { now }).requestAccountDeletionConfirmation?.(),
    'mpgd_dc_confirmation',
  );
  for (const malformed of [
    {},
    { confirmation: '', expiresAt: expires },
    { confirmation: 'x', expiresAt: 'later' },
  ]) {
    answer = async () => malformed;
    await assert.rejects(coordinator.requestAccountDeletionConfirmation(), {
      code: 'GUEST_SESSION_INVALID_RESPONSE',
    });
  }
  answer = async () => {
    throw new Error('offline https://identity.example.test refresh-secret');
  };
  await assert.rejects(coordinator.requestAccountDeletionConfirmation(), {
    code: 'GUEST_SESSION_BACKEND_FAILED',
  });
  assert.notEqual(coordinator.current(), undefined);
  answer = async () => {
    throw new GuestSessionRejectedError();
  };
  await assert.rejects(coordinator.requestAccountDeletionConfirmation(), {
    code: 'GUEST_SESSION_REJECTED',
  });
  assert.equal(coordinator.current(), undefined);
  await assert.rejects(coordinator.requestAccountDeletionConfirmation(), {
    code: 'GUEST_SESSION_NOT_READY',
  });
}

// The HTTP backend: routes, bodies, refusals, and the base URL rules.
{
  const requests: { url: string; method: string; body: unknown; redirect: string }[] = [];
  const answers: (() => Response)[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    requests.push({
      url: request.url,
      method: request.method,
      body: JSON.parse(await request.text()) as unknown,
      redirect: request.redirect,
    });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error('no answer');
    }
    return answer();
  };
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const backend = createGuestSessionHttpBackend({
    baseUrl: 'https://identity.example.test/api',
    fetch: fetch as typeof globalThis.fetch,
  });
  answers.push(json({ ...session('access-1', 'refresh-1'), sessionFamilyId: 'family-1' }));
  const issued = await backend.issueGuest({ installationId: 'install-1' });
  assert.equal(issued.sessionFamilyId, 'family-1');
  assert.deepEqual(requests[0], {
    url: `https://identity.example.test/api${guestIdentityHttpRoutes.issueGuest}`,
    method: 'POST',
    body: { installationId: 'install-1' },
    redirect: 'manual',
  });
  answers.push(json({ error: 'GUEST_SESSION_REJECTED' }, 401));
  await assert.rejects(backend.refresh({ refreshToken: 'refresh-1' }), GuestSessionRejectedError);
  assert.equal(
    requests[1]?.url,
    `https://identity.example.test/api${guestIdentityHttpRoutes.refresh}`,
  );
  // A 401 with another code (a proxy in front, say) is not a rejection.
  answers.push(json({ error: 'UNAUTHORIZED' }, 401));
  await assert.rejects(backend.refresh({ refreshToken: 'refresh-1' }), GuestSessionHttpError);
  answers.push(json({ error: 'RATE_LIMITED' }, 429));
  try {
    await backend.issueGuest({ installationId: 'install-1' });
    throw new Error('expected a refusal');
  } catch (error) {
    assert.equal(error instanceof GuestSessionHttpError && error.code, 'RATE_LIMITED');
    assert.equal(error instanceof GuestSessionHttpError && error.status, 429);
    assert.equal(String(error).includes('install-1'), false);
  }
  answers.push(() => new Response('<html>', { status: 502 }));
  await assert.rejects(backend.issueGuest({ installationId: 'install-1' }), /502 UNKNOWN/u);
  answers.push(json({}));
  await backend.revoke({ refreshToken: 'refresh-2' });
  assert.deepEqual(requests.at(-1)?.body, { refreshToken: 'refresh-2' });
  // A 200 that is not a JSON object never passes, so a revoke is never assumed done.
  answers.push(() => new Response('<html>captive portal</html>', { status: 200 }));
  await assert.rejects(backend.revoke({ refreshToken: 'refresh-2' }), /200 INVALID_BODY/u);
  answers.push(json(null));
  await assert.rejects(backend.issueGuest({ installationId: 'install-1' }), /200 INVALID_BODY/u);
  // bindAccount: an outcome passes through (conflict too), a rejected token is a rejection.
  answers.push(json({ status: 'conflict' }));
  assert.deepEqual(
    await backend.bindAccount({ refreshToken: 'refresh-2', externalProof: 'proof', idempotencyKey: 'bind' }),
    { status: 'conflict' },
  );
  answers.push(json({ error: 'GUEST_SESSION_REJECTED' }, 401));
  await assert.rejects(
    backend.bindAccount({
      refreshToken: 'refresh-2',
      externalProof: 'proof',
      idempotencyKey: 'bind',
    }),
    GuestSessionRejectedError,
  );
  // A deletion confirmation: its route, the refresh token, a rejection.
  answers.push(json({ confirmation: 'mpgd_dc_1', expiresAt: expires }));
  assert.deepEqual(
    await backend.requestAccountDeletionConfirmation?.({ refreshToken: 'refresh-2' }),
    { confirmation: 'mpgd_dc_1', expiresAt: expires },
  );
  assert.deepEqual(requests.at(-1), {
    url: `https://identity.example.test/api${guestIdentityHttpRoutes.requestAccountDeletionConfirmation}`,
    method: 'POST',
    body: { refreshToken: 'refresh-2' },
    redirect: 'manual',
  });
  answers.push(json({ error: 'GUEST_SESSION_REJECTED' }, 401));
  await assert.rejects(
    backend.requestAccountDeletionConfirmation?.({ refreshToken: 'refresh-2' }) ?? Promise.resolve(),
    GuestSessionRejectedError,
  );
  // A fetch that followed a redirect regardless is refused.
  answers.push(() => {
    const response = json(session('access-x', 'refresh-x'))();
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  });
  await assert.rejects(backend.refresh({ refreshToken: 'refresh-3' }), /200 REDIRECTED/u);
  answers.push(json({ error: 'ACCOUNT_BINDING_UNSUPPORTED' }, 501));
  await assert.rejects(
    backend.bindAccount({
      refreshToken: 'refresh-2',
      externalProof: 'proof',
      idempotencyKey: 'bind',
    }),
    /501 ACCOUNT_BINDING_UNSUPPORTED/u,
  );
  // A redirect is never followed: the manual answer is a failure, and no token leaves the origin.
  answers.push(
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
  );
  await assert.rejects(backend.refresh({ refreshToken: 'refresh-3' }), GuestSessionHttpError);
  for (const baseUrl of [
    'http://identity.example.test',
    'not a url',
    'https://user:secret@identity.example.test',
    'https://identity.example.test/?token=1',
  ]) {
    assert.throws(
      () => createGuestSessionHttpBackend({ baseUrl, fetch: fetch as typeof globalThis.fetch }),
      {
        code: 'GUEST_SESSION_INVALID_INPUT',
      },
    );
  }
  assert.throws(
    () =>
      createGuestSessionHttpBackend({
        baseUrl: 'https://identity.example.test',
        timeoutMs: 2 ** 31,
      }),
    { code: 'GUEST_SESSION_INVALID_INPUT' },
  );
  assert.throws(
    () => createGuestSessionHttpBackend({ baseUrl: 'https://identity.example.test', timeoutMs: 0 }),
    {
      code: 'GUEST_SESSION_INVALID_INPUT',
    },
  );
  for (const baseUrl of [
    'http://localhost:8788',
    'http://10.0.2.2:8788/',
    'http://game.localhost',
  ]) {
    createGuestSessionHttpBackend({ baseUrl, fetch: fetch as typeof globalThis.fetch });
  }
  answers.push(json(session('access-9', 'refresh-9')));
  await createGuestSessionHttpBackend({
    baseUrl: 'http://localhost:8788',
    fetch: fetch as typeof globalThis.fetch,
  }).issueGuest({ installationId: 'install-9' });
  assert.equal(requests.at(-1)?.url, `http://localhost:8788${guestIdentityHttpRoutes.issueGuest}`);
}

// A request that outlives the timeout is aborted.
{
  const backend = createGuestSessionHttpBackend({
    baseUrl: 'https://identity.example.test',
    timeoutMs: 5,
    fetch: ((request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof globalThis.fetch,
  });
  await assert.rejects(backend.issueGuest({ installationId: 'install-1' }), /aborted/u);
}

console.info('Guest session coordinator conformance passed.');
