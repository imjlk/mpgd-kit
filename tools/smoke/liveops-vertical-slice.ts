import { claimAdReward } from '@mpgd/backend-ad-reward-ledger';
import { createInMemoryEntitlementLedger } from '@mpgd/backend-entitlement-ledger';
import { createInMemoryLeaderboardLedger } from '@mpgd/backend-leaderboard-ledger';
import { verifyPurchase } from '@mpgd/backend-purchase-verifier';
import { createLiveOpsClient, createLiveOpsIdempotencyKey } from '@mpgd/liveops-client';

import type { AdPlacements } from '../../packages/ad-placements/src/index';
import type { ProductCatalog } from '../../packages/product-catalog/src/index';
import { readJsonFile } from '../io';
import { createCapableMockGateway } from './liveops/mock-gateway';

const catalog = readJsonFile('packages/product-catalog/catalog.json') as ProductCatalog;
const placements = readJsonFile('packages/ad-placements/placements.json') as AdPlacements;

for (const target of ['android', 'ios', 'ait'] as const) {
  const playerId = `${target}-player`;
  const entitlementLedger = createInMemoryEntitlementLedger();
  const leaderboardLedger = createInMemoryLeaderboardLedger();
  const gateway = createCapableMockGateway({ target, playerId });
  const client = createLiveOpsClient({
    gateway,
    target,
    playerId,
    now: () => '2026-07-03T00:00:00.000Z',
    backend: {
      purchases: {
        async verifyPurchase(input) {
          return verifyPurchase(input, {
            catalog,
            ledger: entitlementLedger,
            now: () => '2026-07-03T00:00:01.000Z',
          });
        },
      },
      adRewards: {
        async claimAdReward(input) {
          return claimAdReward(input, {
            placements,
            ledger: entitlementLedger,
            now: () => '2026-07-03T00:00:02.000Z',
          });
        },
      },
      leaderboard: {
        async recordScore(input) {
          return leaderboardLedger.recordScore(input);
        },
      },
    },
  });

  const runId = `${target}-run-1`;
  const purchase = await client.purchase({
    productId: 'COINS_100',
    source: 'result',
    idempotencyKey: createLiveOpsIdempotencyKey({
      target,
      playerId,
      action: 'purchase',
      subjectId: 'COINS_100',
      runId,
    }),
  });
  const reward = await client.claimRewardedAd({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: createLiveOpsIdempotencyKey({
      target,
      playerId,
      action: 'rewarded-ad',
      subjectId: 'CONTINUE_AFTER_FAIL',
      runId,
    }),
  });
  const score = await client.submitLeaderboardScore({
    leaderboardId: 'default',
    score: 10_000,
    runId,
    submittedAt: '2026-07-03T00:00:03.000Z',
  });

  assertEqual(purchase.status, 'granted', `${target} purchase should be ledger-granted`);
  assertEqual(reward.status, 'granted', `${target} reward should be ledger-granted`);
  assertEqual(score.submitted, true, `${target} leaderboard should be ledger-recorded`);
  assertEqual(
    entitlementLedger.listTransactions().length,
    2,
    `${target} entitlement ledger should record purchase and reward`,
  );
  assertEqual(
    leaderboardLedger.listTransactions().length,
    1,
    `${target} leaderboard ledger should record one score`,
  );
}

console.log('LiveOps vertical slice smoke passed: android, ios, ait');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
