import type { PlatformGateway } from '@mpgd/platform-contract';

import {
  applyPolicyToCapabilities,
  getTargetPolicy,
  policyTargetForPlatform,
  withPolicyEnforcement,
  type PolicyMatrix,
} from '../src/runtime';

const policyMatrix = {
  version: 'test',
  targets: {
    'web-preview': {
      iap: false,
      rewardedAds: false,
      interstitialAds: false,
      leaderboard: false,
    },
    android: {
      iap: true,
      rewardedAds: true,
      interstitialAds: true,
      leaderboard: true,
    },
  },
} satisfies PolicyMatrix;

const delegatedCalls: string[] = [];
const gateway = createGateway();

assertEqual(policyTargetForPlatform('browser'), 'web-preview');
assertEqual(policyTargetForPlatform('android'), 'android');

const webPolicy = getTargetPolicy(policyMatrix, policyTargetForPlatform('browser'));
const webGateway = withPolicyEnforcement(gateway, webPolicy, {
  policyTarget: 'web-preview',
  adPlacements: [
    {
      id: 'CONTINUE_AFTER_FAIL',
      type: 'rewarded',
    },
    {
      id: 'STAGE_END_INTERSTITIAL',
      type: 'interstitial',
    },
  ],
  resolveAdPlacementType,
});
const webCapabilities = await webGateway.getCapabilities();
const webRuntime = await webGateway.getPolicyRuntime();

assertDeepEqual(
  applyPolicyToCapabilities(await gateway.getCapabilities(), webPolicy),
  webCapabilities,
);
assertEqual(webRuntime.policyTarget, 'web-preview');
assertEqual(webRuntime.features.iap.reason, 'policy-disabled');
assertEqual(webRuntime.features.rewardedAds.reason, 'policy-disabled');
assertEqual(webRuntime.features.interstitialAds.reason, 'policy-disabled');
assertEqual(webRuntime.features.leaderboard.reason, 'policy-disabled');
assertDeepEqual(
  webRuntime.adPlacements.map((placement) => ({
    id: placement.id,
    enabled: placement.enabled,
    reason: placement.reason,
  })),
  [
    {
      id: 'CONTINUE_AFTER_FAIL',
      enabled: false,
      reason: 'policy-disabled',
    },
    {
      id: 'STAGE_END_INTERSTITIAL',
      enabled: false,
      reason: 'policy-disabled',
    },
  ],
);
assertEqual(webCapabilities.nativeIap, false);
assertEqual(webCapabilities.rewardedAds, false);
assertEqual(webCapabilities.interstitialAds, false);
assertEqual(webCapabilities.nativeLeaderboard, false);
assertDeepEqual(await webGateway.commerce.getProducts(), []);
assertDeepEqual(
  await webGateway.commerce.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'web-purchase',
  }),
  {
    status: 'cancelled',
    entitlementIds: [],
  },
);
assertDeepEqual(
  await webGateway.ads.showRewarded({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'web-reward',
  }),
  {
    status: 'unavailable',
    rewardGranted: false,
  },
);
assertDeepEqual(
  await webGateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' }),
  {
    status: 'unavailable',
  },
);
assertDeepEqual(
  await webGateway.leaderboard.submitScore({
    leaderboardId: 'default',
    score: 100,
    runId: 'web-run',
    submittedAt: new Date().toISOString(),
  }),
  {
    submitted: false,
  },
);
assertEqual(await webGateway.storage.load({ key: 'save:v1' }), 'stored-save');

const rewardedOnlyGateway = withPolicyEnforcement(
  gateway,
  {
    iap: true,
    rewardedAds: true,
    interstitialAds: false,
    leaderboard: true,
  },
  {
    adPlacements: [
      {
        id: 'CONTINUE_AFTER_FAIL',
        type: 'rewarded',
      },
      {
        id: 'STAGE_END_INTERSTITIAL',
        type: 'interstitial',
      },
    ],
    resolveAdPlacementType,
  },
);
const rewardedOnlyRuntime = await rewardedOnlyGateway.getPolicyRuntime();

assertEqual(rewardedOnlyRuntime.features.rewardedAds.reason, 'available');
assertEqual(rewardedOnlyRuntime.features.interstitialAds.reason, 'policy-disabled');

await rewardedOnlyGateway.ads.preload({ placementId: 'CONTINUE_AFTER_FAIL' });
await rewardedOnlyGateway.ads.preload({ placementId: 'STAGE_END_INTERSTITIAL' });
await rewardedOnlyGateway.ads.showRewarded({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'partial-reward',
});
assertDeepEqual(
  await rewardedOnlyGateway.ads.showRewarded({
    placementId: 'STAGE_END_INTERSTITIAL',
    idempotencyKey: 'partial-wrong-placement',
  }),
  {
    status: 'unavailable',
    rewardGranted: false,
  },
);
assertDeepEqual(
  await rewardedOnlyGateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' }),
  {
    status: 'unavailable',
  },
);
assertDeepEqual(delegatedCalls, ['preload:CONTINUE_AFTER_FAIL', 'showRewarded']);
delegatedCalls.length = 0;

const androidGateway = withPolicyEnforcement(gateway, getTargetPolicy(policyMatrix, 'android'), {
  resolveAdPlacementType,
});

await androidGateway.commerce.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'android-purchase',
});
await androidGateway.ads.showRewarded({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'android-reward',
});
await androidGateway.leaderboard.submitScore({
  leaderboardId: 'default',
  score: 100,
  runId: 'android-run',
  submittedAt: new Date().toISOString(),
});

assertDeepEqual(delegatedCalls, ['purchase', 'showRewarded', 'submitScore']);
console.log('Policy matrix runtime enforcement smoke test passed.');

function createGateway(): PlatformGateway {
  return {
    target: 'browser',
    async getCapabilities() {
      return {
        nativeIap: true,
        nativeAds: true,
        rewardedAds: true,
        interstitialAds: true,
        nativeLeaderboard: true,
        achievements: true,
        cloudSave: true,
        socialShare: true,
        haptics: true,
      };
    },
    identity: {
      async getPlayer() {
        return {
          playerId: 'test-player',
        };
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        delegatedCalls.push('purchase');
        return {
          status: 'completed',
          entitlementIds: [],
        };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload(input) {
        delegatedCalls.push(`preload:${input.placementId}`);
      },
      async showRewarded() {
        delegatedCalls.push('showRewarded');
        return {
          status: 'completed',
          rewardGranted: true,
        };
      },
      async showInterstitial() {
        delegatedCalls.push('showInterstitial');
        return {
          status: 'shown',
        };
      },
    },
    leaderboard: {
      async submitScore() {
        delegatedCalls.push('submitScore');
        return {
          submitted: true,
        };
      },
      async open() {
        delegatedCalls.push('openLeaderboard');
      },
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
        return 'stored-save';
      },
      async save() {},
    },
  };
}

function resolveAdPlacementType(placementId: string): 'rewarded' | 'interstitial' | undefined {
  if (placementId === 'CONTINUE_AFTER_FAIL') {
    return 'rewarded';
  }

  if (placementId === 'STAGE_END_INTERSTITIAL') {
    return 'interstitial';
  }

  return undefined;
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}.`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(actual)} to deeply equal ${JSON.stringify(expected)}.`,
    );
  }
}
