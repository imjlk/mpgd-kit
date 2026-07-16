import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform';

import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import { createVerse8PlatformGateway } from '../../adapters/verse8/src/index';
import { resolveTargetMpgdLocale } from '../../packages/i18n/src/index';
import {
  createEffectiveTargetConfig,
  getEffectiveAdPlacementConfig,
  getEffectiveProductConfig,
} from '../../packages/target-config/src/effective';
import {
  getTargetConfig,
  isTargetConfiguredGateway,
  normalizeTargetIntegrationConfig,
  targetIntegrations,
  withTargetAvailability,
  type PlatformFeature,
  type TargetConfigMatrix,
  type TargetConfiguredGateway,
} from '../../packages/target-config/src/runtime';
import { readJsonFile } from '../io';

const targetConfigMatrix = readJsonFile(
  'packages/target-config/targets.json',
) as TargetConfigMatrix;
const adPlacements = readJsonFile('packages/catalog/placements.json') as AdPlacements;
const productCatalog = readJsonFile('packages/catalog/catalog.json') as ProductCatalog;

const platformFeatures = [
  'iap',
  'rewardedAds',
  'interstitialAds',
  'leaderboard',
  'localization',
] as const satisfies readonly PlatformFeature[];
const configTargets = [
  'web-preview',
  'microsoft-store',
  'verse8',
  'android',
  'ios',
  'ait',
  'reddit',
] as const;

for (const target of configTargets) {
  await verifyConfigTarget(target);
}

console.log(`Target config runtime smoke passed: ${configTargets.join(', ')}`);

async function verifyConfigTarget(configTarget: (typeof configTargets)[number]): Promise<void> {
  const platformTarget = platformTargetForConfig(configTarget);
  const targetGateway = createTargetGateway(platformTarget);
  const config = getTargetConfig(targetConfigMatrix, configTarget);
  const effectiveConfig = createEffectiveTargetConfig({
    target: configTarget,
    targetConfigVersion: targetConfigMatrix.version,
    config,
    catalog: productCatalog,
    adPlacements,
  });
  const gateway = withTargetAvailability(targetGateway.gateway, config, {
    configTarget,
    effectiveConfig,
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
  assertEqual(
    runtime.effectiveConfig,
    effectiveConfig,
    `${configTarget} effective config should be exposed`,
  );

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

  const integrationConfig = normalizeTargetIntegrationConfig(config.integrations);
  const expectedPresentationMode = integrationConfig.presentationMode;

  assertEqual(
    runtime.presentationMode,
    expectedPresentationMode,
    `${configTarget} presentation mode should match its runtime surface`,
  );

  for (const integration of targetIntegrations) {
    const integrationRuntime = runtime.integrations[integration];
    const expectedConfiguredState = integrationConfig[integration];
    const expectedAdapterSupported = supportsIntegration(targetGateway.gateway, integration);
    const expectedRuntimeState = expectedAdapterSupported ? expectedConfiguredState : 'unsupported';

    assertEqual(
      integrationRuntime.configuredState,
      expectedConfiguredState,
      `${configTarget} ${integration} configured state should match`,
    );
    assertEqual(
      integrationRuntime.adapterSupported,
      expectedAdapterSupported,
      `${configTarget} ${integration} adapter support should match gateway methods`,
    );
    assertEqual(
      integrationRuntime.state,
      expectedRuntimeState,
      `${configTarget} ${integration} runtime state should include adapter support`,
    );
  }

  assertEqual(
    gateway.identity.getSession !== undefined,
    targetGateway.gateway.identity.getSession !== undefined,
    `${configTarget} should preserve identity session lookup`,
  );
  assertEqual(
    gateway.identity.requestUpgrade !== undefined,
    runtime.integrations.identityUpgrade.state === 'available',
    `${configTarget} identity upgrade should be clamped by availability`,
  );
  assertEqual(
    gateway.presentation !== undefined,
    runtime.integrations.presentation.state === 'available',
    `${configTarget} presentation should be clamped by availability`,
  );
  assertEqual(
    gateway.sharing !== undefined,
    runtime.integrations.sharing.state === 'available' ||
      runtime.integrations.inboundShare.state === 'available',
    `${configTarget} sharing should be clamped by outbound and inbound availability`,
  );
  assertEqual(
    gateway.notifications !== undefined,
    runtime.integrations.notifications.state === 'available',
    `${configTarget} notifications should be clamped by availability`,
  );

  const fallbackLocale = runtime.config.localization.fallbackLocale;
  const expectedLocale =
    config.features.localization && runtime.features.localization.capabilitySupported
      ? 'ko'
      : fallbackLocale;

  assertEqual(
    resolveTargetMpgdLocale({
      capabilities: runtime.capabilities,
      preferredLocales: ['ko-KR'],
      fallbackLocale,
    }),
    expectedLocale,
    `${configTarget} localization feature should control locale resolution`,
  );

  if (configTarget === 'web-preview' || configTarget === 'microsoft-store') {
    assertEqual(
      getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.reason,
      'target-disabled',
      `${configTarget} products should be target-disabled`,
    );
    assertEqual(
      getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.reason,
      'target-disabled',
      `${configTarget} ad placements should be target-disabled`,
    );
    await verifyBrowserOnlyFallbacks(gateway, configTarget);
    return;
  }

  if (configTarget === 'verse8') {
    assertEqual(
      getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.reason,
      'target-disabled',
      'verse8 products should be target-disabled before VXShop integration',
    );
    assertEqual(
      getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
      true,
      'verse8 ad placements should be enabled',
    );
    await verifyBrowserOnlyFallbacks(gateway, configTarget);
    return;
  }

  if (configTarget === 'reddit') {
    assertEqual(
      getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.reason,
      'missing-platform-id',
      'reddit products should require an app-owned Devvit SKU',
    );
    assertEqual(
      getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.reason,
      'target-disabled',
      'reddit ad placements should be target-disabled',
    );
    assertEqual(
      runtime.features.leaderboard.reason,
      'target-disabled',
      'reddit platform leaderboard should be disabled',
    );
    assertEqual(
      runtime.features.iap.reason,
      'capability-unsupported',
      'reddit IAP should require an installed payments adapter',
    );
    assertDeepEqual(
      await gateway.commerce.purchase({
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'reddit-purchase',
      }),
      {
        status: 'cancelled',
        entitlementIds: [],
      },
      'reddit purchase should remain disabled without a payments adapter',
    );
    assertDeepEqual(
      await gateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'reddit-reward',
      }),
      {
        status: 'unavailable',
        rewardGranted: false,
      },
      'reddit rewarded ad should be unavailable',
    );
    assertDeepEqual(
      await gateway.leaderboard.submitScore({
        leaderboardId: 'default',
        score: 1,
        runId: 'reddit-run',
        submittedAt: new Date().toISOString(),
      }),
      {
        submitted: false,
      },
      'reddit should reject generic platform leaderboard submissions',
    );
    assertDeepEqual(
      targetGateway.calls,
      [],
      'reddit should not delegate disabled leaderboard actions',
    );
    return;
  }

  assertEqual(
    getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.enabled,
    true,
    `${configTarget} products should be enabled`,
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    true,
    `${configTarget} rewarded placement should be enabled`,
  );

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

async function verifyBrowserOnlyFallbacks(
  gateway: TargetConfiguredGateway,
  configTarget: 'web-preview' | 'microsoft-store' | 'verse8',
): Promise<void> {
  const runtime = await gateway.getTargetRuntime();
  const adsEnabled = configTarget === 'verse8';

  assertEqual(runtime.configTarget, configTarget, 'browser-only config target should match');
  assertEqual(runtime.features.iap.reason, 'target-disabled', 'IAP should be target-disabled');
  assertEqual(
    runtime.features.rewardedAds.reason,
    adsEnabled ? 'available' : 'target-disabled',
    `rewarded ads should match ${configTarget} availability`,
  );
  assertEqual(
    runtime.features.interstitialAds.reason,
    adsEnabled ? 'available' : 'target-disabled',
    `interstitial ads should match ${configTarget} availability`,
  );
  assertEqual(
    runtime.features.leaderboard.reason,
    'target-disabled',
    'leaderboard should be target-disabled',
  );
  assertEqual(
    runtime.integrations.sharing.state,
    'unsupported',
    'browser outbound sharing should require Web Share or clipboard support',
  );
  assertEqual(
    runtime.integrations.inboundShare.state,
    configTarget === 'verse8' ? 'unsupported' : 'available',
    `${configTarget} inbound sharing should match its configured adapter surface`,
  );
  assertEqual(
    runtime.features.localization.reason,
    'available',
    'localization should be available',
  );
  assertEqual(
    runtime.capabilities.rewardedAds,
    adsEnabled,
    `rewarded capability should match ${configTarget} availability`,
  );
  assertEqual(
    runtime.capabilities.localizedContent,
    true,
    'localized content capability should remain available',
  );
  assertEqual(
    runtime.adPlacements.every((placement) => placement.enabled === adsEnabled),
    true,
    `all ${configTarget} ad placements should match target availability`,
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

  if (target === 'verse8') {
    return {
      gateway: createVerse8PlatformGateway({
        authClient: {
          getUser() {
            return {
              account: '0x1234567890abcdef',
              verse: 'production',
              exp: 4_000_000_000,
            };
          },
        },
        resolveAdPlacementId(placementId) {
          return placementId === 'CONTINUE_AFTER_FAIL'
            ? 'rewarded_continue'
            : 'stage_end_interstitial';
        },
      }),
      calls: [],
    };
  }

  const calls: string[] = [];

  return {
    calls,
    gateway: {
      target,
      async getCapabilities() {
        const isReddit = target === 'reddit';

        return {
          nativeIap: !isReddit,
          nativeAds: !isReddit,
          rewardedAds: !isReddit,
          interstitialAds: !isReddit,
          nativeLeaderboard: !isReddit,
          achievements: false,
          cloudSave: isReddit,
          socialShare: target === 'ait' || target === 'reddit',
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
        async getSession() {
          return {
            identityLevel: 'platform-anonymous',
            playerId: `${target}-player`,
            trustLevel: 'platform-asserted',
          };
        },
        async requestUpgrade() {
          return {
            status: 'unavailable',
            reloadExpected: false,
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
      presentation: {
        async getLaunchIntent() {
          return {
            entry: 'home',
          };
        },
        async requestGameSurface() {
          return 'already-fullscreen';
        },
      },
      sharing: {
        async share() {
          return {
            status: 'shared',
          };
        },
        async readInboundShare() {
          return null;
        },
      },
      notifications: {
        async getStatus() {
          return 'not-subscribed';
        },
        async requestSubscription() {
          return 'subscribed';
        },
      },
    },
  };
}

function platformTargetForConfig(configTarget: (typeof configTargets)[number]): PlatformTarget {
  return configTarget === 'web-preview' || configTarget === 'microsoft-store'
    ? 'browser'
    : configTarget;
}

function supportsIntegration(
  gateway: PlatformGateway,
  integration: (typeof targetIntegrations)[number],
): boolean {
  switch (integration) {
    case 'identityUpgrade':
      return typeof gateway.identity.requestUpgrade === 'function';
    case 'presentation':
      return (
        typeof gateway.presentation?.getLaunchIntent === 'function'
        && typeof gateway.presentation?.requestGameSurface === 'function'
      );
    case 'sharing':
      return typeof gateway.sharing?.share === 'function';
    case 'inboundShare':
      return typeof gateway.sharing?.readInboundShare === 'function';
    case 'notifications':
      return (
        typeof gateway.notifications?.getStatus === 'function'
        && typeof gateway.notifications?.requestSubscription === 'function'
      );
  }
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
