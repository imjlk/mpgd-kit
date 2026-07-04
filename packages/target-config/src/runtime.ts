import type { PlatformCapabilities, PlatformGateway } from '@mpgd/platform-contract';

import type { EffectiveTargetConfig } from './effective';

export type PlatformFeature =
  | 'iap'
  | 'rewardedAds'
  | 'interstitialAds'
  | 'leaderboard'
  | 'localization';

export type AdPlacementType = 'rewarded' | 'interstitial';
type PlatformConfigTarget = PlatformGateway['target'];

export type TargetRuntimeKind =
  | 'web-preview'
  | 'capacitor-android'
  | 'capacitor-ios'
  | 'apps-in-toss';

export type ReleaseProfile = 'web-preview' | 'google-play' | 'app-store' | 'apps-in-toss';

export type StorageSupport = 'local' | 'native' | 'none';

export interface TargetFeatureConfig {
  readonly iap: boolean;
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
  readonly leaderboard: boolean;
  readonly localization: boolean;
}

export interface TargetCapabilityConfig {
  readonly storage: StorageSupport;
  readonly localization: boolean;
}

export interface TargetMonetizationConfig {
  readonly iap: boolean;
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
}

export interface TargetLeaderboardConfig {
  readonly native: boolean;
}

export interface TargetReleaseConfig {
  readonly profile: ReleaseProfile;
}

export interface TargetPolicyRestrictions {
  readonly externalPaymentAllowed: boolean;
  readonly remoteExecutableCodeAllowed: boolean;
  readonly installOtherAppCTAAllowed: boolean;
  readonly requiresStoreReview: boolean;
  readonly requiresAitReview: boolean;
}

export interface TargetConfig {
  readonly runtime: TargetRuntimeKind;
  readonly features: TargetFeatureConfig;
  readonly capabilities: TargetCapabilityConfig;
  readonly monetization: TargetMonetizationConfig;
  readonly leaderboard: TargetLeaderboardConfig;
  readonly release: TargetReleaseConfig;
  readonly policy: TargetPolicyRestrictions;
}

export interface TargetConfigMatrix {
  readonly version: string;
  readonly targets: Record<string, TargetConfig>;
}

export type FeatureAvailabilityReason =
  | 'available'
  | 'target-disabled'
  | 'capability-unsupported';

export interface FeatureAvailability {
  readonly feature: PlatformFeature;
  readonly enabled: boolean;
  readonly targetEnabled: boolean;
  readonly capabilitySupported: boolean;
  readonly reason: FeatureAvailabilityReason;
}

export interface AdPlacementDefinition {
  readonly id: string;
  readonly type: AdPlacementType;
}

export interface AdPlacementAvailability {
  readonly id: string;
  readonly type: AdPlacementType;
  readonly enabled: boolean;
  readonly reason: FeatureAvailabilityReason;
}

export interface TargetRuntimeSnapshot {
  readonly target: PlatformConfigTarget;
  readonly configTarget: string;
  readonly config: TargetConfig;
  readonly effectiveConfig?: EffectiveTargetConfig;
  readonly capabilities: PlatformCapabilities;
  readonly features: Record<PlatformFeature, FeatureAvailability>;
  readonly adPlacements: readonly AdPlacementAvailability[];
}

export interface TargetAvailabilityOptions {
  readonly configTarget?: string;
  readonly effectiveConfig?: EffectiveTargetConfig;
  readonly adPlacements?: readonly AdPlacementDefinition[];
  readonly resolveAdPlacementType?: (placementId: string) => AdPlacementType | undefined;
}

export interface TargetConfiguredGateway extends PlatformGateway {
  readonly configTarget: string;
  readonly targetConfig: TargetConfig;
  readonly effectiveConfig?: EffectiveTargetConfig;
  getTargetRuntime(): Promise<TargetRuntimeSnapshot>;
}

export const platformFeatures = [
  'iap',
  'rewardedAds',
  'interstitialAds',
  'leaderboard',
  'localization',
] as const satisfies readonly PlatformFeature[];

export function targetConfigKeyForPlatform(target: PlatformConfigTarget): string {
  return target === 'browser' ? 'web-preview' : target;
}

export function getTargetConfig(
  matrix: TargetConfigMatrix,
  target: PlatformConfigTarget | string,
): TargetConfig {
  const config = matrix.targets[target];

  if (config === undefined) {
    throw new Error(`Missing target config for target: ${target}`);
  }

  return config;
}

export function isPlatformFeatureEnabled(
  config: TargetConfig,
  feature: PlatformFeature,
): boolean {
  return config.features[feature];
}

export function applyTargetConfigToCapabilities(
  capabilities: PlatformCapabilities,
  config: TargetConfig,
): PlatformCapabilities {
  return {
    ...capabilities,
    nativeIap: capabilities.nativeIap && config.features.iap,
    nativeAds:
      capabilities.nativeAds &&
      (config.features.rewardedAds || config.features.interstitialAds),
    rewardedAds: capabilities.rewardedAds && config.features.rewardedAds,
    interstitialAds: capabilities.interstitialAds && config.features.interstitialAds,
    nativeLeaderboard: capabilities.nativeLeaderboard && config.features.leaderboard,
    localizedContent: capabilities.localizedContent && config.features.localization,
  };
}

export function getFeatureAvailability(
  feature: PlatformFeature,
  config: TargetConfig,
  capabilities: PlatformCapabilities,
): FeatureAvailability {
  const targetEnabled = config.features[feature];
  const capabilitySupported = isFeatureCapabilitySupported(feature, capabilities);
  const enabled = targetEnabled && capabilitySupported;

  return {
    feature,
    enabled,
    targetEnabled,
    capabilitySupported,
    reason: enabled
      ? 'available'
      : targetEnabled
        ? 'capability-unsupported'
        : 'target-disabled',
  };
}

export function createTargetRuntimeSnapshot(input: {
  readonly target: PlatformConfigTarget;
  readonly configTarget?: string;
  readonly config: TargetConfig;
  readonly effectiveConfig?: EffectiveTargetConfig;
  readonly capabilities: PlatformCapabilities;
  readonly adPlacements?: readonly AdPlacementDefinition[];
}): TargetRuntimeSnapshot {
  const configTarget = input.configTarget ?? targetConfigKeyForPlatform(input.target);
  const features = {
    iap: getFeatureAvailability('iap', input.config, input.capabilities),
    rewardedAds: getFeatureAvailability('rewardedAds', input.config, input.capabilities),
    interstitialAds: getFeatureAvailability(
      'interstitialAds',
      input.config,
      input.capabilities,
    ),
    leaderboard: getFeatureAvailability('leaderboard', input.config, input.capabilities),
    localization: getFeatureAvailability('localization', input.config, input.capabilities),
  } satisfies Record<PlatformFeature, FeatureAvailability>;

  return {
    target: input.target,
    configTarget,
    config: input.config,
    ...(input.effectiveConfig === undefined ? {} : { effectiveConfig: input.effectiveConfig }),
    capabilities: input.capabilities,
    features,
    adPlacements: (input.adPlacements ?? []).map((placement) => {
      const feature = placement.type === 'rewarded' ? 'rewardedAds' : 'interstitialAds';
      const availability = features[feature];

      return {
        id: placement.id,
        type: placement.type,
        enabled: availability.enabled,
        reason: availability.reason,
      };
    }),
  };
}

export function withTargetAvailability(
  gateway: PlatformGateway,
  config: TargetConfig,
  options: TargetAvailabilityOptions = {},
): TargetConfiguredGateway {
  const configTarget = options.configTarget ?? targetConfigKeyForPlatform(gateway.target);
  const isAdPlacementAllowed = (
    placementId: string,
    expectedType: AdPlacementType,
  ): boolean => {
    const actualType = options.resolveAdPlacementType?.(placementId);

    if (actualType !== undefined && actualType !== expectedType) {
      return false;
    }

    return expectedType === 'rewarded'
      ? config.features.rewardedAds
      : config.features.interstitialAds;
  };

  const canPreloadAdPlacement = (placementId: string): boolean => {
    const actualType = options.resolveAdPlacementType?.(placementId);

    if (actualType === 'rewarded') {
      return config.features.rewardedAds;
    }

    if (actualType === 'interstitial') {
      return config.features.interstitialAds;
    }

    return config.features.rewardedAds || config.features.interstitialAds;
  };

  return {
    ...gateway,
    configTarget,
    targetConfig: config,
    ...(options.effectiveConfig === undefined
      ? {}
      : { effectiveConfig: options.effectiveConfig }),
    async getTargetRuntime() {
      return createTargetRuntimeSnapshot({
        target: gateway.target,
        configTarget,
        config,
        ...(options.effectiveConfig === undefined
          ? {}
          : { effectiveConfig: options.effectiveConfig }),
        capabilities: applyTargetConfigToCapabilities(await gateway.getCapabilities(), config),
        adPlacements: options.adPlacements ?? [],
      });
    },
    async getCapabilities() {
      return applyTargetConfigToCapabilities(await gateway.getCapabilities(), config);
    },
    commerce: config.features.iap
      ? gateway.commerce
      : {
          async getProducts() {
            return [];
          },
          async purchase() {
            return {
              status: 'cancelled',
              entitlementIds: [],
            };
          },
          async restore() {
            return {
              restoredEntitlements: [],
            };
          },
          async getEntitlements() {
            return [];
          },
        },
    ads: {
      async preload(input) {
        if (canPreloadAdPlacement(input.placementId)) {
          await gateway.ads.preload(input);
        }
      },
      async showRewarded(input) {
        if (!isAdPlacementAllowed(input.placementId, 'rewarded')) {
          return {
            status: 'unavailable',
            rewardGranted: false,
          };
        }

        return gateway.ads.showRewarded(input);
      },
      async showInterstitial(input) {
        if (
          !isAdPlacementAllowed(input.placementId, 'interstitial') ||
          gateway.ads.showInterstitial === undefined
        ) {
          return {
            status: 'unavailable',
          };
        }

        return gateway.ads.showInterstitial(input);
      },
    },
    leaderboard: config.features.leaderboard
      ? gateway.leaderboard
      : {
          async submitScore() {
            return {
              submitted: false,
            };
          },
          async open() {},
        },
  };
}

export function isTargetConfiguredGateway(
  gateway: PlatformGateway,
): gateway is TargetConfiguredGateway {
  return typeof (gateway as Partial<TargetConfiguredGateway>).getTargetRuntime === 'function';
}

function isFeatureCapabilitySupported(
  feature: PlatformFeature,
  capabilities: PlatformCapabilities,
): boolean {
  switch (feature) {
    case 'iap':
      return capabilities.nativeIap;
    case 'rewardedAds':
      return capabilities.rewardedAds;
    case 'interstitialAds':
      return capabilities.interstitialAds;
    case 'leaderboard':
      return capabilities.nativeLeaderboard;
    case 'localization':
      return capabilities.localizedContent;
  }
}
