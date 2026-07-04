import type { ProductInfo } from '@mpgd/monetization-contract';
import type { PlatformGateway } from '@mpgd/platform-contract';

import { createLiveOpsClient, createLiveOpsIdempotencyKey } from './index';

let purchaseClaims = 0;
let rewardClaims = 0;
let scoreRecords = 0;
const playerId = 'player-liveops';
const gateway = createMockGateway();
const client = createLiveOpsClient({
  gateway,
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend: {
    purchases: {
      async verifyPurchase(input) {
        purchaseClaims += 1;

        return {
          verified: true,
          ledgerEntryId: `purchase-ledger-${input.idempotencyKey}`,
          alreadyProcessed: purchaseClaims > 1,
        };
      },
    },
    adRewards: {
      async claimAdReward(input) {
        rewardClaims += 1;

        return {
          granted: true,
          ledgerEntryId: `reward-ledger-${input.idempotencyKey}`,
          alreadyProcessed: rewardClaims > 1,
        };
      },
    },
    leaderboard: {
      async recordScore(input) {
        scoreRecords += 1;

        return {
          submitted: true,
          ledgerEntryId: `leaderboard-ledger-${input.runId}`,
          alreadyProcessed: false,
          rank: 1,
        };
      },
    },
  },
});

const purchaseKey = createLiveOpsIdempotencyKey({
  target: 'android',
  playerId,
  action: 'purchase',
  subjectId: 'COINS_100',
  runId: 'run-1',
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

assertEqual(purchase.status, 'granted', 'purchase should be granted after verifier');
assertEqual(
  duplicatePurchase.verification?.alreadyProcessed,
  true,
  'purchase verifier should dedupe repeated grants',
);

const reward = await client.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: createLiveOpsIdempotencyKey({
    target: 'android',
    playerId,
    action: 'rewarded-ad',
    subjectId: 'CONTINUE_AFTER_FAIL',
    runId: 'run-1',
  }),
});

assertEqual(reward.status, 'granted', 'reward should be granted after ad reward ledger claim');

const leaderboard = await client.submitLeaderboardScore({
  leaderboardId: 'default',
  score: 1234,
  runId: 'run-1',
  submittedAt: '2026-07-03T00:00:03.000Z',
});

assertEqual(leaderboard.submitted, true, 'leaderboard should be recorded');
assertEqual(leaderboard.platformSubmitted, true, 'leaderboard should submit to platform first');
assertEqual(purchaseClaims, 2, 'purchase backend should be called for both attempts');
assertEqual(rewardClaims, 1, 'reward backend should be called after platform reward');
assertEqual(scoreRecords, 1, 'leaderboard backend should be called after platform submit');

console.log('LiveOps client vertical slice smoke test passed.');

function createMockGateway(): PlatformGateway {
  const product = {
    id: 'COINS_100',
    type: 'consumable',
    title: '100 Coins',
    description: 'Adds 100 coins.',
    price: {
      formatted: '$0.99',
      currencyCode: 'USD',
    },
  } as const satisfies ProductInfo;

  return {
    target: 'android',
    async getCapabilities() {
      return {
        nativeIap: true,
        nativeAds: true,
        rewardedAds: true,
        interstitialAds: true,
        nativeLeaderboard: true,
        achievements: false,
        cloudSave: false,
        socialShare: false,
        haptics: false,
        localizedContent: true,
      };
    },
    identity: {
      async getPlayer() {
        return {
          playerId,
        };
      },
    },
    commerce: {
      async getProducts() {
        return [product];
      },
      async purchase(input) {
        return {
          status: 'completed',
          transactionId: `txn-${input.productId}-${input.idempotencyKey}`,
          entitlementIds: [],
        };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded(input) {
        return {
          status: 'completed',
          rewardGranted: true,
          ledgerEntryId: `impression-${input.idempotencyKey}`,
        };
      },
    },
    leaderboard: {
      async submitScore() {
        return {
          submitted: true,
        };
      },
      async open() {},
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  };
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
