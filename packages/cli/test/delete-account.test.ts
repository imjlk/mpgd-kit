import assert from 'node:assert/strict';

import {
  AccountDeletionError,
  createGuestSessionCoordinator,
  type AccountDeletionReceipt,
  type GuestSessionBackend,
} from '@mpgd/game-services';
import type { SecureCredentialStore, StorageAdapter } from '@mpgd/platform';

import {
  createStarterAccountDeletion,
  deleteAccountConfirmText,
  deleteAccountOutcomeText,
  onStarterAccountDeleted,
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
  assert.deepEqual(first, { outcome: 'deleted', retainedPurchaseRecords: 2 });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.deepEqual([...credentials.values.keys()], ['unrelated']);
  assert.equal(storage.values.get(defaultMonetizationJournalKey), null);
  assert.equal(await deletion.hasPendingPurchase(), false);
  assert.deepEqual(steps, ['notifications.unregister']);
}

// Failures keep the session; a lost answer followed by UNAUTHORIZED means it was deleted.
{
  const answers: (AccountDeletionReceipt | AccountDeletionError)[] = [];
  const credentials = memoryCredentials({ 'mpgd.guest.refresh': 'secret' });
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
    storage: memoryStorage(),
    secureCredentials: credentials,
  });
  answers.push(new AccountDeletionError('UNAUTHORIZED'));
  assert.deepEqual(await deletion.deleteAccount(), { outcome: 'needs-session' });
  answers.push(new AccountDeletionError('ACCOUNT_DELETION_NOT_CONFIGURED'));
  assert.deepEqual(await deletion.deleteAccount(), { outcome: 'unavailable' });
  answers.push(new AccountDeletionError('ACCOUNT_DELETION_FAILED'));
  assert.deepEqual(await deletion.deleteAccount(), { outcome: 'failed', retryable: true });
  answers.push(new AccountDeletionError('ACCOUNT_DELETION_REJECTED'));
  assert.deepEqual(await deletion.deleteAccount(), { outcome: 'failed', retryable: false });
  assert.equal(credentials.values.size, 1, 'nothing signed out before a deletion');
  answers.push(new AccountDeletionError('ACCOUNT_DELETION_UNREACHABLE'));
  assert.deepEqual(await deletion.deleteAccount(), { outcome: 'failed', retryable: true });
  answers.push(new AccountDeletionError('UNAUTHORIZED'));
  assert.deepEqual(await deletion.deleteAccount(), { outcome: 'session-ended' });
  assert.equal(credentials.values.size, 0, 'signed out after the session ended');
}

// The copy: what goes, what stays, both languages, and the pending purchase warning.
for (const locale of ['en', 'ko'] as const) {
  const text = deleteAccountConfirmText(locale, false);
  assert.match(text, locale === 'en' ? /not refunded/u : /환불되지 않으며/u);
  assert.match(text, locale === 'en' ? /5 years/u : /5년/u);
  assert.ok(deleteAccountConfirmText(locale, true).length > text.length);
  for (const outcome of [
    { outcome: 'deleted', retainedPurchaseRecords: 0 },
    { outcome: 'session-ended' },
    { outcome: 'needs-session' },
    { outcome: 'unavailable' },
    { outcome: 'failed', retryable: true },
    { outcome: 'failed', retryable: false },
  ] as const) {
    assert.ok(deleteAccountOutcomeText(locale, outcome).length > 0);
  }
}

console.info('Starter account deletion passed.');
