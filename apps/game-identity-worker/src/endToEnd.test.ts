import assert from 'node:assert/strict';

import {
  createGuestServerSession,
  createGuestSessionCoordinator,
  createGuestSessionHttpBackend,
} from '@mpgd/game-services/guest-session';
import type { SecureCredentialStore } from '@mpgd/platform';

import {
  createWorkerFetchHandler,
  type GameServicesEvidenceVerifierBinding,
  type GameServicesPurchaseGrantFinalizerBinding,
  type GameServicesWorkerEnv,
} from '../../game-services-worker/src/handler.js';
import {
  asWorkerNotificationRpcResult,
  endWorkerNotificationSession,
} from '../../game-services-worker/src/notificationsHandler.js';
import { deriveObfuscatedAccountId } from './accountBinding.js';
import {
  createIdentityBindings,
  createIdentityFetchHandler,
  resolveIdentityService,
} from './handler.js';
import { createMemoryIdentityStore } from './store.js';

/**
 * In-process, end to end: the client's guest-session coordinator talks HTTP
 * to the identity Worker, and the game-services Worker authenticates the
 * same access token through the identity Worker's service bindings (ingress
 * auth for a purchase route, notification sessions for a notifications
 * route). Logout ends the notification session through the game-services
 * binding the identity Worker holds.
 */

const identityBase = 'https://identity.example.test';
const gameServicesBase = 'https://game-services.example.test';
// The game-services Worker reads the real clock (purchase times, session ends), so the identity clock starts there.
let clock = Date.now();
const now = () => clock;
const store = createMemoryIdentityStore();

// The game-services Worker, as wired in docs/CLOUDFLARE_WORKER_DEPLOY.md: every identity binding
// points at the identity Worker. The verifier and finalizer stand in for the store boundary.
const verifiedPurchases: string[] = [];
const androidVerifier: GameServicesEvidenceVerifierBinding = {
  async verifyPurchase(input) {
    verifiedPurchases.push(input.request.playerId);
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
let gameServicesEnv: GameServicesWorkerEnv;
const endedSessions: string[] = [];
const endAnswers: unknown[] = [];
const identityEnv = {
  MPGD_STORE: 'memory',
  GAME_SERVICES: {
    async endNotificationSession(input: { readonly sessionId: string }) {
      endedSessions.push(input.sessionId);
      const answer = await asWorkerNotificationRpcResult(() =>
        endWorkerNotificationSession(gameServicesEnv, input),
      );
      endAnswers.push(answer);
      return answer;
    },
  },
} as const;
const identityBindings = createIdentityBindings(
  resolveIdentityService(identityEnv, { store, now }),
);
gameServicesEnv = {
  MPGD_STORE: 'memory',
  GAME_SERVICES_INGRESS_AUTH: identityBindings.ingressAuth,
  GAME_SERVICES_NOTIFICATIONS_AUTH: identityBindings.notificationSessions,
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
const identityFetch = createIdentityFetchHandler(identityEnv, { store, now });
const gameServicesFetch = createWorkerFetchHandler(gameServicesEnv);

// The device: secure storage and the coordinator over HTTP.
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
  backend: createGuestSessionHttpBackend({
    baseUrl: identityBase,
    fetch: ((request: Request) => {
      assert.equal(new URL(request.url).origin, identityBase);
      return identityFetch(request);
    }) as typeof globalThis.fetch,
  }),
  credentials,
  installationId: 'install-e2e-0001',
  now,
});
const serverSession = createGuestServerSession(coordinator, { now });
const guest = await coordinator.start();
assert.deepEqual(serverSession.current(), {
  playerId: guest.serverUserId,
  sessionId: guest.sessionFamilyId,
});

async function purchase(playerId: string, idempotencyKey: string): Promise<Response> {
  const headers = await serverSession.getHeaders();
  return gameServicesFetch(
    new Request(`${gameServicesBase}/game-services/purchases/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        target: 'android',
        playerId,
        productId: 'COINS_100',
        platformTransactionId: `txn-${idempotencyKey}`,
        idempotencyKey,
        purchasedAt: new Date(clock).toISOString(),
      }),
    }),
  );
}

async function consent(): Promise<Response> {
  const headers = await serverSession.getHeaders();
  return gameServicesFetch(
    new Request(`${gameServicesBase}/game-services/notifications/consent`, { headers }),
  );
}

// A purchase for the server player is verified and granted.
const granted = await purchase(guest.serverUserId, 'e2e-purchase-1');
assert.equal(granted.status, 200, await granted.clone().text());
assert.equal((await granted.json() as { readonly verified: boolean }).verified, true);
assert.deepEqual(verifiedPurchases, [guest.serverUserId]);
// The ingress binding pins the player: the native shell's local player id is refused.
const localPlayer = await purchase('android-local-player', 'e2e-purchase-2');
assert.equal(localPlayer.status, 403);
assert.equal((await localPlayer.json() as { readonly error: string }).error, 'PLAYER_ID_MISMATCH');
assert.deepEqual(verifiedPurchases, [guest.serverUserId]);
// The account binding the Play boundary would ask for is this player's.
assert.equal(
  await identityBindings.googlePlayAccountBinding.resolveObfuscatedAccountId({ playerId: guest.serverUserId }),
  await deriveObfuscatedAccountId(guest.serverUserId),
);

// The notifications session routes take the same header.
assert.equal((await consent()).status, 200);

// After the access token expires, getHeaders refreshes it and the session continues.
const firstHeader = await serverSession.getHeaders();
clock += 16 * 60 * 1000;
const third = await purchase(guest.serverUserId, 'e2e-purchase-3');
assert.equal(third.status, 200);
assert.notDeepEqual(await serverSession.getHeaders(), firstHeader);
assert.equal(coordinator.current()?.sessionFamilyId, guest.sessionFamilyId);
assert.equal((await consent()).status, 200);

// Logout revokes the family: the identity Worker ends its notification session
// on the game-services Worker, and the old token authenticates nowhere.
const lastHeader = await serverSession.getHeaders();
await coordinator.logout();
assert.deepEqual(endedSessions, [guest.sessionFamilyId]);
// The game-services Worker took the end (a failure would only be logged by the identity Worker).
assert.equal((endAnswers[0] as { readonly ok?: unknown }).ok, true);
const afterLogout = await gameServicesFetch(
  new Request(`${gameServicesBase}/game-services/notifications/consent`, {
    headers: lastHeader,
  }),
);
assert.equal(afterLogout.status, 401);
const purchaseAfterLogout = await gameServicesFetch(
  new Request(`${gameServicesBase}/game-services/purchases/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...lastHeader },
    body: JSON.stringify({
      target: 'android',
      playerId: guest.serverUserId,
      productId: 'COINS_100',
      platformTransactionId: 'txn-e2e-purchase-4',
      idempotencyKey: 'e2e-purchase-4',
      purchasedAt: new Date(clock).toISOString(),
    }),
  }),
);
assert.equal(purchaseAfterLogout.status, 401);

console.info(
  'Guest identity end to end (coordinator -> identity Worker -> game-services Worker) passed.',
);
