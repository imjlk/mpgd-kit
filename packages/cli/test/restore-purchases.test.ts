import assert from 'node:assert/strict';

import type { MonetizationOperationSummary } from '@mpgd/game-services';
import type { IdentitySession, PlatformGateway } from '@mpgd/platform';

import {
  createStarterRestorePurchases,
  restoreOutcomeText,
} from '../templates/phaser-game/src/platform/restorePurchases.js';

// The template's Restore Purchases control (Phaser lobby and lite button).

function gateway(store: string | undefined, session: Partial<IdentitySession> | undefined) {
  return {
    ...(store === undefined ? {} : { commerce: { store } }),
    identity: {
      getSession: async () => session,
    },
  } as unknown as Pick<PlatformGateway, 'commerce' | 'identity'>;
}

const signedIn = {
  identityLevel: 'authenticated',
  trustLevel: 'server-verified',
  playerId: 'player-1',
} as const;
const guest = {
  identityLevel: 'guest',
  trustLevel: 'local',
  playerId: 'ios-local-player',
} as const;

function summary(
  kind: MonetizationOperationSummary['kind'],
  status: MonetizationOperationSummary['status'],
): MonetizationOperationSummary {
  return { kind, idempotencyKey: `${kind}-${status}`, status, finalizationPending: false };
}

let calls = 0;
const recovery = {
  async restorePurchases() {
    calls += 1;
    return [
      summary('commerce-purchase' as MonetizationOperationSummary['kind'], 'granted'),
      summary('commerce-purchase' as MonetizationOperationSummary['kind'], 'cancelled'),
      summary('rewarded-ad', 'granted'),
    ];
  },
};

// No store on this target: no control.
const none = createStarterRestorePurchases({
  gateway: gateway(undefined, signedIn),
  monetizationRecovery: recovery,
});
assert.equal(none.available, false);
assert.deepEqual(await none.restore(), { outcome: 'unavailable' });
assert.equal(
  createStarterRestorePurchases({ gateway: gateway('app-store', signedIn) }).available,
  false,
  'no monetization recovery client, no control',
);

// StoreKit and Play bind purchases to the signed-in player.
for (const store of ['app-store', 'google-play']) {
  const withoutSession = createStarterRestorePurchases({
    gateway: gateway(store, guest),
    monetizationRecovery: recovery,
  });
  assert.equal(withoutSession.available, true);
  calls = 0;
  assert.deepEqual(await withoutSession.restore(), { outcome: 'needs-session' });
  assert.equal(calls, 0, 'restore never runs without a session the backend can bind');
  assert.deepEqual(
    await createStarterRestorePurchases({ gateway: gateway(store, undefined), monetizationRecovery: recovery })
      .restore(),
    { outcome: 'needs-session' },
  );
  const withSession = createStarterRestorePurchases({
    gateway: gateway(store, signedIn),
    monetizationRecovery: recovery,
  });
  assert.deepEqual(await withSession.restore(), { outcome: 'restored', granted: 1 });
}

// Another store restores without that binding.
assert.deepEqual(
  await createStarterRestorePurchases({ gateway: gateway('microsoft-store', guest), monetizationRecovery: recovery })
    .restore(),
  { outcome: 'restored', granted: 1 },
);

// A failed store resync is an event of the reconciler, not a rejection.
const listeners = new Set<(event: { type: string; stage?: string }) => void>();
const reconcilerFailure = createStarterRestorePurchases({
  gateway: gateway('app-store', signedIn),
  monetizationRecovery: {
    commerceReconciler: {
      subscribe(listener: (event: { type: string; stage?: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never,
    async restorePurchases() {
      for (const listener of listeners) {
        listener({ type: 'failure', stage: 'restore' });
      }
      return [];
    },
  },
});
assert.deepEqual(await reconcilerFailure.restore(), { outcome: 'failed' });
// A purchase found, verified and finished within the restore is gone from the
// recoverable summaries but still counts as restored.
const settledInPass = createStarterRestorePurchases({
  gateway: gateway('app-store', signedIn),
  monetizationRecovery: {
    commerceReconciler: {
      subscribe(listener: (event: { type: string; stage?: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never,
    async restorePurchases() {
      for (const listener of listeners) {
        for (const state of ['purchased', 'verifying', 'granted', 'finishing', 'finished']) {
          (listener as (event: unknown) => void)({
            type: 'transition',
            record: { idempotencyKey: 'restored-1', state },
          });
        }
      }
      return [summary('commerce-purchase' as MonetizationOperationSummary['kind'], 'granted')];
    },
  },
});
assert.deepEqual(await settledInPass.restore(), { outcome: 'restored', granted: 2 });
// The same purchase seen as a transition and as a summary counts once.
const sameKey = createStarterRestorePurchases({
  gateway: gateway('app-store', signedIn),
  monetizationRecovery: {
    commerceReconciler: {
      subscribe(listener: (event: { type: string; stage?: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never,
    async restorePurchases() {
      for (const listener of listeners) {
        (listener as (event: unknown) => void)({
          type: 'transition',
          record: { idempotencyKey: 'commerce-purchase-granted', state: 'granted' },
        });
      }
      return [summary('commerce-purchase' as MonetizationOperationSummary['kind'], 'granted')];
    },
  },
});
assert.deepEqual(await sameKey.restore(), { outcome: 'restored', granted: 1 });
// A purchase the backend moved from an earlier guest (a reinstall, a new device) says so.
const movedHere = createStarterRestorePurchases({
  gateway: gateway('google-play', signedIn),
  monetizationRecovery: {
    commerceReconciler: {
      subscribe(listener: (event: { type: string; stage?: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never,
    async restorePurchases() {
      for (const listener of listeners) {
        const emit = listener as (event: unknown) => void;
        emit({
          type: 'verify-result',
          record: { idempotencyKey: 'moved-1' },
          response: { verified: true, alreadyProcessed: false, transferred: true, ledgerEntryId: 'le' },
        });
        emit({ type: 'transition', record: { idempotencyKey: 'moved-1', state: 'granted' } });
        emit({
          type: 'verify-result',
          record: { idempotencyKey: 'refused-1' },
          response: { verified: false, alreadyProcessed: false, reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH' },
        });
      }
      return [];
    },
  },
});
const movedResult = await movedHere.restore();
assert.deepEqual(movedResult, { outcome: 'restored', granted: 1, moved: 1 });
assert.equal(restoreOutcomeText('en', movedResult), 'Restored to this device (1 confirmed)');
assert.equal(restoreOutcomeText('ko', movedResult), '이 기기로 구매를 복원했습니다 (1건 확인)');
assert.equal(
  restoreOutcomeText('en', { outcome: 'restored', granted: 1 }),
  'Purchases restored (1 confirmed)',
);
assert.equal(listeners.size, 0, 'the restore stops listening');
assert.deepEqual(
  await createStarterRestorePurchases({
    gateway: gateway('app-store', signedIn),
    monetizationRecovery: {
      async restorePurchases() {
        return [summary('commerce-purchase' as MonetizationOperationSummary['kind'], 'failed')];
      },
    },
  }).restore(),
  { outcome: 'incomplete', granted: 0 },
  'a purchase the pass failed to settle is not "nothing to restore"',
);
for (const status of ['pending', 'action-required'] as const) {
  assert.deepEqual(
    await createStarterRestorePurchases({
      gateway: gateway('app-store', signedIn),
      monetizationRecovery: {
        async restorePurchases() {
          return [
            summary('commerce-purchase' as MonetizationOperationSummary['kind'], 'granted'),
            summary('commerce-purchase' as MonetizationOperationSummary['kind'], status),
            summary('rewarded-ad', 'pending'),
          ];
        },
      },
    }).restore(),
    { outcome: 'incomplete', granted: 1 },
  );
}
// A failed store read (Google Play has no resync, so it is the whole restore) leaves
// the result unconfirmed rather than failed: it may come from another pass.
const unrelated = createStarterRestorePurchases({
  gateway: gateway('app-store', signedIn),
  monetizationRecovery: {
    commerceReconciler: {
      subscribe(listener: (event: { type: string; stage?: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never,
    async restorePurchases() {
      for (const listener of listeners) {
        listener({ type: 'failure', stage: 'available' });
      }
      return [];
    },
  },
});
assert.deepEqual(
  await unrelated.restore(),
  { outcome: 'incomplete', granted: 0 },
  'a failed store read is never "nothing to restore"',
);

// A failure is reported, not thrown; a second tap joins the running restore.
const originalError = console.error;
console.error = () => undefined;
try {
  const failing = createStarterRestorePurchases({
    gateway: gateway('app-store', signedIn),
    monetizationRecovery: {
      async restorePurchases() {
        throw new Error('store unavailable');
      },
    },
  });
  assert.deepEqual(await failing.restore(), { outcome: 'failed' });
} finally {
  console.error = originalError;
}
let release: (() => void) | undefined;
let slowCalls = 0;
const slow = createStarterRestorePurchases({
  gateway: gateway('app-store', signedIn),
  monetizationRecovery: {
    async restorePurchases() {
      slowCalls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    },
  },
});
const first = slow.restore();
const second = slow.restore();
assert.equal(first, second);
await new Promise<void>((resolve) => {
  setImmediate(resolve);
});
release?.();
assert.deepEqual(await first, { outcome: 'restored', granted: 0 });
assert.equal(slowCalls, 1);
const third = slow.restore();
assert.notEqual(third, first, 'a later tap starts a new restore');
await new Promise<void>((resolve) => {
  setImmediate(resolve);
});
release?.();
await third;
assert.equal(slowCalls, 2);

// A run whose guest sign-in failed at boot: the control is shown, each tap
// signs in first, and a failed sign-in is a retry, not a dead control.
{
  let online = false;
  let ensureCalls = 0;
  let late: typeof recovery | undefined;
  const gated = createStarterRestorePurchases({
    gateway: gateway('google-play', signedIn),
    monetizationRecovery: () => late,
    ensureSession: async () => {
      ensureCalls += 1;
      if (online) {
        late = recovery;
      }
      return online;
    },
  });
  assert.equal(gated.available, true, 'shown before the session exists');
  calls = 0;
  assert.deepEqual(await gated.restore(), { outcome: 'needs-connection' });
  assert.equal(calls, 0);
  online = true;
  assert.deepEqual(await gated.restore(), { outcome: 'restored', granted: 1 });
  assert.equal(calls, 1);
  assert.equal(ensureCalls, 2);
  assert.match(restoreOutcomeText('en', { outcome: 'needs-connection' }), /Tap to try again/u);
}
// Signed in, but the configuration has no recovery client: unavailable, not a retry.
{
  const disabled = createStarterRestorePurchases({
    gateway: gateway('app-store', signedIn),
    monetizationRecovery: () => undefined,
    ensureSession: async () => true,
  });
  assert.deepEqual(await disabled.restore(), { outcome: 'unavailable' });
}

assert.equal(
  restoreOutcomeText('en', { outcome: 'restored', granted: 0 }),
  'No new purchases to restore',
);
assert.equal(
  restoreOutcomeText('en', { outcome: 'restored', granted: 2 }),
  'Purchases restored (2 confirmed)',
);
assert.equal(
  restoreOutcomeText('ko', { outcome: 'needs-session' }),
  '구매를 복원하려면 게임 서버 세션이 필요합니다',
);
assert.match(restoreOutcomeText('en', { outcome: 'incomplete', granted: 0 }), /not confirmed yet/u);
assert.equal(
  restoreOutcomeText('en', { outcome: 'incomplete', granted: 2 }),
  'Purchases restored (2); others are not confirmed yet. Try again later.',
);
assert.match(restoreOutcomeText('en', { outcome: 'failed' }), /Could not restore/u);

console.info('Starter Restore Purchases passed.');
