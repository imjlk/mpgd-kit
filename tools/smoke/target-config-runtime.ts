import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import type { AdPlacements } from '../../packages/ad-placements/src/index';
import { resolveMpgdLocale } from '../../packages/i18n/src/index';
import type { PlatformGateway, PlatformTarget } from '../../packages/platform-contract/src/index';
import {
  getTargetConfig,
  isTargetConfiguredGateway,
  withTargetAvailability,
  type PlatformFeature,
  type TargetConfigMatrix,
  type TargetConfiguredGateway,
} from '../../packages/target-config/src/runtime';
import { readJsonFile } from '../io';

const targetConfigMatrix = readJsonFile(
  'packages/target-config/targets.json',
) as TargetConfigMatrix;
const adPlacements = readJsonFile('packages/ad-placements/placements.json') as AdPlacements;

const platformFeatures = [
  'iap',
  'rewardedAds',
  'interstitialAds',
  'leaderboard',
  'localization',
] as const satisfies readonly PlatformFeature[];
const configTargets = ['web-preview', 'android', 'ios', 'ait'] as const;

for (const target of configTargets) {
  await verifyConfigTarget(target);
}

console.log(`Target config runtime smoke passed: ${configTargets.join(', ')}`);

async function verifyConfigTarget(configTarget: (typeof configTargets)[number]): Promise<void> {
  const platformTarget = platformTargetForConfig(configTarget);
  const targetGateway = createTargetGateway(platformTarget);
  const config = getTargetConfig(targetConfigMatrix, configTarget);
  const gateway = withTargetAvailability(targetGateway.gateway, config, {
    configTarget,
    adPlacements: adPlacements.placements.map((placement) => ({
      id: placement.id,
      type: placement.type,
    })),
    resolveAdPlacementType(placementId) {
      return adPlacements.placements.find((placement) => placement.id === placementId)?.type;
    },
  });

  assertEqual(
    isTargetConfiguredGateway(gateway),
    true,
    `${configTarget} should expose target config runtime`,
  );

  const runtime = await gateway.getTargetRuntime();

  assertEqual(runtime.configTarget, configTarget, `${configTarget} config target should match`);

  for (const feature of platformFeatures) {
    const featureRuntime = runtime.features[feature];

    assertEqual(
      featureRuntime.targetEnabled,
      config.features[feature],
      `${configTarget} ${feature} config should match`,
    );
    assertEqual(
      featureRuntime.enabled,
      featureRuntime.targetEnabled && featureRuntime.capabilitySupported,
      `${configTarget} ${feature} enabled state should follow target config and capability`,
    );
  }

  const expectedLocale =
    config.features.localization && runtime.features.localization.capabilitySupported ? 'ko' : 'en';

  assertEqual(
    resolveMpgdLocale(runtime.capabilities, ['ko-KR']),
    expectedLocale,
    `${configTarget} localization feature should control locale resolution`,
  );

  if (configTarget === 'web-preview') {
    await verifyWebPreviewFallbacks(gateway);
    return;
  }

  await gateway.commerce.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: `${configTarget}-purchase`,
  });
  await gateway.ads.showRewarded({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: `${configTarget}-reward`,
  });
  await gateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' });
  await gateway.leaderboard.submitScore({
    leaderboardId: 'default',
    score: 1,
    runId: `${configTarget}-run`,
    submittedAt: new Date().toISOString(),
  });

  assertDeepEqual(
    targetGateway.calls,
    ['purchase', 'showRewarded', 'showInterstitial', 'submitScore'],
    `${configTarget} enabled features should delegate to the platform gateway`,
  );
}

async function verifyWebPreviewFallbacks(
  gateway: TargetConfiguredGateway,
): Promise<void> {
  const runtime = await gateway.getTargetRuntime();

  assertEqual(runtime.configTarget, 'web-preview', 'browser should map to web-preview config');
  assertEqual(runtime.features.iap.reason, 'target-disabled', 'IAP should be target-disabled');
  assertEqual(
    runtime.features.rewardedAds.reason,
    'target-disabled',
    'rewarded ads should be target-disabled',
  );
  assertEqual(
    runtime.features.interstitialAds.reason,
    'target-disabled',
    'interstitial ads should be target-disabled',
  );
  assertEqual(
    runtime.features.leaderboard.reason,
    'target-disabled',
    'leaderboard should be target-disabled',
  );
  assertEqual(
    runtime.features.localization.reason,
    'available',
    'localization should be available',
  );
  assertEqual(runtime.capabilities.rewardedAds, false, 'rewarded capability should be clamped');
  assertEqual(
    runtime.capabilities.localizedContent,
    true,
    'localized content capability should remain available',
  );
  assertEqual(
    runtime.adPlacements.every((placement) => !placement.enabled),
    true,
    'all web-preview ad placements should be disabled',
  );
  assertDeepEqual(await gateway.commerce.getProducts(), [], 'IAP products should be hidden');
  assertDeepEqual(
    await gateway.ads.showRewarded({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'target-config-smoke-reward',
    }),
    {
      status: 'unavailable',
      rewardGranted: false,
    },
    'rewarded ad should be unavailable',
  );
  assertDeepEqual(
    await gateway.leaderboard.submitScore({
      leaderboardId: 'default',
      score: 1,
      runId: 'target-config-smoke',
      submittedAt: new Date().toISOString(),
    }),
    {
      submitted: false,
    },
    'leaderboard submit should be disabled',
  );
}

function createTargetGateway(target: PlatformTarget): {
  readonly gateway: PlatformGateway;
  readonly calls: string[];
} {
  if (target === 'browser') {
    return {
      gateway: createBrowserPlatformGateway(),
      calls: [],
    };
  }

  const calls: string[] = [];

  return {
    calls,
    gateway: {
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
          socialShare: target === 'ait',
          haptics: target === 'android' || target === 'ios' || target === 'ait',
          localizedContent: true,
        };
      },
      identity: {
        async getPlayer() {
          return {
            playerId: `${target}-player`,
            displayName: `${target} Player`,
          };
        },
      },
      commerce: {
        async getProducts() {
          return [];
        },
        async purchase() {
          calls.push('purchase');
          return {
            status: 'completed',
            entitlementIds: ['COINS_100'],
          };
        },
        async getEntitlements() {
          return [];
        },
      },
      ads: {
        async preload() {},
        async showRewarded() {
          calls.push('showRewarded');
          return {
            status: 'completed',
            rewardGranted: true,
          };
        },
        async showInterstitial() {
          calls.push('showInterstitial');
          return {
            status: 'shown',
          };
        },
      },
      leaderboard: {
        async submitScore() {
          calls.push('submitScore');
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
    },
  };
}

function platformTargetForConfig(configTarget: (typeof configTargets)[number]): PlatformTarget {
  return configTarget === 'web-preview' ? 'browser' : configTarget;
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
