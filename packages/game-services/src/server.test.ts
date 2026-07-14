import type { AnalyticsEvent } from '@mpgd/analytics';
import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import {
  createGameServicesHttpBackendApi,
  gameServicesBackendEndpoints,
} from '@mpgd/game-services';

import {
  createDevelopmentGameServicesEvidenceVerifier,
  createGameServicesBackend,
  createGameServicesBackendApiHandler,
  createGameServicesHttpFetchHandler,
  createGameServicesRouter,
  createGameServicesRpcFetchHandler,
  createInMemoryGameServicesStore,
  createInProcessGameServicesBackendTransport,
  type GameServicesEvidenceVerifier,
} from './index';

const catalog = {
  version: 'test',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: {
        type: 'currency',
        currency: 'coin',
        amount: 100,
      },
      platformProductIds: {
        android: 'coins_100_android',
      },
    },
  ],
} as const satisfies ProductCatalog;

const placements = {
  version: 'test',
  placements: [
    {
      id: 'CONTINUE_AFTER_FAIL',
      type: 'rewarded',
      reward: {
        type: 'currency',
        currency: 'coin',
        amount: 10,
      },
      frequencyCap: {
        cooldownSeconds: 0,
      },
      platformPlacementIds: {
        android: 'reward_android',
      },
    },
  ],
} as const satisfies AdPlacements;
const evidenceVerifier = createDevelopmentGameServicesEvidenceVerifier(
  () => '2026-07-04T00:00:00.000Z',
);

const store = createInMemoryGameServicesStore();
const handler = createGameServicesBackendApiHandler({
  catalog,
  placements,
  store,
  evidenceVerifier,
  now: () => '2026-07-04T00:00:00.000Z',
  version: 'test-http',
});
const backend = createGameServicesHttpBackendApi({
  transport: createInProcessGameServicesBackendTransport(handler),
});

const purchase = await backend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-1',
  productId: 'COINS_100',
  platformTransactionId: 'txn-1',
  idempotencyKey: 'purchase-1',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const duplicatePurchase = await backend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-1',
  productId: 'COINS_100',
  platformTransactionId: 'txn-1',
  idempotencyKey: 'purchase-1',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const reward = await backend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-1',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-1',
  idempotencyKey: 'reward-1',
  completedAt: '2026-07-04T00:00:01.000Z',
});
const score = await backend.leaderboard.recordScore({
  target: 'android',
  playerId: 'player-1',
  leaderboardId: 'default',
  score: 1000,
  runId: 'run-1',
  submittedAt: '2026-07-04T00:00:02.000Z',
});
const redditScore = await backend.leaderboard.recordScore({
  target: 'reddit',
  playerId: 'player-1',
  leaderboardId: 'default',
  score: 1200,
  runId: 'reddit-run-1',
  submittedAt: '2026-07-04T00:00:03.000Z',
});
const missing = await handler.handle({
  method: 'POST',
  endpoint: '/game-services/missing' as typeof gameServicesBackendEndpoints.verifyPurchase,
  body: {},
});
const invalidTransportRequest = await handler.handle({
  method: 'POST',
  endpoint: gameServicesBackendEndpoints.verifyPurchase,
  body: {},
});

assertEqual(purchase.verified, true, 'purchase should be verified');
assertEqual(duplicatePurchase.alreadyProcessed, true, 'purchase should dedupe');
assertEqual(reward.granted, true, 'reward should be granted');
assertEqual(score.submitted, true, 'score should be recorded');
assertEqual(score.rank, 1, 'first leaderboard score should start at rank one');
assertEqual(redditScore.submitted, true, 'reddit score should be recorded');
assertEqual(
  redditScore.rank,
  1,
  'higher cross-target score should rank ahead within the shared leaderboard id',
);
assertEqual((await store.listEntitlementTransactions()).length, 2, 'two grants should be recorded');
assertEqual(
  (await store.listEntitlementTransactions())[0]?.payload.evidenceVerificationId,
  'development:purchase:android:txn-1',
  'ledger grants should retain the server verification identity',
);
assertEqual((await store.listLeaderboardTransactions()).length, 2, 'two scores should be recorded');
assertEqual(
  (await store.listLeaderboardTransactions())[0]?.ledgerEntryId,
  redditScore.ledgerEntryId,
  'leaderboard transactions should sort higher scores first across targets',
);
assertEqual(missing.status, 404, 'unknown endpoint should fail closed');
assertEqual(
  invalidTransportRequest.status,
  400,
  'invalid in-process request bodies should return 400 instead of rejecting',
);

const failClosedStore = createInMemoryGameServicesStore();
const failClosedBackend = createGameServicesBackend({
  catalog,
  placements,
  store: failClosedStore,
});
const unavailablePurchase = await failClosedBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-fail-closed',
  productId: 'COINS_100',
  platformTransactionId: 'txn-unverified',
  idempotencyKey: 'purchase-unverified',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const unavailableReward = await failClosedBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-fail-closed',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-unverified',
  idempotencyKey: 'reward-unverified',
  completedAt: '2026-07-04T00:00:01.000Z',
});

assertEqual(unavailablePurchase.verified, false, 'missing purchase verifier should fail closed');
assertEqual(
  unavailablePurchase.reason,
  'EVIDENCE_VERIFIER_UNAVAILABLE',
  'missing purchase verifier should expose an operational reason',
);
assertEqual(unavailableReward.granted, false, 'missing reward verifier should fail closed');
assertEqual(
  (await failClosedStore.listEntitlementTransactions()).length,
  0,
  'unverified evidence must never reach the entitlement ledger',
);

const nonGrantingVerifier = {
  async verifyPurchase() {
    return { status: 'pending', reason: 'PROVIDER_PENDING' } as const;
  },
  async verifyAdReward() {
    throw new Error('provider unavailable');
  },
} satisfies GameServicesEvidenceVerifier;
const nonGrantingStore = createInMemoryGameServicesStore();
const nonGrantingBackend = createGameServicesBackend({
  catalog,
  placements,
  store: nonGrantingStore,
  evidenceVerifier: nonGrantingVerifier,
});
const pendingPurchase = await nonGrantingBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-pending',
  productId: 'COINS_100',
  platformTransactionId: 'txn-pending',
  idempotencyKey: 'purchase-pending',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const verifierErrorReward = await nonGrantingBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-error',
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'reward-error',
  completedAt: '2026-07-04T00:00:01.000Z',
});

assertEqual(pendingPurchase.verified, false, 'pending provider evidence must not grant');
assertEqual(pendingPurchase.reason, 'PROVIDER_PENDING', 'pending reasons should be preserved');
assertEqual(verifierErrorReward.granted, false, 'verifier errors must not grant');
assertEqual(
  verifierErrorReward.reason,
  'EVIDENCE_VERIFIER_ERROR',
  'verifier exceptions should become stable fail-closed responses',
);
assertEqual(
  (await nonGrantingStore.listEntitlementTransactions()).length,
  0,
  'pending and failed evidence verification must not reach the ledger',
);

const invalidTimestampStore = createInMemoryGameServicesStore();
const invalidTimestampBackend = createGameServicesBackend({
  catalog,
  placements,
  store: invalidTimestampStore,
  evidenceVerifier: {
    async verifyPurchase() {
      return {
        status: 'verified',
        verificationId: 'provider:purchase:invalid-timestamp',
        verifiedAt: 'not-a-date',
      } as const;
    },
    async verifyAdReward() {
      return { status: 'rejected', reason: 'NOT_TESTED' } as const;
    },
  },
});
const invalidTimestampPurchase = await invalidTimestampBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-invalid-timestamp',
  productId: 'COINS_100',
  platformTransactionId: 'txn-invalid-timestamp',
  idempotencyKey: 'purchase-invalid-timestamp',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});

assertEqual(invalidTimestampPurchase.verified, false, 'invalid verifier timestamps must reject');
assertEqual(
  invalidTimestampPurchase.reason,
  'EVIDENCE_VERIFIER_ERROR',
  'invalid verifier timestamps should use the stable verifier error reason',
);
assertEqual(
  (await invalidTimestampStore.listEntitlementTransactions()).length,
  0,
  'invalid verifier timestamps must not reach the ledger',
);

let timeoutSignalAborted = false;
const timeoutStore = createInMemoryGameServicesStore();
const timeoutBackend = createGameServicesBackend({
  catalog,
  placements,
  store: timeoutStore,
  evidenceVerificationTimeoutMs: 5,
  evidenceVerifier: {
    verifyPurchase({ signal }) {
      return new Promise<never>(() => {
        signal.addEventListener('abort', () => {
          timeoutSignalAborted = signal.aborted;
        }, { once: true });
      });
    },
    async verifyAdReward() {
      return { status: 'rejected', reason: 'NOT_TESTED' } as const;
    },
  },
});
const timeoutPurchase = await timeoutBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-timeout',
  productId: 'COINS_100',
  platformTransactionId: 'txn-timeout',
  idempotencyKey: 'purchase-timeout',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});

assertEqual(timeoutPurchase.verified, false, 'hung verifiers must fail closed');
assertEqual(
  timeoutPurchase.reason,
  'EVIDENCE_VERIFIER_TIMEOUT',
  'hung verifiers should expose the stable timeout reason',
);
assertEqual(timeoutSignalAborted, true, 'verifier timeout should abort the provider signal');
assertEqual(
  (await timeoutStore.listEntitlementTransactions()).length,
  0,
  'timed out verifiers must not reach the ledger',
);

let verifierAvailable = true;
const retryStore = createInMemoryGameServicesStore();
const retryBackend = createGameServicesBackend({
  catalog,
  placements,
  store: retryStore,
  evidenceVerifier: {
    async verifyPurchase() {
      return verifierAvailable
        ? {
            status: 'verified',
            verificationId: 'provider:purchase:retry',
            verifiedAt: '2026-07-04T00:00:00.000Z',
          }
        : { status: 'pending', reason: 'PROVIDER_PENDING' };
    },
    async verifyAdReward() {
      return verifierAvailable
        ? {
            status: 'verified',
            verificationId: 'provider:reward:retry',
            verifiedAt: '2026-07-04T00:00:00.000Z',
          }
        : { status: 'rejected', reason: 'PROVIDER_UNAVAILABLE' };
    },
  },
});
await retryBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-retry',
  productId: 'COINS_100',
  platformTransactionId: 'txn-retry',
  idempotencyKey: 'purchase-retry',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
await retryBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-retry',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-retry',
  idempotencyKey: 'reward-retry',
  completedAt: '2026-07-04T00:00:00.000Z',
});
verifierAvailable = false;
const purchaseRetry = await retryBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-retry',
  productId: 'COINS_100',
  platformTransactionId: 'txn-retry-changed',
  idempotencyKey: 'purchase-retry',
  purchasedAt: '2026-07-04T00:00:01.000Z',
});
const rewardRetry = await retryBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-retry',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-retry-changed',
  idempotencyKey: 'reward-retry',
  completedAt: '2026-07-04T00:00:01.000Z',
});

assertEqual(purchaseRetry.verified, true, 'granted purchase retries should bypass provider drift');
assertEqual(purchaseRetry.alreadyProcessed, true, 'purchase retries should return ledger state');
assertEqual(rewardRetry.granted, true, 'granted reward retries should bypass provider drift');
assertEqual(rewardRetry.alreadyProcessed, true, 'reward retries should return ledger state');

const replayStore = createInMemoryGameServicesStore();
const replayBackend = createGameServicesBackend({
  catalog,
  placements,
  store: replayStore,
  evidenceVerifier: {
    async verifyPurchase() {
      return {
        status: 'verified',
        verificationId: 'provider:purchase:replayed',
        verifiedAt: '2026-07-04T00:00:00.000Z',
      } as const;
    },
    async verifyAdReward() {
      return {
        status: 'verified',
        verificationId: 'provider:reward:replayed',
        verifiedAt: '2026-07-04T00:00:00.000Z',
      } as const;
    },
  },
});
await replayBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-replay',
  productId: 'COINS_100',
  platformTransactionId: 'txn-replayed',
  idempotencyKey: 'purchase-replay-1',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const replayedPurchase = await replayBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-replay',
  productId: 'COINS_100',
  platformTransactionId: 'txn-replayed',
  idempotencyKey: 'purchase-replay-2',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
await replayBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-replay',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-replayed',
  idempotencyKey: 'reward-replay-1',
  completedAt: '2026-07-04T00:00:00.000Z',
});
const replayedReward = await replayBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'another-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-replayed',
  idempotencyKey: 'reward-replay-2',
  completedAt: '2026-07-04T00:00:00.000Z',
});

assertEqual(replayedPurchase.verified, false, 'replayed purchase evidence must not grant twice');
assertEqual(
  replayedPurchase.reason,
  'EVIDENCE_ALREADY_PROCESSED',
  'purchase evidence replay should expose a stable reason',
);
assertEqual(replayedReward.granted, false, 'replayed reward evidence must not grant twice');
assertEqual(
  (await replayStore.listEntitlementTransactions()).length,
  2,
  'evidence replay protection should retain only one grant per source identity',
);

const invalidPayloadStore = createInMemoryGameServicesStore();
const invalidPayloadBackend = createGameServicesBackend({
  catalog,
  placements,
  store: invalidPayloadStore,
  evidenceVerifier: {
    async verifyPurchase() {
      return {
        status: 'verified',
        verificationId: 'provider:purchase:invalid-payload',
        verifiedAt: '2026-07-04T00:00:00.000Z',
        payload: { invalidNumber: Number.POSITIVE_INFINITY },
      } as const;
    },
    async verifyAdReward() {
      return { status: 'rejected', reason: 'NOT_TESTED' } as const;
    },
  },
});
const invalidPayloadPurchase = await invalidPayloadBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-invalid-payload',
  productId: 'COINS_100',
  platformTransactionId: 'txn-invalid-payload',
  idempotencyKey: 'purchase-invalid-payload',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});

assertEqual(
  invalidPayloadPurchase.verified,
  false,
  'non-finite verifier payloads must fail closed',
);
assertEqual(
  invalidPayloadPurchase.reason,
  'EVIDENCE_VERIFIER_ERROR',
  'malformed verifier decisions should use the verifier error reason',
);
assertEqual(
  (await invalidPayloadStore.listEntitlementTransactions()).length,
  0,
  'malformed verifier payloads must not reach the ledger',
);

const rpcStore = createInMemoryGameServicesStore();
const rpcBackend = createGameServicesBackend({
  catalog,
  placements,
  evidenceVerifier,
  store: rpcStore,
  now: () => '2026-07-04T00:00:00.000Z',
  version: 'test-rpc',
});
const rpcFetch = createGameServicesRpcFetchHandler(createGameServicesRouter(rpcBackend), {
  ...(rpcBackend.version === undefined ? {} : { version: rpcBackend.version }),
});
const rpcHealth = await rpcFetch(new Request('https://game-services.test/health'));
const rpcHealthBody = await rpcHealth.json() as { readonly version: string };

assertEqual(rpcHealth.status, 200, 'oRPC fetch handler should expose health');
assertEqual(rpcHealthBody.version, 'test-rpc', 'oRPC health should expose backend version');

const httpFetch = createGameServicesHttpFetchHandler(handler);
const httpHealth = await httpFetch(new Request('https://game-services.test/health'));
const httpHealthBody = await httpHealth.json() as { readonly version: string };
const malformedJson = await httpFetch(
  new Request('https://game-services.test/game-services/purchases/verify', {
    method: 'POST',
    body: '{',
  }),
);
const methodNotAllowed = await httpFetch(
  new Request('https://game-services.test/game-services/purchases/verify', {
    method: 'GET',
  }),
);
const corsFetch = createGameServicesHttpFetchHandler(handler, {
  corsHeaders: {
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-origin': 'https://game.example',
  },
});
const corsPreflight = await corsFetch(
  new Request('https://game-services.test/game-services/purchases/verify', {
    method: 'OPTIONS',
    headers: {
      'access-control-request-headers': 'content-type',
      'access-control-request-method': 'POST',
      origin: 'https://game.example',
    },
  }),
);
const corsPost = await corsFetch(
  new Request('https://game-services.test/game-services/purchases/verify', {
    method: 'POST',
    body: '{}',
  }),
);
const corsHealth = await corsFetch(new Request('https://game-services.test/health'));

assertEqual(httpHealthBody.version, 'test-http', 'HTTP health should expose handler version');
assertEqual(malformedJson.status, 400, 'malformed JSON should return 400');
assertEqual(methodNotAllowed.status, 405, 'HTTP handler should reject non-POST writes');
assertEqual(corsPreflight.status, 204, 'HTTP handler should answer CORS preflight');
assertEqual(corsPost.status, 400, 'HTTP handler should reject invalid CORS POST bodies');
assertEqual(corsHealth.status, 200, 'HTTP handler should answer CORS health checks');
assertEqual(
  corsPreflight.headers.get('access-control-allow-origin'),
  'https://game.example',
  'HTTP handler should include configured CORS headers on preflight',
);
assertEqual(
  corsPreflight.headers.get('access-control-allow-methods'),
  'POST, OPTIONS',
  'HTTP handler should include configured CORS methods on preflight',
);
assertEqual(
  corsPreflight.headers.get('access-control-allow-headers'),
  'content-type',
  'HTTP handler should include configured CORS request headers on preflight',
);
assertEqual(
  corsPost.headers.get('access-control-allow-origin'),
  'https://game.example',
  'HTTP handler should include configured CORS headers on error responses',
);
assertEqual(
  corsHealth.headers.get('access-control-allow-origin'),
  'https://game.example',
  'HTTP handler should include configured CORS headers on successful responses',
);

const collisionStore = createInMemoryGameServicesStore();
const collisionBackend = createGameServicesBackend({
  catalog,
  placements,
  evidenceVerifier,
  store: collisionStore,
  now: () => '2026-07-04T00:00:00.000Z',
});
const firstCollisionPurchase = await collisionBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player:a',
  productId: 'COINS_100',
  platformTransactionId: 'txn-collision-1',
  idempotencyKey: 'b:c',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const secondCollisionPurchase = await collisionBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player:a:b',
  productId: 'COINS_100',
  platformTransactionId: 'txn-collision-2',
  idempotencyKey: 'c',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const longPrefixPlayer = `${'a'.repeat(64)}-1`;
const longPrefixTwin = `${'a'.repeat(64)}-2`;

await collisionBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: longPrefixPlayer,
  productId: 'COINS_100',
  platformTransactionId: 'txn-long-1',
  idempotencyKey: 'long-prefix-1',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
await collisionBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: longPrefixTwin,
  productId: 'COINS_100',
  platformTransactionId: 'txn-long-2',
  idempotencyKey: 'long-prefix-2',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});

assertEqual(
  firstCollisionPurchase.alreadyProcessed,
  false,
  'first colon-bearing idempotency key should be new',
);
assertEqual(
  secondCollisionPurchase.alreadyProcessed,
  false,
  'distinct colon-bearing idempotency key should not collide',
);
assertEqual(
  (await collisionStore.listEntitlementTransactions()).length,
  4,
  'ledger entry ids should stay distinct for long shared prefixes',
);

const idempotencyStore = createInMemoryGameServicesStore();
const idempotencyBackend = createGameServicesBackend({
  catalog,
  placements,
  evidenceVerifier,
  store: idempotencyStore,
  now: () => '2026-07-04T00:00:00.000Z',
});
const sharedKeyPurchase = await idempotencyBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-shared',
  productId: 'COINS_100',
  platformTransactionId: 'txn-shared-key',
  idempotencyKey: 'shared-key',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const duplicateSharedKeyPurchase = await idempotencyBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'player-shared',
  productId: 'COINS_100',
  platformTransactionId: 'txn-shared-key-retry',
  idempotencyKey: 'shared-key',
  purchasedAt: '2026-07-04T00:00:00.500Z',
});
const sharedKeyReward = await idempotencyBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-shared',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-shared-key',
  idempotencyKey: 'shared-key',
  completedAt: '2026-07-04T00:00:01.000Z',
});
const duplicateReward = await idempotencyBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'player-shared',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-shared-key-retry',
  idempotencyKey: 'shared-key',
  completedAt: '2026-07-04T00:00:02.000Z',
});
const firstLeaderboardRun = await idempotencyBackend.leaderboard.recordScore({
  target: 'android',
  playerId: 'player-shared',
  leaderboardId: 'default',
  score: 1000,
  runId: 'run-shared',
  platformSubmissionId: 'submission-1',
  submittedAt: '2026-07-04T00:00:03.000Z',
});
const duplicateLeaderboardRun = await idempotencyBackend.leaderboard.recordScore({
  target: 'android',
  playerId: 'player-shared',
  leaderboardId: 'default',
  score: 2000,
  runId: 'run-shared',
  platformSubmissionId: 'submission-2',
  submittedAt: '2026-07-04T00:00:04.000Z',
});
const crossTargetLeaderboardRun = await idempotencyBackend.leaderboard.recordScore({
  target: 'reddit',
  playerId: 'player-shared',
  leaderboardId: 'default',
  score: 3000,
  runId: 'run-shared',
  platformSubmissionId: 'submission-reddit',
  submittedAt: '2026-07-04T00:00:04.500Z',
});
const colonLeaderboardRun = await idempotencyBackend.leaderboard.recordScore({
  target: 'android',
  playerId: 'player:a',
  leaderboardId: 'leaderboard:b',
  score: 500,
  runId: 'run:c',
  submittedAt: '2026-07-04T00:00:05.000Z',
});
const colonLeaderboardTwin = await idempotencyBackend.leaderboard.recordScore({
  target: 'android',
  playerId: 'b:player',
  leaderboardId: 'leaderboard',
  score: 600,
  runId: 'a:run:c',
  submittedAt: '2026-07-04T00:00:06.000Z',
});
const storedLeaderboardRun = await idempotencyStore.getLeaderboardTransaction(
  firstLeaderboardRun.ledgerEntryId,
);
if (storedLeaderboardRun === undefined) {
  throw new Error('leaderboard retry should leave the original transaction readable');
}

assertEqual(
  sharedKeyPurchase.alreadyProcessed,
  false,
  'purchase with shared key should create its own entitlement grant',
);
assertEqual(
  sharedKeyReward.alreadyProcessed,
  false,
  'ad reward with same key should not collide with purchase source',
);
assertEqual(
  sharedKeyPurchase.ledgerEntryId === sharedKeyReward.ledgerEntryId,
  false,
  'purchase and ad reward ledger entries should stay source-scoped',
);
assertEqual(
  duplicateSharedKeyPurchase.alreadyProcessed,
  true,
  'duplicate purchase should be idempotent for source, player, and key',
);
assertEqual(
  duplicateSharedKeyPurchase.ledgerEntryId,
  sharedKeyPurchase.ledgerEntryId,
  'duplicate purchase should ignore changed platform transaction evidence',
);
assertEqual(
  duplicateReward.alreadyProcessed,
  true,
  'duplicate ad reward should be idempotent for source, player, and key',
);
assertEqual(
  duplicateReward.ledgerEntryId,
  sharedKeyReward.ledgerEntryId,
  'duplicate ad reward should reuse the original ledger entry id',
);
assertEqual(
  firstLeaderboardRun.alreadyProcessed,
  false,
  'first leaderboard run should create a score ledger record',
);
assertEqual(
  duplicateLeaderboardRun.alreadyProcessed,
  true,
  'leaderboard retries should dedupe by target, leaderboard, player, and run',
);
assertEqual(
  duplicateLeaderboardRun.ledgerEntryId,
  firstLeaderboardRun.ledgerEntryId,
  'leaderboard retry should reuse the original ledger entry id',
);
assertEqual(
  storedLeaderboardRun.score,
  1000,
  'leaderboard retry should not mutate the original score',
);
assertEqual(
  storedLeaderboardRun.platformSubmissionId,
  'submission-1',
  'leaderboard retry should not mutate the original submission id',
);
assertEqual(
  storedLeaderboardRun.submittedAt,
  '2026-07-04T00:00:03.000Z',
  'leaderboard retry should not mutate the original submission time',
);
assertEqual(
  crossTargetLeaderboardRun.alreadyProcessed,
  false,
  'same leaderboard run on another target should create a separate ledger record',
);
assertEqual(
  crossTargetLeaderboardRun.ledgerEntryId === firstLeaderboardRun.ledgerEntryId,
  false,
  'leaderboard target should be part of the idempotency dimensions',
);
assertEqual(
  colonLeaderboardRun.alreadyProcessed,
  false,
  'colon-bearing leaderboard run should be accepted as new',
);
assertEqual(
  colonLeaderboardTwin.alreadyProcessed,
  false,
  'distinct colon-bearing leaderboard run should not collide',
);
assertEqual(
  colonLeaderboardRun.ledgerEntryId === colonLeaderboardTwin.ledgerEntryId,
  false,
  'leaderboard ledger entry ids should encode ambiguous separators safely',
);
assertEqual(
  (await idempotencyStore.listEntitlementTransactions()).length,
  2,
  'source-scoped entitlement idempotency should store two unique grants',
);
assertEqual(
  (await idempotencyStore.listLeaderboardTransactions()).length,
  4,
  'leaderboard idempotency should store four unique run records',
);

const analyticsEvents: AnalyticsEvent[] = [];
const analyticsBackend = createGameServicesBackend({
  catalog,
  placements,
  evidenceVerifier,
  analyticsSessionId: 'server-session',
  analytics: {
    track(event) {
      analyticsEvents.push(event);
    },
  },
  now: () => '2026-07-04T00:00:00.000Z',
});
const unknownProduct = await analyticsBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'analytics-player',
  productId: 'COINS_500',
  platformTransactionId: 'txn-unknown-product',
  idempotencyKey: 'analytics-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const unknownPlacement = await analyticsBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'analytics-player',
  placementId: 'STAGE_END_INTERSTITIAL',
  platformImpressionId: 'impression-unknown-placement',
  idempotencyKey: 'analytics-reward',
  completedAt: '2026-07-04T00:00:01.000Z',
});
const analyticsLeaderboard = await analyticsBackend.leaderboard.recordScore({
  target: 'android',
  playerId: 'analytics-player',
  leaderboardId: 'default',
  score: 900,
  runId: 'analytics-run',
  submittedAt: '2026-07-04T00:00:02.000Z',
});
const analyticsPurchase = await analyticsBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'analytics-player',
  productId: 'COINS_100',
  platformTransactionId: 'txn-analytics-success',
  idempotencyKey: 'analytics-purchase-success',
  purchasedAt: '2026-07-04T00:00:03.000Z',
});
const analyticsReward = await analyticsBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'analytics-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-analytics-success',
  idempotencyKey: 'analytics-reward-success',
  completedAt: '2026-07-04T00:00:04.000Z',
});

assertEqual(unknownProduct.verified, false, 'unknown products should be rejected');
assertEqual(
  unknownProduct.reason,
  'UNKNOWN_PRODUCT',
  'unknown product rejection should preserve reason',
);
assertEqual(unknownPlacement.granted, false, 'unknown placements should be rejected');
assertEqual(
  unknownPlacement.reason,
  'UNKNOWN_PLACEMENT',
  'unknown placement rejection should preserve reason',
);
assertEqual(analyticsLeaderboard.submitted, true, 'analytics backend should record scores');
assertEqual(analyticsPurchase.verified, true, 'analytics backend should verify known products');
assertEqual(analyticsReward.granted, true, 'analytics backend should grant known rewards');
assertEqual(
  analyticsEvents.map((event) => event.name).join(','),
  'purchase_rejected,rewarded_ad_rejected,leaderboard_recorded,purchase_granted,rewarded_ad_granted',
  'backend should emit analytics for rejected and granted purchase/reward outcomes',
);
assertEqual(
  analyticsEvents.map((event) => event.sessionId).join(','),
  'server-session,server-session,server-session,server-session,server-session',
  'backend analytics should use the configured session id',
);
assertEqual(
  analyticsEvents[0]?.properties.reason,
  'UNKNOWN_PRODUCT',
  'purchase analytics should include rejection reason',
);
assertEqual(
  analyticsEvents[1]?.properties.reason,
  'UNKNOWN_PLACEMENT',
  'reward analytics should include rejection reason',
);
assertEqual(
  analyticsEvents[2]?.properties.leaderboardId,
  'default',
  'leaderboard analytics should include the leaderboard id',
);
assertEqual(
  analyticsEvents[2]?.properties.score,
  900,
  'leaderboard analytics should include the submitted score',
);
assertEqual(
  analyticsEvents[2]?.properties.ledgerEntryId,
  analyticsLeaderboard.ledgerEntryId,
  'leaderboard analytics should include the ledger entry id',
);
assertEqual(
  analyticsEvents[2]?.properties.alreadyProcessed,
  false,
  'leaderboard analytics should include idempotency state',
);
assertEqual(analyticsEvents[2]?.properties.rank, 1, 'leaderboard analytics should include rank');
assertEqual(
  analyticsEvents[3]?.properties.ledgerEntryId,
  analyticsPurchase.ledgerEntryId,
  'granted purchase analytics should include the ledger entry id',
);
assertEqual(
  analyticsEvents[3]?.properties.alreadyProcessed,
  false,
  'granted purchase analytics should include idempotency state',
);
assertEqual(
  analyticsEvents[4]?.properties.ledgerEntryId,
  analyticsReward.ledgerEntryId,
  'granted reward analytics should include the ledger entry id',
);
assertEqual(
  analyticsEvents[4]?.properties.alreadyProcessed,
  false,
  'granted reward analytics should include idempotency state',
);

const failingAnalyticsBackend = createGameServicesBackend({
  catalog,
  placements,
  evidenceVerifier,
  analytics: {
    track() {
      throw new Error('analytics sink unavailable');
    },
  },
  now: () => '2026-07-04T00:00:00.000Z',
});
const analyticsFailureScore = await failingAnalyticsBackend.leaderboard.recordScore({
  target: 'android',
  playerId: 'failing-analytics-player',
  leaderboardId: 'default',
  score: 700,
  runId: 'failing-analytics-run',
  submittedAt: '2026-07-04T00:00:03.000Z',
});
const analyticsFailurePurchase = await failingAnalyticsBackend.purchases.verifyPurchase({
  target: 'android',
  playerId: 'failing-analytics-purchase-player',
  productId: 'COINS_100',
  platformTransactionId: 'txn-failing-analytics',
  idempotencyKey: 'failing-analytics-purchase',
  purchasedAt: '2026-07-04T00:00:04.000Z',
});
const analyticsFailureReward = await failingAnalyticsBackend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'failing-analytics-reward-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'impression-failing-analytics',
  idempotencyKey: 'failing-analytics-reward',
  completedAt: '2026-07-04T00:00:05.000Z',
});

assertEqual(
  analyticsFailureScore.submitted,
  true,
  'analytics failures should not break backend leaderboard writes',
);
assertEqual(
  analyticsFailurePurchase.verified,
  true,
  'analytics failures should not break backend purchase verification',
);
assertEqual(
  analyticsFailureReward.granted,
  true,
  'analytics failures should not break backend ad reward claims',
);

console.log('GameServices backend API handler smoke test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
