import assert from 'node:assert/strict';

import {
  AccountDeletionError,
  createAccountDeletionClient,
} from '@mpgd/game-services/account-deletion';
import {
  createGuestServerSession,
  createGuestSessionCoordinator,
  createGuestSessionHttpBackend,
  guestIdentityHttpRoutes,
} from '@mpgd/game-services/guest-session';
import type { SecureCredentialStore } from '@mpgd/platform';

import {
  createWorkerFetchHandler,
  type GameServicesEvidenceVerifierBinding,
  type GameServicesPurchaseGrantFinalizerBinding,
  type GameServicesWorkerEnv,
} from '../../game-services-worker/src/handler.js';
import {
  createIdentityBindings,
  createIdentityFetchHandler,
  resolveIdentityService,
} from './handler.js';
import { createMemoryIdentityStore } from './store.js';

/**
 * In-process, end to end (L3b): a device's guest session asks the identity
 * Worker for a deletion confirmation with its refresh token, the
 * game-services Worker's deletion route checks it through the identity
 * Worker's AccountDeletion binding, has the identity Worker delete the
 * player, and erases the game data. Afterwards every token of the deleted
 * player is refused: the access token on both auth bindings, the refresh
 * token (the retry grace included), and the confirmation.
 */

const identityBase = 'https://identity.example.test';
const gameServicesBase = 'https://game-services.example.test';
let clock = Date.now();
const now = () => clock;
const store = createMemoryIdentityStore();
const identityEnv = { MPGD_STORE: 'memory' } as const;
const identityBindings = createIdentityBindings(
  resolveIdentityService(identityEnv, { store, now }),
);
const identityFetch = createIdentityFetchHandler(identityEnv, { store, now });

const androidVerifier: GameServicesEvidenceVerifierBinding = {
  async verifyPurchase(input) {
    return {
      status: 'verified',
      verificationId: `play:${input.request.idempotencyKey}`,
      verifiedAt: new Date(clock).toISOString(),
    };
  },
  async verifyAdReward() {
    return { status: 'rejected', reason: 'NOT_USED' };
  },
};
const androidFinalizer: GameServicesPurchaseGrantFinalizerBinding = {
  async finalizePurchaseGrant() {
    return { status: 'completed', action: 'consume', alreadyCompleted: false };
  },
};
const gameServicesEnv: GameServicesWorkerEnv = {
  MPGD_STORE: 'memory',
  GAME_SERVICES_INGRESS_AUTH: identityBindings.ingressAuth,
  GAME_SERVICES_NOTIFICATIONS_AUTH: identityBindings.notificationSessions,
  GAME_SERVICES_ACCOUNT_DELETION: identityBindings.accountDeletion,
  GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER: androidVerifier,
  GAME_SERVICES_ANDROID_PURCHASE_FINALIZER: androidFinalizer,
  MPGD_NOTIFICATIONS_CATALOG: {
    version: '2030-01-01',
    defaultLocale: 'en',
    topics: [
      {
        id: 'daily-reward',
        purpose: 'service',
        channels: ['remote'],
        route: '/?entry=daily',
        copy: { en: { title: 'Daily reward', body: 'Your reward is ready.' } },
        targets: { android: { channelId: 'rewards' }, ios: {} },
      },
    ],
  },
};
const gameServicesFetch = createWorkerFetchHandler(gameServicesEnv);
const identityHttp = ((request: Request) => {
  assert.equal(new URL(request.url).origin, identityBase);
  return identityFetch(request);
}) as typeof globalThis.fetch;
const gameServicesHttp = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  assert.equal(new URL(request.url).origin, gameServicesBase);
  return gameServicesFetch(request);
}) as typeof globalThis.fetch;

/** A device: its secure store, guest session, and deletion client. */
async function device(installationId: string) {
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
  const coordinator = createGuestSessionCoordinator({
    backend: createGuestSessionHttpBackend({ baseUrl: identityBase, fetch: identityHttp }),
    credentials,
    installationId,
    now,
  });
  const session = createGuestServerSession(coordinator, { now });
  const guest = await coordinator.start();
  const deletion = createAccountDeletionClient({
    baseUrl: gameServicesBase,
    getHeaders: () => session.getHeaders(),
    fetch: gameServicesHttp,
  });
  return { coordinator, session, guest, deletion, values };
}

function purchase(headers: Readonly<Record<string, string>>, playerId: string, key: string) {
  return gameServicesFetch(
    new Request(`${gameServicesBase}/game-services/purchases/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        target: 'android',
        playerId,
        productId: 'COINS_100',
        platformTransactionId: `txn-${key}`,
        idempotencyKey: key,
        purchasedAt: new Date(clock).toISOString(),
      }),
    }),
  );
}

function consent(headers: Readonly<Record<string, string>>) {
  return gameServicesFetch(
    new Request(`${gameServicesBase}/game-services/notifications/consent`, { headers }),
  );
}

const player = await device('install-delete-e2e-1');
const bystander = await device('install-delete-e2e-2');
const playerId = player.guest.serverUserId;
assert.equal(
  (await purchase(await player.session.getHeaders(), playerId, 'delete-e2e-1')).status,
  200,
);
assert.equal((await consent(await player.session.getHeaders())).status, 200);
// A refresh, so the replaced token sits inside the retry grace when the player is deleted.
const firstRefreshToken = player.values.get('mpgd.guest.refresh');
clock += 16 * 60 * 1000;
const header = await player.session.getHeaders();
assert.notEqual(player.values.get('mpgd.guest.refresh'), firstRefreshToken);

// The access token alone deletes nothing, and neither does another player's confirmation.
await assert.rejects(
  player.deletion.deleteAccount(),
  (error: unknown) =>
    error instanceof AccountDeletionError && error.code === 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
);
const bystanderConfirmation = await bystander.session.requestAccountDeletionConfirmation?.();
assert.ok(bystanderConfirmation !== undefined);
await assert.rejects(
  player.deletion.deleteAccount({ confirmation: bystanderConfirmation }),
  (error: unknown) =>
    error instanceof AccountDeletionError && error.code === 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
);
assert.equal((await consent(header)).status, 200, 'still signed in');

// With the identity Worker's confirmation (the refresh token's proof), the account goes.
const confirmation = await player.session.requestAccountDeletionConfirmation?.();
assert.ok(confirmation !== undefined);
const receipt = await player.deletion.deleteAccount({ confirmation });
assert.equal(receipt.status, 'deleted');
assert.equal(receipt.retainedPurchaseRecords, 1);

// Every token of the deleted player is refused at once.
assert.equal((await consent(header)).status, 401, 'notifications session binding');
assert.equal((await purchase(header, playerId, 'delete-e2e-2')).status, 401, 'ingress binding');
await assert.rejects(
  player.deletion.deleteAccount({ confirmation }),
  (error: unknown) => error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED',
);
for (const refreshToken of [player.values.get('mpgd.guest.refresh'), firstRefreshToken]) {
  const refused = await identityFetch(
    new Request(`${identityBase}${guestIdentityHttpRoutes.refresh}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }),
  );
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: 'GUEST_SESSION_REJECTED' });
}
await assert.rejects(player.coordinator.refresh(), { code: 'GUEST_SESSION_REJECTED' });
await assert.rejects(player.session.requestAccountDeletionConfirmation?.() ?? Promise.resolve(), {
  code: 'GUEST_SESSION_NOT_READY',
});
assert.equal(
  await identityBindings.googlePlayAccountBinding.resolveObfuscatedAccountId({ playerId }),
  null,
);
assert.deepEqual(
  await identityBindings.accountDeletion.verifyAccountDeletionConfirmation({ playerId, confirmation }),
  { confirmed: false },
);

// The other device is untouched, and its confirmation was not used up by the refusal above.
assert.equal((await consent(await bystander.session.getHeaders())).status, 200);
assert.equal(
  (await bystander.deletion.deleteAccount({ confirmation: bystanderConfirmation })).status,
  'deleted',
);

console.info('Account deletion end to end (identity Worker -> game-services Worker) passed.');
