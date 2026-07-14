import type { PlatformGateway, ProductInfo } from '@mpgd/platform';

import {
  createGameServicesClient,
  createGameServicesFetchBackendTransport,
  createGameServicesHttpBackendApi,
  createGameServicesIdempotencyKey,
  gameServicesBackendEndpoints,
  type GameServicesBackendApi,
} from './index';

let purchaseClaims = 0;
let rewardClaims = 0;
let scoreRecords = 0;
let purchaseEvidenceSchema: string | undefined;
let rewardEvidenceSchema: string | undefined;
const playerId = 'player-game-services';
const gateway = createMockGateway();
const backend = {
  purchases: {
    async verifyPurchase(input) {
      purchaseClaims += 1;
      purchaseEvidenceSchema = input.evidence?.schema;

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
      rewardEvidenceSchema = input.evidence?.schema;

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
} satisfies GameServicesBackendApi;
const client = createGameServicesClient({
  gateway,
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
});

const purchaseKey = createGameServicesIdempotencyKey({
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
  idempotencyKey: createGameServicesIdempotencyKey({
    target: 'android',
    playerId,
    action: 'rewarded-ad',
    subjectId: 'CONTINUE_AFTER_FAIL',
    runId: 'run-1',
  }),
});

assertEqual(reward.status, 'granted', 'reward should be granted after ad reward ledger claim');
assertEqual(
  purchaseEvidenceSchema,
  'test.purchase.v1',
  'purchase evidence should reach the backend verifier request',
);
assertEqual(
  rewardEvidenceSchema,
  'test.reward.v1',
  'reward evidence should reach the backend verifier request',
);

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

const analyticsFailureClient = createGameServicesClient({
  gateway: createMockGateway(),
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
  analytics: {
    track() {
      throw new Error('analytics unavailable');
    },
  },
});
const analyticsFailurePurchase = await analyticsFailureClient.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: 'analytics-failure-purchase',
});

assertEqual(
  analyticsFailurePurchase.status,
  'granted',
  'analytics failures should not break purchases',
);

const rejectedEvents: string[] = [];
const baseRejectedGateway = createMockGateway();
const rejectedGateway = {
  ...baseRejectedGateway,
  commerce: {
    ...baseRejectedGateway.commerce,
    async purchase() {
      return {
        status: 'cancelled',
        entitlementIds: [],
      };
    },
  },
  ads: {
    ...baseRejectedGateway.ads,
    async showRewarded() {
      return {
        status: 'skipped',
        rewardGranted: false,
      };
    },
  },
} satisfies PlatformGateway;
const rejectedClient = createGameServicesClient({
  gateway: rejectedGateway,
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
  analytics: {
    track(event) {
      rejectedEvents.push(event.name);
    },
  },
});
const rejectedPurchase = await rejectedClient.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: 'cancelled-purchase',
});
const rejectedReward = await rejectedClient.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'skipped-reward',
});

assertEqual(rejectedPurchase.status, 'cancelled', 'cancelled purchase should pass through');
assertEqual(rejectedReward.status, 'skipped', 'skipped rewarded ad should pass through');
assertEqual(
  rejectedEvents.join(','),
  'purchase_rejected,rewarded_ad_rejected',
  'non-completed platform flows should emit rejected analytics',
);

let unsupportedPurchaseCalls = 0;
let unsupportedRewardCalls = 0;
const purchaseClaimsBeforeUnsupported = purchaseClaims;
const rewardClaimsBeforeUnsupported = rewardClaims;
const unsupportedBaseGateway = createMockGateway();
const unsupportedGateway = {
  ...unsupportedBaseGateway,
  target: 'reddit',
  commerce: {
    ...unsupportedBaseGateway.commerce,
    async purchase() {
      unsupportedPurchaseCalls += 1;

      return {
        status: 'completed',
        transactionId: 'unexpected-unsupported-transaction',
        entitlementIds: [],
      };
    },
  },
  ads: {
    ...unsupportedBaseGateway.ads,
    async showRewarded() {
      unsupportedRewardCalls += 1;

      return {
        status: 'completed',
        rewardGranted: true,
        ledgerEntryId: 'unexpected-unsupported-impression',
      };
    },
  },
} satisfies PlatformGateway;
const unsupportedClient = createGameServicesClient({
  gateway: unsupportedGateway,
  playerId,
  target: 'reddit',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
});
const unsupportedPurchase = await unsupportedClient.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: 'unsupported-purchase',
});
const unsupportedReward = await unsupportedClient.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'unsupported-reward',
});

assertEqual(unsupportedPurchase.status, 'rejected', 'unsupported target purchase should reject');
assertEqual(
  unsupportedPurchase.purchase.status,
  'failed',
  'unsupported target purchase should return a failed platform result without a platform call',
);
assertEqual(unsupportedReward.status, 'rejected', 'unsupported target rewarded ad should reject');
assertEqual(
  unsupportedReward.reward.status,
  'unavailable',
  'unsupported target rewarded ad should return unavailable without a platform call',
);
assertEqual(
  unsupportedPurchaseCalls,
  0,
  'unsupported target purchase should not call platform commerce',
);
assertEqual(
  unsupportedRewardCalls,
  0,
  'unsupported target rewarded ad should not call platform ads',
);
assertEqual(
  purchaseClaims,
  purchaseClaimsBeforeUnsupported,
  'unsupported target purchase should not call purchase backend',
);
assertEqual(
  rewardClaims,
  rewardClaimsBeforeUnsupported,
  'unsupported target rewarded ad should not call ad reward backend',
);

const transportCalls: string[] = [];
const httpBackend = createGameServicesHttpBackendApi({
  transport: {
    async send(request) {
      transportCalls.push(request.endpoint);

      switch (request.endpoint) {
        case gameServicesBackendEndpoints.verifyPurchase:
          return {
            status: 200,
            body: {
              verified: true,
              ledgerEntryId: 'http-purchase-ledger',
              alreadyProcessed: false,
            },
          };
        case gameServicesBackendEndpoints.claimAdReward:
          return {
            status: 200,
            body: {
              granted: true,
              ledgerEntryId: 'http-reward-ledger',
              alreadyProcessed: false,
            },
          };
        case gameServicesBackendEndpoints.recordLeaderboardScore:
          return {
            status: 200,
            body: {
              submitted: true,
              ledgerEntryId: 'http-score-ledger',
              alreadyProcessed: false,
              rank: 1,
            },
          };
      }
    },
  },
});
const httpPurchase = await httpBackend.purchases.verifyPurchase({
  target: 'android',
  playerId,
  productId: 'COINS_100',
  platformTransactionId: 'txn-http',
  idempotencyKey: 'http-purchase',
  purchasedAt: '2026-07-03T00:00:04.000Z',
});
const httpScore = await httpBackend.leaderboard.recordScore({
  target: 'android',
  playerId,
  leaderboardId: 'default',
  score: 4321,
  runId: 'run-http',
  submittedAt: '2026-07-03T00:00:05.000Z',
});

assertEqual(httpPurchase.verified, true, 'http backend should verify purchase');
assertEqual(httpScore.submitted, true, 'http backend should record score');
assertEqual(
  transportCalls.join(','),
  [
    gameServicesBackendEndpoints.verifyPurchase,
    gameServicesBackendEndpoints.recordLeaderboardScore,
  ].join(','),
  'http backend should route to typed endpoints',
);

let fetchUrl = '';
const fetchBackend = createGameServicesHttpBackendApi({
  transport: createGameServicesFetchBackendTransport({
    baseUrl: 'https://game-services.test/api/',
    async fetch(url, init) {
      fetchUrl = url;
      assertEqual(init.method, 'POST', 'fetch transport should use POST');
      assertEqual(
        init.headers['content-type'],
        'application/json',
        'fetch transport should send JSON',
      );

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            granted: true,
            ledgerEntryId: 'fetch-reward-ledger',
            alreadyProcessed: false,
          });
        },
      };
    },
  }),
});
const fetchReward = await fetchBackend.adRewards.claimAdReward({
  target: 'android',
  playerId,
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'fetch-reward',
  completedAt: '2026-07-03T00:00:06.000Z',
});

assertEqual(fetchReward.granted, true, 'fetch backend should decode JSON response');
assertEqual(
  fetchUrl,
  'https://game-services.test/api/game-services/ad-rewards/claim',
  'fetch transport should join base URL and endpoint',
);

console.log('GameServices client vertical slice smoke test passed.');

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
          evidence: {
            schema: 'test.purchase.v1',
            payload: {
              signedTransaction: 'test-signed-transaction',
            },
          },
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
          evidence: {
            schema: 'test.reward.v1',
            payload: {
              signedCallback: 'test-signed-callback',
            },
          },
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
