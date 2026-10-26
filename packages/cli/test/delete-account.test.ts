import assert from 'node:assert/strict';

import {
  AccountDeletionError,
  createGuestSessionCoordinator,
  GuestSessionCoordinatorError,
  type AccountDeletionReceipt,
  type GuestSessionBackend,
} from '@mpgd/game-services';
import type { SecureCredentialStore, StorageAdapter } from '@mpgd/platform';

import {
  createStarterAccountDeletion,
  deleteAccountConfirmText,
  deleteAccountOutcomeText,
  onStarterAccountDeleted,
  resetStarterAccountDeletionForTests,
  starterAccountDeletionConfirmation,
  starterGuestCredentialKeys,
} from '../templates/phaser-game/src/platform/deleteAccount.js';
import { defaultMonetizationJournalKey } from '../templates/phaser-game/src/platform/monetizationJournal.js';

// The template's Delete account entry (Phaser lobby and lite button).

function memoryStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    async load({ key }: { readonly key: string }) {
      return values.has(key) ? { value: values.get(key) } : null;
    },
    async save({ key, value }: { readonly key: string; readonly value: unknown }) {
      values.set(key, value);
    },
  } satisfies Pick<StorageAdapter, 'load' | 'save'> & { values: Map<string, unknown> };
}

function memoryCredentials(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    async load({ key }: { readonly key: string }) {
      return values.get(key) ?? null;
    },
    async save({ key, value }: { readonly key: string; readonly value: string }) {
      values.set(key, value);
    },
    async remove({ key }: { readonly key: string }) {
      values.delete(key);
    },
  } satisfies SecureCredentialStore & { values: Map<string, string> };
}

const receipt: AccountDeletionReceipt = {
  status: 'deleted',
  deletionId: 'deletion-1',
  completedAt: '2026-10-25T00:00:00.000Z',
  retainedPurchaseRecords: 2,
};

const pendingPurchase = {
  kind: 'commerce-purchase',
  state: 'verifying',
  idempotencyKey: 'purchase-1',
};

// No game-services backend: no entry.
{
  const deletion = createStarterAccountDeletion({ storage: memoryStorage() });
  assert.equal(deletion.available, false);
  assert.deepEqual(await deletion.deleteAccount(), { outcome: 'unavailable' });
}

// A deletion signs this device out: credentials, the journal, and registered steps.
{
  // The keys match what the guest session coordinator saves by default.
  const credentials = memoryCredentials();
  const backend: GuestSessionBackend = {
    async issueGuest() {
      return {
        serverUserId: 'player-1',
        sessionId: 'session-1',
        sessionFamilyId: 'family-1',
        identityLevel: 'guest',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    refresh: () => Promise.reject(new Error('not used')),
    revoke: async () => undefined,
    bindAccount: () => Promise.reject(new Error('not used')),
  };
  await createGuestSessionCoordinator({ backend, credentials, installationId: 'installation-1' })
    .start();
  assert.deepEqual([...credentials.values.keys()].sort(), [...starterGuestCredentialKeys].sort());
  credentials.values.set('unrelated', 'kept');
  for (const key of starterGuestCredentialKeys) {
    credentials.values.set(key, 'secret');
  }

  const storage = memoryStorage({
    [defaultMonetizationJournalKey]: { version: 1, records: { a: pendingPurchase } },
  });
  const steps: string[] = [];
  const stop = onStarterAccountDeleted(() => {
    steps.push('notifications.unregister');
  });
  const stopFailing = onStarterAccountDeleted(() => {
    throw new Error('a failing step does not stop the others');
  });
  let calls = 0;
  const deletion = createStarterAccountDeletion({
    client: {
      async deleteAccount() {
        calls += 1;
        return receipt;
      },
    },
    storage,
    secureCredentials: credentials,
  });
  assert.equal(deletion.available, true);
  assert.equal(await deletion.hasPendingPurchase(), true);
  const consoleError = console.error;
  console.error = () => undefined;
  let first;
  let second;
  try {
    // A second tap joins the running deletion.
    [first, second] = await Promise.all([deletion.deleteAccount(), deletion.deleteAccount()]);
  } finally {
    console.error = consoleError;
    stop();
    stopFailing();
  }
  assert.deepEqual(first, { outcome: 'deleted', retainedPurchaseRecords: 2, signedOut: true });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.deepEqual([...credentials.values.keys()], ['unrelated']);
  assert.equal(storage.values.get(defaultMonetizationJournalKey), null);
  assert.equal(storage.values.get('starter-run'), null, 'the run checkpoint is cleared');
  assert.equal(await deletion.hasPendingPurchase(), false);
  assert.deepEqual(steps, ['notifications.unregister']);
}

// Failures keep the session; only a sent request whose answer was lost,
// followed by the server refusing the session, counts as deleted.
{
  const answers: (AccountDeletionReceipt | AccountDeletionError)[] = [];
  const credentials = memoryCredentials({ 'mpgd.guest.refresh': 'secret' });
  const journalStorage = memoryStorage({
    [defaultMonetizationJournalKey]: { version: 1, records: {} },
  });
  const deletion = createStarterAccountDeletion({
    client: {
      async deleteAccount() {
        const answer = answers.shift();
        if (answer === undefined || answer instanceof AccountDeletionError) {
          throw answer ?? new Error('unexpected');
        }
        return answer;
      },
    },
    storage: journalStorage,
    secureCredentials: credentials,
  });
  const ask = async (answer: AccountDeletionError) => {
    answers.push(answer);
    return deletion.deleteAccount();
  };
  const lost = () => new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE', {
    requestSent: true,
  });
  const unsent = () => new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE', {
    requestSent: false,
  });
  const refused = () => new AccountDeletionError('UNAUTHORIZED');
  const signedOutHere = () => new AccountDeletionError('UNAUTHORIZED', { requestSent: false });
  resetStarterAccountDeletionForTests();
  assert.deepEqual(await ask(refused()), { outcome: 'needs-session' });
  assert.deepEqual(await ask(new AccountDeletionError('ACCOUNT_DELETION_NOT_CONFIGURED')), {
    outcome: 'unavailable',
  });
  assert.deepEqual(await ask(new AccountDeletionError('ACCOUNT_DELETION_FAILED')), {
    outcome: 'failed',
    retryable: true,
  });
  assert.deepEqual(await ask(new AccountDeletionError('ACCOUNT_DELETION_REJECTED')), {
    outcome: 'failed',
    retryable: false,
  });
  // Nothing sent: a later refusal is a plain missing session.
  assert.deepEqual(await ask(unsent()), { outcome: 'failed', retryable: true });
  assert.deepEqual(await ask(refused()), { outcome: 'needs-session' });
  // Sent and lost, then a definite answer from the server: not deleted.
  assert.deepEqual(await ask(lost()), { outcome: 'failed', retryable: true });
  assert.deepEqual(await ask(new AccountDeletionError('ACCOUNT_DELETION_REJECTED')), {
    outcome: 'failed',
    retryable: false,
  });
  assert.deepEqual(await ask(refused()), { outcome: 'needs-session' });
  // Sent and lost, then signed out on this device (nothing sent): not inferred.
  assert.deepEqual(await ask(lost()), { outcome: 'failed', retryable: true });
  assert.deepEqual(await ask(signedOutHere()), { outcome: 'needs-session' });
  assert.equal(credentials.values.size, 1, 'nothing signed out before a deletion');
  // Sent and lost, a retryable 5xx (maybe a proxy after the deletion), then
  // the server refused the session: most likely deleted. Signed out, but the
  // purchase journal stays in case the account still exists.
  assert.deepEqual(await ask(new AccountDeletionError('ACCOUNT_DELETION_FAILED')), {
    outcome: 'failed',
    retryable: true,
  });
  assert.deepEqual(await ask(refused()), { outcome: 'session-ended', signedOut: true });
  assert.equal(credentials.values.size, 0, 'signed out after the session ended');
  assert.deepEqual(journalStorage.values.get(defaultMonetizationJournalKey), {
    version: 1,
    records: {},
  });
  resetStarterAccountDeletionForTests();
}

// The confirmation is asked for right before the request and sent with it;
// a refused one is a retryable failure (the next tap asks for a new one).
{
  resetStarterAccountDeletionForTests();
  const sent: (string | undefined)[] = [];
  let confirmations = 0;
  const confirmed = createStarterAccountDeletion({
    client: {
      async deleteAccount(request) {
        sent.push(request?.confirmation);
        if (sent.length === 1) {
          throw new AccountDeletionError('ACCOUNT_DELETION_CONFIRMATION_REQUIRED');
        }
        return receipt;
      },
    },
    storage: memoryStorage(),
    requestConfirmation: async () => {
      confirmations += 1;
      return `confirmation-${confirmations}`;
    },
  });
  assert.deepEqual(await confirmed.deleteAccount(), { outcome: 'failed', retryable: true });
  assert.deepEqual(await confirmed.deleteAccount(), {
    outcome: 'deleted',
    retainedPurchaseRecords: 2,
    signedOut: true,
  });
  assert.deepEqual(sent, ['confirmation-1', 'confirmation-2']);
  const consoleError = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(
      await createStarterAccountDeletion({
        client: { deleteAccount: () => Promise.reject(new Error('must not be called')) },
        storage: memoryStorage(),
        requestConfirmation: () => Promise.reject(new Error('identity unreachable')),
      }).deleteAccount(),
      { outcome: 'failed', retryable: true },
    );
  } finally {
    console.error = consoleError;
  }
  // The identity service refusing the session: no session here, unless an
  // earlier request's answer was lost (then the deletion completed).
  resetStarterAccountDeletionForTests();
  const refusedStorage = memoryStorage();
  let lostOnce = true;
  const afterLost = createStarterAccountDeletion({
    client: {
      async deleteAccount() {
        throw new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE', { requestSent: true });
      },
    },
    storage: refusedStorage,
    requestConfirmation: async () => {
      if (lostOnce) {
        lostOnce = false;
        return 'confirmation-lost';
      }
      throw new AccountDeletionError('UNAUTHORIZED');
    },
  });
  assert.deepEqual(await afterLost.deleteAccount(), { outcome: 'failed', retryable: true });
  assert.deepEqual(await afterLost.deleteAccount(), { outcome: 'session-ended', signedOut: true });
  resetStarterAccountDeletionForTests();
  assert.deepEqual(
    await createStarterAccountDeletion({
      client: { deleteAccount: () => Promise.reject(new Error('must not be called')) },
      storage: memoryStorage(),
      requestConfirmation: () => Promise.reject(new AccountDeletionError('UNAUTHORIZED')),
    }).deleteAccount(),
    { outcome: 'needs-session' },
  );
  // A server that requires a confirmation the game cannot ask for.
  assert.deepEqual(
    await createStarterAccountDeletion({
      client: {
        deleteAccount: () =>
          Promise.reject(new AccountDeletionError('ACCOUNT_DELETION_CONFIRMATION_REQUIRED')),
      },
      storage: memoryStorage(),
    }).deleteAccount(),
    { outcome: 'unavailable' },
  );
}

// A refresh in flight when the account is deleted cannot write the deleted
// account's token back: the coordinator is closed (and drained) first.
{
  resetStarterAccountDeletionForTests();
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
  let releaseRefresh: (() => void) | undefined;
  const session = (refreshToken: string) => ({
    serverUserId: 'p_deleted',
    sessionId: 's_family',
    sessionFamilyId: 's_family',
    identityLevel: 'guest' as const,
    accessToken: `access-${refreshToken}`,
    refreshToken,
    accessExpiresAt: '2099-01-01T00:00:00.000Z',
  });
  const coordinator = createGuestSessionCoordinator({
    backend: {
      issueGuest: async () => session('refresh-1'),
      refresh: () =>
        new Promise((resolve) => {
          releaseRefresh = () => resolve(session('refresh-late'));
        }),
      // Offline: logout cannot revoke, so it removes nothing itself; only the
      // order (close and drain first, then remove) keeps the late token out.
      revoke: () => Promise.reject(new Error('offline')),
      bindAccount: () => Promise.reject(new Error('not used')),
    },
    credentials,
    installationId: 'installation-race',
  });
  await coordinator.start();
  const refreshing = coordinator.refresh().catch(() => undefined);
  const stop = onStarterAccountDeleted(() => coordinator.logout(), { phase: 'session' });
  try {
    const quiet = console.error;
    console.error = () => undefined;
    const deleting = createStarterAccountDeletion({
      client: { deleteAccount: async () => receipt },
      storage: memoryStorage(),
      secureCredentials: credentials,
    }).deleteAccount();
    // The refresh answers while the sign-out runs.
    setTimeout(() => releaseRefresh?.(), 10);
    assert.deepEqual(await deleting, {
      outcome: 'deleted',
      retainedPurchaseRecords: 2,
      signedOut: true,
    });
    await refreshing;
    assert.equal(values.get('mpgd.guest.refresh'), undefined, 'the late refresh token is not kept');
    assert.equal(coordinator.current(), undefined);
    console.error = quiet;
  } finally {
    stop();
  }
}

// The guest session's confirmation; a session the identity service refused
// is UNAUTHORIZED (a sent request), anything else passes through.
{
  assert.equal(starterAccountDeletionConfirmation(undefined), undefined);
  assert.equal(starterAccountDeletionConfirmation({}), undefined);
  let failure: unknown;
  const confirm = starterAccountDeletionConfirmation({
    async requestAccountDeletionConfirmation() {
      if (failure !== undefined) {
        throw failure;
      }
      return 'mpgd_dc_ok';
    },
  });
  assert.ok(confirm !== undefined);
  assert.equal(await confirm(), 'mpgd_dc_ok');
  failure = new GuestSessionCoordinatorError('GUEST_SESSION_REJECTED');
  await assert.rejects(
    confirm(),
    (error: unknown) =>
      error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED' && error.requestSent,
  );
  failure = new GuestSessionCoordinatorError('GUEST_SESSION_UNSUPPORTED');
  await assert.rejects(
    confirm(),
    (error: unknown) => error instanceof AccountDeletionError && error.code === 'ACCOUNT_DELETION_NOT_CONFIGURED',
  );
  // Not a refusal (a failed credential save, offline): passed through.
  for (const code of ['GUEST_SESSION_NOT_READY', 'GUEST_SESSION_BACKEND_FAILED'] as const) {
    failure = new GuestSessionCoordinatorError(code);
    await assert.rejects(confirm(), (error: unknown) => error === failure);
  }
  // In the flow: a failed save after a lost answer is a retryable failure,
  // never the completed deletion; unsupported is unavailable.
  resetStarterAccountDeletionForTests();
  let attempts = 0;
  const flow = createStarterAccountDeletion({
    client: {
      async deleteAccount() {
        throw new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE', { requestSent: true });
      },
    },
    storage: memoryStorage(),
    requestConfirmation: async () => {
      attempts += 1;
      if (attempts === 1) {
        return 'mpgd_dc_first';
      }
      throw attempts === 2
        ? new GuestSessionCoordinatorError('GUEST_SESSION_NOT_READY')
        : new AccountDeletionError('ACCOUNT_DELETION_NOT_CONFIGURED');
    },
  });
  const quiet = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(await flow.deleteAccount(), { outcome: 'failed', retryable: true });
    assert.deepEqual(await flow.deleteAccount(), { outcome: 'failed', retryable: true });
    assert.deepEqual(await flow.deleteAccount(), { outcome: 'unavailable' });
  } finally {
    console.error = quiet;
  }
  resetStarterAccountDeletionForTests();
}

// A retryable server failure (a proxy's 502 over a completed deletion) is
// ambiguous too: the refused session afterwards is the completed deletion.
{
  resetStarterAccountDeletionForTests();
  let attempt = 0;
  const proxied = createStarterAccountDeletion({
    client: {
      async deleteAccount() {
        attempt += 1;
        throw new AccountDeletionError(attempt === 1 ? 'ACCOUNT_DELETION_FAILED' : 'UNAUTHORIZED');
      },
    },
    storage: memoryStorage(),
  });
  assert.deepEqual(await proxied.deleteAccount(), { outcome: 'failed', retryable: true });
  assert.deepEqual(await proxied.deleteAccount(), { outcome: 'session-ended', signedOut: true });
  // Without the ambiguous attempt, a refused session is only "sign in again".
  resetStarterAccountDeletionForTests();
  assert.deepEqual(
    await createStarterAccountDeletion({
      client: {
        async deleteAccount() {
          throw new AccountDeletionError('UNAUTHORIZED');
        },
      },
      storage: memoryStorage(),
    }).deleteAccount(),
    { outcome: 'needs-session' },
  );
  resetStarterAccountDeletionForTests();
}

// The entry needs a signed-in session; a journal that cannot be cleared is reported.
{
  assert.equal(
    createStarterAccountDeletion({
      client: { deleteAccount: async () => receipt },
      storage: memoryStorage(),
      signedIn: () => false,
    }).available,
    false,
  );
  const consoleError = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(
      await createStarterAccountDeletion({
        client: { deleteAccount: async () => receipt },
        storage: {
          load: async () => null,
          save: () => Promise.reject(new Error('storage full')),
        },
        signedIn: () => true,
      }).deleteAccount(),
      { outcome: 'deleted', retainedPurchaseRecords: 2, signedOut: false },
    );
  } finally {
    console.error = consoleError;
  }
}

// The copy: what goes, what stays, both languages, and the pending purchase warning.
for (const locale of ['en', 'ko'] as const) {
  const text = deleteAccountConfirmText(locale, false);
  assert.match(text, locale === 'en' ? /not refunded/u : /환불되지 않습니다/u);
  // Bought-once items come back through Restore purchases (restore sharing).
  assert.match(text, locale === 'en' ? /Restore purchases/u : /구매 복원/u);
  assert.match(text, locale === 'en' ? /5 years/u : /5년/u);
  assert.ok(deleteAccountConfirmText(locale, true).length > text.length);
  for (const outcome of [
    { outcome: 'deleted', retainedPurchaseRecords: 0, signedOut: true },
    { outcome: 'deleted', retainedPurchaseRecords: 0, signedOut: false },
    { outcome: 'session-ended', signedOut: true },
    { outcome: 'needs-session' },
    { outcome: 'unavailable' },
    { outcome: 'failed', retryable: true },
    { outcome: 'failed', retryable: false },
  ] as const) {
    assert.ok(deleteAccountOutcomeText(locale, outcome).length > 0);
  }
}

console.info('Starter account deletion passed.');
