import type {
  AdPlacementEntry,
  AdPlacements,
  ProductCatalog,
  ProductCatalogEntry,
} from '@mpgd/catalog';

import {
  normalizeTargetIntegrationConfig,
  type FeatureAvailabilityReason,
  type TargetCapabilityConfig,
  type TargetConfig,
  type TargetConfigMatrix,
  type TargetFeatureConfig,
  type TargetIntegrationConfig,
  type TargetLocalizationConfig,
  type TargetPolicyRestrictions,
  type TargetReleaseConfig,
  type TargetRuntimeKind,
} from './runtime.js';

export type EffectiveAvailabilityReason =
  | FeatureAvailabilityReason
  | 'missing-platform-id';

export interface EffectivePlatformTargetMetadata {
  readonly kind: string;
  readonly adapter: string;
  readonly artifact?: string;
  readonly output?: string;
  readonly webDir?: string;
  readonly integrations?: Partial<TargetIntegrationConfig>;
}

export interface EffectiveTargetConfigSources {
  readonly targetConfig: string;
  readonly productCatalog: string;
  readonly adPlacements: string;
  readonly platformTargetKind?: string;
  readonly platformAdapter?: string;
}

export interface EffectiveProductConfig {
  readonly id: ProductCatalogEntry['id'];
  readonly type: ProductCatalogEntry['type'];
  readonly grant: ProductCatalogEntry['grant'];
  readonly enabled: boolean;
  readonly reason: EffectiveAvailabilityReason;
  readonly platformProductId?: string;
}

export interface EffectiveAdPlacementConfig {
  readonly id: AdPlacementEntry['id'];
  readonly type: AdPlacementEntry['type'];
  readonly reward?: AdPlacementEntry['reward'];
  readonly frequencyCap: AdPlacementEntry['frequencyCap'];
  readonly enabled: boolean;
  readonly reason: EffectiveAvailabilityReason;
  readonly platformPlacementId?: string;
}

export interface EffectiveMonetizationConfig {
  readonly iap: boolean;
  readonly products: readonly EffectiveProductConfig[];
}

export interface EffectiveAdsConfig {
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
  readonly placements: readonly EffectiveAdPlacementConfig[];
}

export interface EffectiveLeaderboardConfig {
  readonly native: boolean;
  readonly enabled: boolean;
  readonly reason: FeatureAvailabilityReason;
  readonly defaultLeaderboardId?: string;
}

export interface EffectiveStorageConfig {
  readonly support: TargetCapabilityConfig['storage'];
  readonly enabled: boolean;
}

export interface EffectiveLocalizationConfig {
  readonly enabled: boolean;
  readonly fallbackLocale: TargetLocalizationConfig['fallbackLocale'];
}

export interface EffectiveTargetConfig {
  readonly version: string;
  readonly target: string;
  readonly runtime: TargetRuntimeKind;
  readonly release: TargetReleaseConfig;
  readonly features: TargetFeatureConfig;
  readonly capabilities: TargetCapabilityConfig;
  readonly integrations: TargetIntegrationConfig;
  readonly policy: TargetPolicyRestrictions;
  readonly sources: EffectiveTargetConfigSources;
  readonly monetization: EffectiveMonetizationConfig;
  readonly ads: EffectiveAdsConfig;
  readonly leaderboard: EffectiveLeaderboardConfig;
  readonly storage: EffectiveStorageConfig;
  readonly localization: EffectiveLocalizationConfig;
}

export interface EffectiveTargetConfigMatrix {
  readonly version: string;
  readonly targets: Record<string, EffectiveTargetConfig>;
}

export interface CreateEffectiveTargetConfigInput {
  readonly target: string;
  readonly targetConfigVersion: string;
  readonly config: TargetConfig;
  readonly catalog: ProductCatalog;
  readonly adPlacements: AdPlacements;
  readonly platformTarget?: EffectivePlatformTargetMetadata;
}

export interface CreateEffectiveTargetConfigMatrixInput {
  readonly configMatrix: TargetConfigMatrix;
  readonly catalog: ProductCatalog;
  readonly adPlacements: AdPlacements;
  readonly platformTargets?: Record<string, EffectivePlatformTargetMetadata>;
}

export const defaultLeaderboardId = 'default';

export function createEffectiveTargetConfig(
  input: CreateEffectiveTargetConfigInput,
): EffectiveTargetConfig {
  const products = input.catalog.products.map((product) =>
    createEffectiveProductConfig(input.target, input.config, product),
  );
  const placements = input.adPlacements.placements.map((placement) =>
    createEffectiveAdPlacementConfig(input.target, input.config, placement),
  );
  const leaderboardEnabled = input.config.features.leaderboard;
  const integrations = normalizeTargetIntegrationConfig({
    ...input.config.integrations,
    ...input.platformTarget?.integrations,
  });

  return {
    version: effectiveTargetConfigVersion({
      targetConfig: input.targetConfigVersion,
      productCatalog: input.catalog.version,
      adPlacements: input.adPlacements.version,
    }),
    target: input.target,
    runtime: input.config.runtime,
    release: input.config.release,
    features: input.config.features,
    capabilities: input.config.capabilities,
    integrations,
    policy: input.config.policy,
    sources: {
      targetConfig: input.targetConfigVersion,
      productCatalog: input.catalog.version,
      adPlacements: input.adPlacements.version,
      ...(input.platformTarget === undefined
        ? {}
        : {
            platformTargetKind: input.platformTarget.kind,
            platformAdapter: input.platformTarget.adapter,
          }),
    },
    monetization: {
      iap: input.config.monetization.iap,
      products,
    },
    ads: {
      rewardedAds: input.config.monetization.rewardedAds,
      interstitialAds: input.config.monetization.interstitialAds,
      placements,
    },
    leaderboard: {
      native: input.config.leaderboard.native,
      enabled: leaderboardEnabled,
      reason: leaderboardEnabled ? 'available' : 'target-disabled',
      ...(leaderboardEnabled ? { defaultLeaderboardId } : {}),
    },
    storage: {
      support: input.config.capabilities.storage,
      enabled: input.config.capabilities.storage !== 'none',
    },
    localization: {
      enabled: input.config.capabilities.localization,
      fallbackLocale: input.config.localization.fallbackLocale,
    },
  };
}

export function createEffectiveTargetConfigMatrix(
  input: CreateEffectiveTargetConfigMatrixInput,
): EffectiveTargetConfigMatrix {
  const targets = Object.fromEntries(
    Object.entries(input.configMatrix.targets).map(([target, config]) => {
      const platformTarget = input.platformTargets?.[target];

      return [
        target,
        createEffectiveTargetConfig({
          target,
          targetConfigVersion: input.configMatrix.version,
          config,
          catalog: input.catalog,
          adPlacements: input.adPlacements,
          ...(platformTarget === undefined ? {} : { platformTarget }),
        }),
      ];
    }),
  );

  return {
    version: effectiveTargetConfigVersion({
      targetConfig: input.configMatrix.version,
      productCatalog: input.catalog.version,
      adPlacements: input.adPlacements.version,
    }),
    targets,
  };
}

export function getEffectiveProductConfig(
  config: EffectiveTargetConfig,
  productId: ProductCatalogEntry['id'],
): EffectiveProductConfig | undefined {
  return config.monetization.products.find((product) => product.id === productId);
}

export function getEffectiveAdPlacementConfig(
  config: EffectiveTargetConfig,
  placementId: AdPlacementEntry['id'],
): EffectiveAdPlacementConfig | undefined {
  return config.ads.placements.find((placement) => placement.id === placementId);
}

function createEffectiveProductConfig(
  target: string,
  config: TargetConfig,
  product: ProductCatalogEntry,
): EffectiveProductConfig {
  const platformProductId = productPlatformId(product, target);
  const reason = effectiveProductReason(target, config.features.iap, product, platformProductId);

  return {
    id: product.id,
    type: product.type,
    grant: product.grant,
    enabled: reason === 'available',
    reason,
    ...(platformProductId === undefined ? {} : { platformProductId }),
  };
}

function effectiveProductReason(
  target: string,
  targetEnabled: boolean,
  product: ProductCatalogEntry,
  platformProductId: string | undefined,
): EffectiveAvailabilityReason {
  if (!targetEnabled) {
    return 'target-disabled';
  }

  if (target === 'verse8' && product.grant.type === 'resource') {
    return 'capability-unsupported';
  }

  return effectiveItemReason(targetEnabled, platformProductId);
}

function createEffectiveAdPlacementConfig(
  target: string,
  config: TargetConfig,
  placement: AdPlacementEntry,
): EffectiveAdPlacementConfig {
  const featureEnabled = isRewardedPlacement(placement)
    ? config.features.rewardedAds
    : config.features.interstitialAds;
  const platformPlacementId = adPlacementPlatformId(placement, target);
  const reason = effectiveItemReason(featureEnabled, platformPlacementId);

  return {
    id: placement.id,
    type: placement.type,
    frequencyCap: placement.frequencyCap,
    enabled: reason === 'available',
    reason,
    ...(placement.reward === undefined ? {} : { reward: placement.reward }),
    ...(platformPlacementId === undefined ? {} : { platformPlacementId }),
  };
}

function effectiveItemReason(
  targetEnabled: boolean,
  platformId: string | undefined,
): EffectiveAvailabilityReason {
  if (!targetEnabled) {
    return 'target-disabled';
  }

  return platformId === undefined ? 'missing-platform-id' : 'available';
}

function effectiveTargetConfigVersion(input: {
  readonly targetConfig: string;
  readonly productCatalog: string;
  readonly adPlacements: string;
}): string {
  return `${input.targetConfig}+catalog.${input.productCatalog}+ads.${input.adPlacements}`;
}

function productPlatformId(
  product: ProductCatalogEntry,
  target: string,
): string | undefined {
  if (!isProductStoreTarget(target)) {
    return undefined;
  }

  return normalizePlatformId(product.platformProductIds[target]);
}

function adPlacementPlatformId(
  placement: AdPlacementEntry,
  target: string,
): string | undefined {
  if (!isAdStoreTarget(target)) {
    return undefined;
  }

  return normalizePlatformId(placement.platformPlacementIds[target]);
}

function normalizePlatformId(platformId: string | undefined): string | undefined {
  if (platformId === undefined) {
    return undefined;
  }

  const trimmed = platformId.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}

function isProductStoreTarget(
  target: string,
): target is 'android' | 'ios' | 'ait' | 'reddit' | 'verse8' {
  return target === 'android'
    || target === 'ios'
    || target === 'ait'
    || target === 'reddit'
    || target === 'verse8';
}

function isAdStoreTarget(target: string): target is 'android' | 'ios' | 'ait' | 'verse8' {
  return target === 'android' || target === 'ios' || target === 'ait' || target === 'verse8';
}

function isRewardedPlacement(placement: AdPlacementEntry): boolean {
  return placement.type === 'rewarded';
}
