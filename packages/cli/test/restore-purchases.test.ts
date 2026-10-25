import assert from 'node:assert/strict';

import type { MonetizationOperationSummary } from '@mpgd/game-services';
import type { IdentitySession, PlatformGateway } from '@mpgd/platform';

import { createStarterRestorePurchases } from '../templates/phaser-game/src/platform/restorePurchases.js';

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
      summary('commerce-purchase' as MonetizationOperationSummary['kind'], 'pending'),
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

console.info('Starter Restore Purchases passed.');
