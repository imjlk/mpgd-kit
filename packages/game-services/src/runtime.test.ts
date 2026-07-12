import type { PlatformGateway } from '@mpgd/platform';

import { createGameServicesRuntime, type GameServicesBackendApi } from './index';

const playerId = 'runtime-player';
let purchaseCalls = 0;
let rewardCalls = 0;
let leaderboardCalls = 0;
const localBackend = {
  purchases: {
    async verifyPurchase(input) {
      purchaseCalls += 1;

      return {
        verified: true,
        ledgerEntryId: `local-purchase-${input.idempotencyKey}`,
        alreadyProcessed: false,
      };
    },
  },
  adRewards: {
    async claimAdReward(input) {
      rewardCalls += 1;

      return {
        granted: true,
        ledgerEntryId: `local-reward-${input.idempotencyKey}`,
        alreadyProcessed: false,
      };
    },
  },
  leaderboard: {
    async recordScore(input) {
      leaderboardCalls += 1;

      return {
        submitted: true,
        ledgerEntryId: `local-score-${input.runId}`,
        alreadyProcessed: false,
        rank: 1,
      };
    },
  },
} satisfies GameServicesBackendApi;

const productionWithoutUrl = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'production',
  allowLocalBackend: true,
  localBackend,
});

assertEqual(productionWithoutUrl.mode, 'disabled', 'production without URL should disable');
assertEqual(
  productionWithoutUrl.reason,
  'missing_authoritative_backend',
  'production without URL should report the authoritative backend requirement',
);
assertEqual(productionWithoutUrl.client, undefined, 'production should not expose a local client');
assertLocalCalls(0, 'production factory creation');

const productionWithBlankUrl = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'production',
  baseUrl: '   ',
  allowLocalBackend: true,
  localBackend,
});

assertEqual(
  productionWithBlankUrl.reason,
  'missing_authoritative_backend',
  'blank production URL should remain fail-closed',
);
assertLocalCalls(0, 'blank production URL');

const developmentWithoutOptIn = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'non-production',
  localBackend,
});

assertEqual(
  developmentWithoutOptIn.reason,
  'local_backend_not_allowed',
  'non-production local authority should require explicit opt-in',
);

const developmentWithoutBackend = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'non-production',
  allowLocalBackend: true,
});

assertEqual(
  developmentWithoutBackend.reason,
  'local_backend_unavailable',
  'local opt-in should still require an explicit backend',
);

const localRuntime = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'non-production',
  allowLocalBackend: true,
  localBackend,
  now: () => '2026-07-13T00:00:00.000Z',
});

assertEqual(localRuntime.mode, 'local', 'explicit non-production local backend should be enabled');

const localClient = requireValue(localRuntime.client, 'local runtime client');
const purchase = await localClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'runtime-purchase',
});
const reward = await localClient.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'runtime-reward',
});
const leaderboard = await localClient.submitLeaderboardScore({
  leaderboardId: 'default',
  score: 1200,
  runId: 'runtime-run',
  submittedAt: '2026-07-13T00:00:01.000Z',
});

assertEqual(purchase.status, 'granted', 'local purchase should work only after explicit opt-in');
assertEqual(reward.status, 'granted', 'local reward should work only after explicit opt-in');
assertEqual(leaderboard.submitted, true, 'local leaderboard should work after explicit opt-in');
assertLocalCalls(1, 'explicit non-production local client');

const remoteRuntime = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'production',
  baseUrl: '  https://services.example.com/api/  ',
  allowLocalBackend: true,
  localBackend,
});

assertEqual(remoteRuntime.mode, 'http', 'production URL should select the remote HTTP backend');
assertEqual(
  remoteRuntime.baseUrl,
  'https://services.example.com/api/',
  'remote URL should be normalized',
);
assertEqual(remoteRuntime.target, 'android', 'runtime should preserve the ledger target');
assertNotEqual(remoteRuntime.client, undefined, 'remote production should expose a client');
assertLocalCalls(1, 'remote production factory creation');

const unsupportedRuntime = createGameServicesRuntime({
  gateway: createGateway('telegram'),
  playerId,
  authorityMode: 'production',
  baseUrl: 'https://services.example.com',
});

assertEqual(unsupportedRuntime.mode, 'disabled', 'unsupported targets should be disabled');
assertEqual(
  unsupportedRuntime.reason,
  'unsupported_target',
  'unsupported targets should report their reason',
);

console.log('GameServices runtime authority smoke test passed.');

function createGateway(target: PlatformGateway['target'] = 'android'): PlatformGateway {
  return {
    target,
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
        return { playerId };
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase(input) {
        return {
          status: 'completed',
          transactionId: `transaction-${input.idempotencyKey}`,
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
        return { submitted: true };
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

function assertLocalCalls(expected: number, label: string): void {
  assertEqual(purchaseCalls, expected, `${label} purchase calls`);
  assertEqual(rewardCalls, expected, `${label} reward calls`);
  assertEqual(leaderboardCalls, expected, `${label} leaderboard calls`);
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}.`);
  }

  return value;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertNotEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    throw new Error(`${message}: did not expect ${String(expected)}.`);
  }
}
