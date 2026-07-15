import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import type { PlatformGateway } from '@mpgd/platform';

import {
  createEffectiveTargetConfig,
  getEffectiveAdPlacementConfig,
  getEffectiveProductConfig,
} from '../src/effective';
import { assertTargetConfigMatrix } from '../src/index';
import {
  applyTargetConfigToCapabilities,
  createTargetRuntimeSnapshot,
  getTargetConfig,
  normalizeTargetIntegrationConfig,
  targetConfigKeyForPlatform,
  withTargetAvailability,
  type TargetConfig,
  type TargetConfigMatrix,
  type TargetIntegrationConfig,
} from '../src/runtime';
import {
  resolveTargetViewportOrientationPlan,
  resolveTargetViewportPlan,
  resolveTargetViewportSizeClass,
  targetViewportShellForConfig,
} from '../src/viewport';

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
    android: createTargetConfig(
      {
        iap: true,
        rewardedAds: true,
        interstitialAds: true,
        leaderboard: true,
        localization: true,
      },
      {
        identityUpgrade: 'available',
        presentation: 'available',
        sharing: 'available',
        inboundShare: 'available',
        notifications: 'configuration-required',
        presentationMode: 'fullscreen',
      },
    ),
  },
} satisfies TargetConfigMatrix;

let invalidFallbackRejected = false;

try {
  assertTargetConfigMatrix({
    ...targetConfigMatrix,
    targets: {
      ...targetConfigMatrix.targets,
      'web-preview': {
        ...targetConfigMatrix.targets['web-preview'],
        localization: {
          fallbackLocale: 'kr',
        },
      },
    },
  });
} catch {
  invalidFallbackRejected = true;
}

assertEqual(invalidFallbackRejected, true);
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
assertEqual(targetConfigKeyForPlatform('verse8'), 'verse8');
assertViewportPlans();

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
assertEqual(webRuntime.presentationMode, 'fullscreen');
assertEqual(webProduct?.reason, 'target-disabled');
assertEqual(webRewardedPlacement?.reason, 'target-disabled');
assertEqual(webRuntime.features.iap.reason, 'target-disabled');
assertEqual(webRuntime.features.rewardedAds.reason, 'target-disabled');
assertEqual(webRuntime.features.interstitialAds.reason, 'target-disabled');
assertEqual(webRuntime.features.leaderboard.reason, 'target-disabled');
assertEqual(webRuntime.features.localization.reason, 'available');
assertDeepEqual(webEffectiveConfig.localization, {
  enabled: true,
  fallbackLocale: 'en',
});
assertDeepEqual(webEffectiveConfig.integrations, {
  identityUpgrade: 'disabled',
  presentation: 'disabled',
  sharing: 'disabled',
  inboundShare: 'disabled',
  notifications: 'unsupported',
  presentationMode: 'fullscreen',
});
assertDeepEqual(
  normalizeTargetIntegrationConfig({
    identityUpgrade: 'available',
  }),
  {
    identityUpgrade: 'available',
    presentation: 'disabled',
    sharing: 'disabled',
    inboundShare: 'disabled',
    notifications: 'unsupported',
    presentationMode: 'fullscreen',
  },
);
assertDeepEqual(webRuntime.integrations.identityUpgrade, {
  integration: 'identityUpgrade',
  state: 'disabled',
  configuredState: 'disabled',
  adapterSupported: true,
});
assertDeepEqual(webRuntime.integrations.notifications, {
  integration: 'notifications',
  state: 'unsupported',
  configuredState: 'unsupported',
  adapterSupported: true,
});
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
assertDeepEqual(await webGateway.storage.load({ key: 'save:v1' }), {
  value: 'stored-save',
});
assertDeepEqual(await webGateway.identity.getSession?.(), {
  identityLevel: 'guest',
  trustLevel: 'local',
});
assertEqual(webGateway.identity.requestUpgrade, undefined);
assertEqual(webGateway.presentation, undefined);
assertEqual(webGateway.sharing, undefined);
assertEqual(webGateway.notifications, undefined);

const inboundOnlyGateway = withTargetAvailability(gateway, {
  ...webConfig,
  integrations: {
    identityUpgrade: 'disabled',
    presentation: 'disabled',
    sharing: 'disabled',
    inboundShare: 'available',
    notifications: 'unsupported',
    presentationMode: 'fullscreen',
  },
});

assertEqual(inboundOnlyGateway.sharing?.share, undefined);
assertDeepEqual(await inboundOnlyGateway.sharing?.readInboundShare?.(), {
  puzzleId: 'daily-1',
});
assertDeepEqual(delegatedCalls, ['readInboundShare']);
delegatedCalls.length = 0;

const partialSharingGateway = {
  ...gateway,
  sharing: {
    async share() {
      return { status: 'shared' } as const;
    },
  },
} satisfies PlatformGateway;
const partialSharingRuntime = createTargetRuntimeSnapshot({
  target: 'browser',
  config: {
    ...webConfig,
    integrations: {
      identityUpgrade: 'disabled',
      presentation: 'disabled',
      sharing: 'available',
      inboundShare: 'available',
      notifications: 'unsupported',
      presentationMode: 'fullscreen',
    },
  },
  capabilities: await partialSharingGateway.getCapabilities(),
  gateway: partialSharingGateway,
});

assertEqual(partialSharingRuntime.integrations.sharing.state, 'available');
assertEqual(partialSharingRuntime.integrations.inboundShare.state, 'unsupported');

const inboundSharingGateway = {
  ...gateway,
  sharing: {
    async readInboundShare() {
      return { puzzleId: 'daily-1' };
    },
  },
} satisfies PlatformGateway;
const inboundSharingRuntime = createTargetRuntimeSnapshot({
  target: 'browser',
  config: {
    ...webConfig,
    integrations: {
      identityUpgrade: 'disabled',
      presentation: 'disabled',
      sharing: 'available',
      inboundShare: 'available',
      notifications: 'unsupported',
      presentationMode: 'fullscreen',
    },
  },
  capabilities: await inboundSharingGateway.getCapabilities(),
  gateway: inboundSharingGateway,
});

assertEqual(inboundSharingRuntime.integrations.sharing.state, 'unsupported');
assertEqual(inboundSharingRuntime.integrations.inboundShare.state, 'available');

const upgradeOnlyIdentityGateway = {
  ...gateway,
  identity: {
    getPlayer: gateway.identity.getPlayer,
    requestUpgrade: gateway.identity.requestUpgrade,
  },
} as PlatformGateway;
const upgradeOnlyIdentityRuntime = createTargetRuntimeSnapshot({
  target: 'browser',
  config: {
    ...webConfig,
    integrations: {
      identityUpgrade: 'available',
      presentation: 'disabled',
      sharing: 'disabled',
      inboundShare: 'disabled',
      notifications: 'unsupported',
      presentationMode: 'fullscreen',
    },
  },
  capabilities: await upgradeOnlyIdentityGateway.getCapabilities(),
  gateway: upgradeOnlyIdentityGateway,
});

assertEqual(upgradeOnlyIdentityRuntime.integrations.identityUpgrade.state, 'available');

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
const androidTargetOverrideEffectiveConfig = createEffectiveTargetConfig({
  target: 'android',
  targetConfigVersion: targetConfigMatrix.version,
  config: androidConfig,
  catalog: productCatalog,
  adPlacements,
  platformTarget: {
    kind: 'capacitor-android',
    adapter: 'capacitor',
    integrations: {
      presentation: 'disabled',
      sharing: 'disabled',
      inboundShare: 'disabled',
      notifications: 'disabled',
      presentationMode: 'inline-expanded',
    },
  },
});
const androidTargetOverrideGateway = withTargetAvailability(gateway, androidConfig, {
  effectiveConfig: androidTargetOverrideEffectiveConfig,
  resolveAdPlacementType,
});
const androidGateway = withTargetAvailability(gateway, androidConfig, {
  effectiveConfig: androidEffectiveConfig,
  resolveAdPlacementType,
});
const androidTargetOverrideRuntime = await androidTargetOverrideGateway.getTargetRuntime();
const androidRuntime = await androidGateway.getTargetRuntime();

assertEqual(androidRuntime.presentationMode, 'fullscreen');
assertEqual(androidEffectiveConfig.integrations.identityUpgrade, 'available');
assertDeepEqual(androidTargetOverrideEffectiveConfig.integrations, {
  identityUpgrade: 'available',
  presentation: 'disabled',
  sharing: 'disabled',
  inboundShare: 'disabled',
  notifications: 'disabled',
  presentationMode: 'inline-expanded',
});
assertEqual(androidTargetOverrideRuntime.presentationMode, 'inline-expanded');
assertEqual(androidTargetOverrideRuntime.integrations.presentation.state, 'disabled');
assertEqual(androidTargetOverrideRuntime.integrations.sharing.state, 'disabled');
assertEqual(androidTargetOverrideRuntime.integrations.inboundShare.state, 'disabled');
assertEqual(androidTargetOverrideRuntime.integrations.notifications.state, 'disabled');
assertEqual(androidTargetOverrideGateway.presentation, undefined);
assertEqual(androidTargetOverrideGateway.sharing, undefined);
assertEqual(androidTargetOverrideGateway.notifications, undefined);
assertEqual(androidRuntime.integrations.identityUpgrade.state, 'available');
assertEqual(androidRuntime.integrations.presentation.state, 'available');
assertEqual(androidRuntime.integrations.sharing.state, 'available');
assertEqual(androidRuntime.integrations.inboundShare.state, 'available');
const androidNotifications = androidRuntime.integrations.notifications;
assertEqual(androidNotifications.state, 'configuration-required');
assertEqual(androidNotifications.adapterSupported, true);
assertEqual(androidGateway.notifications, undefined);
await androidGateway.identity.requestUpgrade?.({ reason: 'save' });
await androidGateway.presentation?.requestGameSurface({ entry: 'daily' });
await androidGateway.sharing?.share?.({
  kind: 'daily-result',
  title: 'Daily result',
  text: "Finished today's puzzle.",
  deepLink: 'https://example.test/daily',
});
await androidGateway.sharing?.readInboundShare?.();
assertDeepEqual(delegatedCalls, [
  'requestUpgrade',
  'requestGameSurface',
  'share',
  'readInboundShare',
]);
delegatedCalls.length = 0;

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

const redditEffectiveConfig = createEffectiveTargetConfig({
  target: 'reddit',
  targetConfigVersion: targetConfigMatrix.version,
  config: createTargetConfig({
    iap: true,
    rewardedAds: false,
    interstitialAds: false,
    leaderboard: false,
    localization: true,
  }),
  catalog: {
    version: 'reddit-catalog',
    products: [
      {
        id: 'FINAL_NINE_EMBER_THEME',
        type: 'non_consumable',
        grant: {
          type: 'entitlement',
          entitlement: 'cosmetic.final-nine.ember',
        },
        platformProductIds: {
          reddit: 'ttokdoku_final_nine_ember',
        },
      },
    ],
  },
  adPlacements: {
    version: 'reddit-ads',
    placements: [],
  },
});
const redditProduct = getEffectiveProductConfig(redditEffectiveConfig, 'FINAL_NINE_EMBER_THEME');
assertEqual(redditProduct?.enabled, true);
assertEqual(redditProduct?.platformProductId, 'ttokdoku_final_nine_ember');

const blankEffectiveConfig = createEffectiveTargetConfig({
  target: 'android',
  targetConfigVersion: targetConfigMatrix.version,
  config: androidConfig,
  catalog: {
    version: 'blank-catalog',
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
          android: ' ',
        },
      },
    ],
  },
  adPlacements: {
    version: 'blank-ads',
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
          android: '',
        },
      },
    ],
  },
});

const blankProductConfig = getEffectiveProductConfig(blankEffectiveConfig, 'COINS_100');
assertEqual(blankProductConfig?.reason, 'missing-platform-id');
assertEqual(blankProductConfig?.platformProductId, undefined);

const blankAdPlacementConfig = getEffectiveAdPlacementConfig(
  blankEffectiveConfig,
  'CONTINUE_AFTER_FAIL',
);
assertEqual(blankAdPlacementConfig?.reason, 'missing-platform-id');
assertEqual(blankAdPlacementConfig?.platformPlacementId, undefined);

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

function createTargetConfig(
  features: TargetConfig['features'],
  integrations?: TargetIntegrationConfig,
): TargetConfig {
  return {
    runtime: 'web-preview',
    features,
    capabilities: {
      storage: 'local',
      localization: features.localization,
    },
    localization: {
      fallbackLocale: 'en',
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
    ...(integrations === undefined ? {} : { integrations }),
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
      async getSession() {
        return {
          identityLevel: 'guest',
          trustLevel: 'local',
        };
      },
      async requestUpgrade() {
        delegatedCalls.push('requestUpgrade');
        return {
          status: 'completed',
          reloadExpected: false,
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
        return {
          value: 'stored-save',
        };
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
        delegatedCalls.push('requestGameSurface');
        return 'already-fullscreen';
      },
    },
    sharing: {
      async share() {
        delegatedCalls.push('share');
        return {
          status: 'shared',
        };
      },
      async readInboundShare() {
        delegatedCalls.push('readInboundShare');
        return {
          puzzleId: 'daily-1',
        };
      },
    },
    notifications: {
      async getStatus() {
        delegatedCalls.push('getNotificationStatus');
        return 'not-subscribed';
      },
      async requestSubscription() {
        delegatedCalls.push('requestNotificationSubscription');
        return 'subscribed';
      },
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

function assertViewportPlans(): void {
  const compactDevvitDimensions = {
    width: 412,
    height: 732,
  };
  const mediumTabletDimensions = {
    width: 768,
    height: 1024,
  };
  const desktopDevvitDimensions = {
    width: 960,
    height: 540,
  };
  const phoneWebViewDimensions = {
    width: 390,
    height: 844,
  };
  const desktopBrowserDimensions = {
    width: 1280,
    height: 720,
  };
  const landscapePhoneBrowserDimensions = {
    width: 844,
    height: 390,
  };
  const compactDevvit = resolveTargetViewportPlan({
    ...compactDevvitDimensions,
    runtime: 'devvit-web',
    source: 'container',
  });
  const mediumTablet = resolveTargetViewportPlan({
    ...mediumTabletDimensions,
    runtime: 'web-preview',
  });
  const desktopDevvit = resolveTargetViewportPlan({
    ...desktopDevvitDimensions,
    runtime: 'devvit-web',
  });
  const phoneWebView = resolveTargetViewportPlan({
    ...phoneWebViewDimensions,
    runtime: 'capacitor-ios',
  });
  const desktopBrowser = resolveTargetViewportPlan({
    ...desktopBrowserDimensions,
    runtime: 'web-preview',
  });
  const verse8Iframe = resolveTargetViewportPlan({
    ...desktopBrowserDimensions,
    runtime: 'verse8-web',
    source: 'container',
  });
  const landscapePhoneBrowser = resolveTargetViewportPlan({
    ...landscapePhoneBrowserDimensions,
    runtime: 'web-preview',
  });

  assertEqual(compactDevvit.layout.shell, 'embedded-webview');
  assertEqual(compactDevvit.layout.source, 'container');
  assertEqual(compactDevvit.layout.orientation, 'portrait');
  assertEqual(compactDevvit.layout.sizeClass, 'compact');
  assertEqual(compactDevvit.layout.shortSide, 412);
  assertEqual(compactDevvit.layout.longSide, 732);
  assertEqual(compactDevvit.orientation.mode, 'responsive');
  assertEqual(compactDevvit.orientation.isMismatch, false);
  assertEqual(compactDevvit.orientation.shouldShowRotatePrompt, false);
  assertEqual(compactDevvit.orientation.shouldLetterbox, false);
  assertEqual(compactDevvit.recommendation.primaryControls, 'bottom');
  assertEqual(compactDevvit.recommendation.secondaryPanels, 'drawer');
  assertEqual(compactDevvit.recommendation.safeAreaAware, true);
  assertEqual(mediumTablet.layout.shell, 'browser');
  assertEqual(mediumTablet.layout.orientation, 'portrait');
  assertEqual(mediumTablet.layout.sizeClass, 'medium');
  assertEqual(mediumTablet.recommendation.primaryControls, 'bottom');
  assertEqual(mediumTablet.recommendation.secondaryPanels, 'below');
  assertEqual(mediumTablet.recommendation.safeAreaAware, false);
  assertEqual(desktopDevvit.layout.shell, 'embedded-webview');
  assertEqual(desktopDevvit.layout.orientation, 'landscape');
  assertEqual(desktopDevvit.layout.sizeClass, 'expanded');
  assertEqual(desktopDevvit.recommendation.primaryControls, 'side');
  assertEqual(desktopDevvit.recommendation.secondaryPanels, 'side');
  assertEqual(desktopDevvit.recommendation.safeAreaAware, true);
  assertEqual(verse8Iframe.layout.shell, 'embedded-webview');
  assertEqual(verse8Iframe.layout.source, 'container');
  assertEqual(verse8Iframe.recommendation.safeAreaAware, true);
  assertEqual(phoneWebView.layout.shell, 'mobile-webview');
  assertEqual(phoneWebView.layout.orientation, 'portrait');
  assertEqual(phoneWebView.layout.sizeClass, 'compact');
  assertEqual(phoneWebView.recommendation.primaryControls, 'bottom');
  assertEqual(phoneWebView.recommendation.secondaryPanels, 'drawer');
  assertEqual(phoneWebView.recommendation.safeAreaAware, true);
  assertEqual(desktopBrowser.layout.shell, 'browser');
  assertEqual(desktopBrowser.layout.orientation, 'landscape');
  assertEqual(desktopBrowser.layout.sizeClass, 'expanded');
  assertEqual(desktopBrowser.recommendation.primaryControls, 'side');
  assertEqual(desktopBrowser.recommendation.secondaryPanels, 'side');
  assertEqual(desktopBrowser.recommendation.safeAreaAware, false);
  assertEqual(landscapePhoneBrowser.layout.shell, 'browser');
  assertEqual(landscapePhoneBrowser.layout.orientation, 'landscape');
  assertEqual(landscapePhoneBrowser.layout.sizeClass, 'medium');
  assertEqual(landscapePhoneBrowser.recommendation.primaryControls, 'side');
  assertEqual(landscapePhoneBrowser.recommendation.secondaryPanels, 'side');
  assertEqual(landscapePhoneBrowser.recommendation.safeAreaAware, true);
  assertDeepEqual(
    resolveTargetViewportOrientationPlan(compactDevvit.layout, {
      mode: 'lock-landscape',
    }),
    {
      mode: 'lock-landscape',
      preferredOrientation: 'landscape',
      lockedOrientation: 'landscape',
      mismatchBehavior: 'show-rotate-prompt',
      isMismatch: true,
      shouldLetterbox: false,
      shouldShowRotatePrompt: true,
    },
  );
  assertDeepEqual(
    resolveTargetViewportOrientationPlan(landscapePhoneBrowser.layout, {
      mode: 'prefer-portrait',
      mismatchBehavior: 'letterbox',
    }),
    {
      mode: 'prefer-portrait',
      preferredOrientation: 'portrait',
      mismatchBehavior: 'letterbox',
      isMismatch: true,
      shouldLetterbox: true,
      shouldShowRotatePrompt: false,
    },
  );
  assertDeepEqual(
    resolveTargetViewportPlan({
      ...compactDevvitDimensions,
      runtime: 'devvit-web',
      orientationPolicy: {
        mode: 'lock-portrait',
      },
    }).orientation,
    {
      mode: 'lock-portrait',
      preferredOrientation: 'portrait',
      lockedOrientation: 'portrait',
      mismatchBehavior: 'show-rotate-prompt',
      isMismatch: false,
      shouldLetterbox: false,
      shouldShowRotatePrompt: false,
    },
  );
  assertEqual(resolveTargetViewportSizeClass(599), 'compact');
  assertEqual(resolveTargetViewportSizeClass(600), 'medium');
  assertEqual(resolveTargetViewportSizeClass(900), 'expanded');
  assertEqual(
    targetViewportShellForConfig(
      createTargetConfig({
        iap: false,
        rewardedAds: false,
        interstitialAds: false,
        leaderboard: false,
        localization: true,
      }),
    ),
    'browser',
  );
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
