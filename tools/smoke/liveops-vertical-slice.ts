import { createInMemoryEntitlementLedger } from '@mpgd/backend-entitlement-ledger';
import { createInMemoryLeaderboardLedger } from '@mpgd/backend-leaderboard-ledger';
import {
  createInProcessLiveOpsBackendTransport,
  createLiveOpsBackendApiHandler,
} from '@mpgd/backend-liveops-api';
import {
  createLiveOpsClient,
  createLiveOpsHttpBackendApi,
  createLiveOpsIdempotencyKey,
} from '@mpgd/liveops-client';

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
  const backend = createLiveOpsHttpBackendApi({
    transport: createInProcessLiveOpsBackendTransport(
      createLiveOpsBackendApiHandler({
        catalog,
        placements,
        entitlementLedger,
        leaderboardLedger,
        now: () => '2026-07-03T00:00:01.000Z',
      }),
    ),
  });
  const gateway = createCapableMockGateway({ target, playerId });
  const client = createLiveOpsClient({
    gateway,
    target,
    playerId,
    now: () => '2026-07-03T00:00:00.000Z',
    backend,
  });

  const runId = `${target}-run-1`;
  const purchaseKey = createLiveOpsIdempotencyKey({
    target,
    playerId,
    action: 'purchase',
    subjectId: 'COINS_100',
    runId,
  });
  const purchase = await client.purchase({
    productId: 'COINS_100',
    source: 'result',
    idempotencyKey: purchaseKey,
  });
  const duplicatePurchase = await client.purchase({
    productId: 'COINS_100',
    source: 'result',
    idempotencyKey: purchaseKey,
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
  assertEqual(
    duplicatePurchase.verification?.alreadyProcessed,
    true,
    `${target} duplicate purchase should be idempotent`,
  );
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

  const entitlementCount = entitlementLedger.listTransactions().length;
  const leaderboardCount = leaderboardLedger.listTransactions().length;
  const cancelledClient = createLiveOpsClient({
    gateway: createCapableMockGateway({
      target,
      playerId,
      purchaseResult: {
        status: 'cancelled',
        entitlementIds: [],
      },
    }),
    target,
    playerId,
    backend,
  });
  const cancelledPurchase = await cancelledClient.purchase({
    productId: 'COINS_100',
    source: 'result',
    idempotencyKey: createLiveOpsIdempotencyKey({
      target,
      playerId,
      action: 'purchase',
      subjectId: 'COINS_100',
      runId: `${target}-cancelled-purchase`,
    }),
  });
  const skippedAdClient = createLiveOpsClient({
    gateway: createCapableMockGateway({
      target,
      playerId,
      rewardedAdResult: {
        status: 'skipped',
        rewardGranted: false,
      },
    }),
    target,
    playerId,
    backend,
  });
  const skippedReward = await skippedAdClient.claimRewardedAd({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: createLiveOpsIdempotencyKey({
      target,
      playerId,
      action: 'rewarded-ad',
      subjectId: 'CONTINUE_AFTER_FAIL',
      runId: `${target}-skipped-ad`,
    }),
  });
  const failedLeaderboardClient = createLiveOpsClient({
    gateway: createCapableMockGateway({
      target,
      playerId,
      leaderboardSubmitted: false,
    }),
    target,
    playerId,
    backend,
  });
  const failedScore = await failedLeaderboardClient.submitLeaderboardScore({
    leaderboardId: 'default',
    score: 20_000,
    runId: `${target}-failed-score`,
    submittedAt: '2026-07-03T00:00:04.000Z',
  });

  assertEqual(
    cancelledPurchase.status,
    'cancelled',
    `${target} cancelled purchase should stay cancelled`,
  );
  assertEqual(skippedReward.status, 'skipped', `${target} skipped ad should stay skipped`);
  assertEqual(failedScore.submitted, false, `${target} failed platform score should stay local`);
  assertEqual(
    entitlementLedger.listTransactions().length,
    entitlementCount,
    `${target} failed monetization callbacks should not add grants`,
  );
  assertEqual(
    leaderboardLedger.listTransactions().length,
    leaderboardCount,
    `${target} failed platform leaderboard should not be recorded`,
  );
}

console.log('LiveOps vertical slice smoke passed: android, ios, ait');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
