import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import { resolveDemoLocale } from '../../apps/game-phaser/src/platform/i18n';
import type { AdPlacements } from '../../packages/ad-placements/src/index';
import type { PlatformGateway, PlatformTarget } from '../../packages/platform-contract/src/index';
import {
  getTargetPolicy,
  isPolicyEnforcedGateway,
  withPolicyEnforcement,
  type PolicyEnforcedGateway,
  type PolicyFeature,
  type PolicyMatrix,
} from '../../packages/policy-matrix/src/runtime';
import { readJsonFile } from '../io';

const policyMatrix = readJsonFile('packages/policy-matrix/policy.json') as PolicyMatrix;
const adPlacements = readJsonFile('packages/ad-placements/placements.json') as AdPlacements;

const policyFeatures = [
  'iap',
  'rewardedAds',
  'interstitialAds',
  'leaderboard',
  'i18n',
] as const satisfies readonly PolicyFeature[];
const policyTargets = ['web-preview', 'android', 'ios', 'ait'] as const;

for (const target of policyTargets) {
  await verifyPolicyTarget(target);
}

console.log(`Policy runtime smoke passed: ${policyTargets.join(', ')}`);

async function verifyPolicyTarget(policyTarget: (typeof policyTargets)[number]): Promise<void> {
  const platformTarget = platformTargetForPolicy(policyTarget);
  const targetGateway = createTargetGateway(platformTarget);
  const policy = getTargetPolicy(policyMatrix, policyTarget);
  const gateway = withPolicyEnforcement(targetGateway.gateway, policy, {
    policyTarget,
    adPlacements: adPlacements.placements.map((placement) => ({
      id: placement.id,
      type: placement.type,
    })),
    resolveAdPlacementType(placementId) {
      return adPlacements.placements.find((placement) => placement.id === placementId)?.type;
    },
  });

  assertEqual(
    isPolicyEnforcedGateway(gateway),
    true,
    `${policyTarget} should expose policy runtime`,
  );

  const runtime = await gateway.getPolicyRuntime();

  assertEqual(runtime.policyTarget, policyTarget, `${policyTarget} policy target should match`);

  for (const feature of policyFeatures) {
    const featureRuntime = runtime.features[feature];

    assertEqual(
      featureRuntime.policyAllowed,
      policy[feature],
      `${policyTarget} ${feature} policy should match`,
    );
    assertEqual(
      featureRuntime.enabled,
      featureRuntime.policyAllowed && featureRuntime.capabilitySupported,
      `${policyTarget} ${feature} enabled state should follow policy and capability`,
    );
  }

  assertEqual(
    resolveDemoLocale(runtime.capabilities, 'ko-KR'),
    policy.i18n && runtime.features.i18n.capabilitySupported ? 'ko' : 'en',
    `${policyTarget} i18n policy should control locale resolution`,
  );

  if (policyTarget === 'web-preview') {
    await verifyWebPreviewFallbacks(gateway);
    return;
  }

  await gateway.commerce.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: `${policyTarget}-purchase`,
  });
  await gateway.ads.showRewarded({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: `${policyTarget}-reward`,
  });
  await gateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' });
  await gateway.leaderboard.submitScore({
    leaderboardId: 'default',
    score: 1,
    runId: `${policyTarget}-run`,
    submittedAt: new Date().toISOString(),
  });

  assertDeepEqual(
    targetGateway.calls,
    ['purchase', 'showRewarded', 'showInterstitial', 'submitScore'],
    `${policyTarget} enabled features should delegate to the platform gateway`,
  );
}

async function verifyWebPreviewFallbacks(
  gateway: PolicyEnforcedGateway,
): Promise<void> {
  const runtime = await gateway.getPolicyRuntime();

  assertEqual(runtime.policyTarget, 'web-preview', 'browser should map to web-preview policy');
  assertEqual(runtime.features.iap.reason, 'policy-disabled', 'IAP should be policy-disabled');
  assertEqual(
    runtime.features.rewardedAds.reason,
    'policy-disabled',
    'rewarded ads should be policy-disabled',
  );
  assertEqual(
    runtime.features.interstitialAds.reason,
    'policy-disabled',
    'interstitial ads should be policy-disabled',
  );
  assertEqual(
    runtime.features.leaderboard.reason,
    'policy-disabled',
    'leaderboard should be policy-disabled',
  );
  assertEqual(runtime.features.i18n.reason, 'available', 'i18n should be available');
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
      idempotencyKey: 'policy-smoke-reward',
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
      runId: 'policy-smoke',
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

function platformTargetForPolicy(policyTarget: (typeof policyTargets)[number]): PlatformTarget {
  return policyTarget === 'web-preview' ? 'browser' : policyTarget;
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
