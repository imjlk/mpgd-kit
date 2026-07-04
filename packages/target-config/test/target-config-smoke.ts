import type { AdPlacements } from '@mpgd/ad-placements';
import type { PlatformGateway } from '@mpgd/platform-contract';
import type { ProductCatalog } from '@mpgd/product-catalog';

import {
  createEffectiveTargetConfig,
  getEffectiveAdPlacementConfig,
  getEffectiveProductConfig,
} from '../src/effective';
import {
  applyTargetConfigToCapabilities,
  getTargetConfig,
  targetConfigKeyForPlatform,
  withTargetAvailability,
  type TargetConfig,
  type TargetConfigMatrix,
} from '../src/runtime';

const targetConfigMatrix = {
  version: 'test',
  targets: {
    'web-preview': createTargetConfig({
      iap: false,
      rewardedAds: false,
      interstitialAds: false,
      leaderboard: false,
      localization: true,
    }),
    android: createTargetConfig({
      iap: true,
      rewardedAds: true,
      interstitialAds: true,
      leaderboard: true,
      localization: true,
    }),
  },
} satisfies TargetConfigMatrix;
const productCatalog = {
  version: 'test-catalog',
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
        android: 'coins_100',
      },
    },
  ],
} satisfies ProductCatalog;
const adPlacements = {
  version: 'test-ads',
  placements: [
    {
      id: 'CONTINUE_AFTER_FAIL',
      type: 'rewarded',
      reward: {
        type: 'continue',
        amount: 1,
      },
      frequencyCap: {
        cooldownSeconds: 60,
      },
      platformPlacementIds: {
        android: 'reward_continue',
      },
    },
    {
      id: 'STAGE_END_INTERSTITIAL',
      type: 'interstitial',
      frequencyCap: {
        cooldownSeconds: 120,
      },
      platformPlacementIds: {
        android: 'inter_stage_end',
      },
    },
  ],
} satisfies AdPlacements;

const delegatedCalls: string[] = [];
const gateway = createGateway();

assertEqual(targetConfigKeyForPlatform('browser'), 'web-preview');
assertEqual(targetConfigKeyForPlatform('android'), 'android');

const webConfig = getTargetConfig(targetConfigMatrix, targetConfigKeyForPlatform('browser'));
const webEffectiveConfig = createEffectiveTargetConfig({
  target: 'web-preview',
  targetConfigVersion: targetConfigMatrix.version,
  config: webConfig,
  catalog: productCatalog,
  adPlacements,
});
const webGateway = withTargetAvailability(gateway, webConfig, {
  configTarget: 'web-preview',
  effectiveConfig: webEffectiveConfig,
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
const webRuntime = await webGateway.getTargetRuntime();
const webProduct = getEffectiveProductConfig(webEffectiveConfig, 'COINS_100');
const webRewardedPlacement = getEffectiveAdPlacementConfig(
  webEffectiveConfig,
  'CONTINUE_AFTER_FAIL',
);

assertEqual(webGateway.effectiveConfig, webEffectiveConfig);
assertDeepEqual(
  applyTargetConfigToCapabilities(await gateway.getCapabilities(), webConfig),
  webCapabilities,
);
assertEqual(webRuntime.configTarget, 'web-preview');
assertEqual(webRuntime.effectiveConfig, webEffectiveConfig);
assertEqual(webProduct?.reason, 'target-disabled');
assertEqual(webRewardedPlacement?.reason, 'target-disabled');
assertEqual(webRuntime.features.iap.reason, 'target-disabled');
assertEqual(webRuntime.features.rewardedAds.reason, 'target-disabled');
assertEqual(webRuntime.features.interstitialAds.reason, 'target-disabled');
assertEqual(webRuntime.features.leaderboard.reason, 'target-disabled');
assertEqual(webRuntime.features.localization.reason, 'available');
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
      reason: 'target-disabled',
    },
    {
      id: 'STAGE_END_INTERSTITIAL',
      enabled: false,
      reason: 'target-disabled',
    },
  ],
);
assertEqual(webCapabilities.nativeIap, false);
assertEqual(webCapabilities.rewardedAds, false);
assertEqual(webCapabilities.interstitialAds, false);
assertEqual(webCapabilities.nativeLeaderboard, false);
assertEqual(webCapabilities.localizedContent, true);
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

const rewardedOnlyGateway = withTargetAvailability(
  gateway,
  createTargetConfig({
    iap: true,
    rewardedAds: true,
    interstitialAds: false,
    leaderboard: true,
    localization: false,
  }),
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
const rewardedOnlyRuntime = await rewardedOnlyGateway.getTargetRuntime();

assertEqual(rewardedOnlyRuntime.features.rewardedAds.reason, 'available');
assertEqual(rewardedOnlyRuntime.features.interstitialAds.reason, 'target-disabled');
assertEqual(rewardedOnlyRuntime.features.localization.reason, 'target-disabled');
assertEqual((await rewardedOnlyGateway.getCapabilities()).localizedContent, false);

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

const androidConfig = getTargetConfig(targetConfigMatrix, 'android');
const androidEffectiveConfig = createEffectiveTargetConfig({
  target: 'android',
  targetConfigVersion: targetConfigMatrix.version,
  config: androidConfig,
  catalog: productCatalog,
  adPlacements,
});
const androidGateway = withTargetAvailability(gateway, androidConfig, {
  effectiveConfig: androidEffectiveConfig,
  resolveAdPlacementType,
});

assertEqual(getEffectiveProductConfig(androidEffectiveConfig, 'COINS_100')?.enabled, true);
assertEqual(
  getEffectiveProductConfig(androidEffectiveConfig, 'COINS_100')?.platformProductId,
  'coins_100',
);
assertEqual(
  getEffectiveAdPlacementConfig(androidEffectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
  true,
);
assertEqual(
  getEffectiveAdPlacementConfig(androidEffectiveConfig, 'CONTINUE_AFTER_FAIL')
    ?.platformPlacementId,
  'reward_continue',
);

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
console.log('Target config runtime availability smoke test passed.');

function createTargetConfig(features: TargetConfig['features']): TargetConfig {
  return {
    runtime: 'web-preview',
    features,
    capabilities: {
      storage: 'local',
      localization: features.localization,
    },
    monetization: {
      iap: features.iap,
      rewardedAds: features.rewardedAds,
      interstitialAds: features.interstitialAds,
    },
    leaderboard: {
      native: features.leaderboard,
    },
    release: {
      profile: 'web-preview',
    },
    policy: {
      externalPaymentAllowed: false,
      remoteExecutableCodeAllowed: false,
      installOtherAppCTAAllowed: false,
      requiresStoreReview: false,
      requiresAitReview: false,
    },
  };
}

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
        localizedContent: true,
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
