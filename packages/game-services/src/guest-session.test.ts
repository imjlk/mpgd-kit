import type { SecureCredentialStore } from '@mpgd/platform';

import {
  createGuestSessionCoordinator,
  GuestSessionCoordinatorError,
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
): ServerGuestSessionCredentials {
  return {
    serverUserId,
    sessionId: 'server-session-1',
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
    failNextSave() {
      failSave = true;
    },
    failNextRemove() {
      failRemove = true;
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
  await assert.rejects(coordinator.start(), /native load failed/u);
  assert.equal(server.calls.issue, 0, 'credential loss must not silently mint a new guest');
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
    session: session('bound-access', 'bound-refresh', 'authenticated'),
  });
  assert.deepEqual(await coordinator.bindAccount({
    externalProof: 'owned-proof', idempotencyKey: 'bind-3',
  }), { status: 'bound' });
  assert.equal(coordinator.getHeaders().authorization, 'Bearer bound-access');
  assert.equal(native.values.get('mpgd.guest.refresh'), 'bound-refresh');

  server.setBindResult({
    status: 'already-bound',
    session: session('retry-access', 'retry-refresh', 'authenticated'),
  });
  assert.deepEqual(await coordinator.bindAccount({
    externalProof: 'owned-proof', idempotencyKey: 'bind-3',
  }), { status: 'already-bound' });
  assert.equal(coordinator.getHeaders().authorization, 'Bearer retry-access');
  assert.equal(native.values.get('mpgd.guest.refresh'), 'retry-refresh');
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
  await assert.rejects(coordinator.start(), GuestSessionCoordinatorError);
  assert.equal(native.values.size, 0);
}

console.info('Guest session coordinator conformance passed.');
