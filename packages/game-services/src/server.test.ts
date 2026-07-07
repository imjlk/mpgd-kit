import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import {
  createGameServicesHttpBackendApi,
  gameServicesBackendEndpoints,
} from '@mpgd/game-services';

import {
  createGameServicesBackend,
  createGameServicesBackendApiHandler,
  createGameServicesHttpFetchHandler,
  createGameServicesRouter,
  createGameServicesRpcFetchHandler,
  createInMemoryGameServicesStore,
  createInProcessGameServicesBackendTransport,
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

const store = createInMemoryGameServicesStore();
const handler = createGameServicesBackendApiHandler({
  catalog,
  placements,
  store,
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
assertEqual(redditScore.submitted, true, 'reddit score should be recorded');
assertEqual((await store.listEntitlementTransactions()).length, 2, 'two grants should be recorded');
assertEqual((await store.listLeaderboardTransactions()).length, 2, 'two scores should be recorded');
assertEqual(missing.status, 404, 'unknown endpoint should fail closed');
assertEqual(
  invalidTransportRequest.status,
  400,
  'invalid in-process request bodies should return 400 instead of rejecting',
);

const rpcStore = createInMemoryGameServicesStore();
const rpcBackend = createGameServicesBackend({
  catalog,
  placements,
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

assertEqual(httpHealthBody.version, 'test-http', 'HTTP health should expose handler version');
assertEqual(malformedJson.status, 400, 'malformed JSON should return 400');

const collisionStore = createInMemoryGameServicesStore();
const collisionBackend = createGameServicesBackend({
  catalog,
  placements,
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

console.log('GameServices backend API handler smoke test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
