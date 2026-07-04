import type { AdPlacements } from '@mpgd/ad-placements';
import { createInMemoryEntitlementLedger } from '@mpgd/backend-entitlement-ledger';
import { createInMemoryLeaderboardLedger } from '@mpgd/backend-leaderboard-ledger';
import { createLiveOpsHttpBackendApi, liveOpsBackendEndpoints } from '@mpgd/liveops-client';
import type { ProductCatalog } from '@mpgd/product-catalog';

import { createInProcessLiveOpsBackendTransport, createLiveOpsBackendApiHandler } from './index';

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

const entitlementLedger = createInMemoryEntitlementLedger();
const leaderboardLedger = createInMemoryLeaderboardLedger();
const handler = createLiveOpsBackendApiHandler({
  catalog,
  placements,
  entitlementLedger,
  leaderboardLedger,
  now: () => '2026-07-04T00:00:00.000Z',
});
const backend = createLiveOpsHttpBackendApi({
  transport: createInProcessLiveOpsBackendTransport(handler),
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
const missing = await handler.handle({
  method: 'POST',
  endpoint: '/liveops/missing' as typeof liveOpsBackendEndpoints.verifyPurchase,
  body: {},
});

assertEqual(purchase.verified, true, 'purchase should be verified');
assertEqual(duplicatePurchase.alreadyProcessed, true, 'purchase should dedupe');
assertEqual(reward.granted, true, 'reward should be granted');
assertEqual(score.submitted, true, 'score should be recorded');
assertEqual(entitlementLedger.listTransactions().length, 2, 'two grants should be recorded');
assertEqual(leaderboardLedger.listTransactions().length, 1, 'one score should be recorded');
assertEqual(missing.status, 404, 'unknown endpoint should fail closed');

console.log('LiveOps backend API handler smoke test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
