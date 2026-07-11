import type { PlatformCapabilities, PlatformGateway } from '@mpgd/platform';

import type { EffectiveTargetConfig } from './effective.js';

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
  | 'microsoft-store-pwa'
  | 'capacitor-android'
  | 'capacitor-ios'
  | 'apps-in-toss'
  | 'devvit-web';

export type ReleaseProfile =
  | 'web-preview'
  | 'microsoft-store'
  | 'google-play'
  | 'app-store'
  | 'apps-in-toss'
  | 'devvit';

export type StorageSupport = 'local' | 'native' | 'none';

export type TargetIntegration =
  | 'identityUpgrade'
  | 'presentation'
  | 'sharing'
  | 'inboundShare'
  | 'notifications';

export type IntegrationAvailabilityState =
  | 'available'
  | 'disabled'
  | 'approval-required'
  | 'configuration-required'
  | 'unsupported';

export type PresentationMode = 'fullscreen' | 'inline-expanded';

export interface TargetIntegrationConfig {
  readonly identityUpgrade: IntegrationAvailabilityState;
  readonly presentation: IntegrationAvailabilityState;
  readonly sharing: IntegrationAvailabilityState;
  readonly inboundShare: IntegrationAvailabilityState;
  readonly notifications: IntegrationAvailabilityState;
  readonly presentationMode: PresentationMode;
}

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
  readonly integrations?: TargetIntegrationConfig;
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

export interface IntegrationAvailability {
  readonly integration: TargetIntegration;
  readonly state: IntegrationAvailabilityState;
  readonly configuredState: IntegrationAvailabilityState;
  readonly adapterSupported: boolean;
}

export interface TargetRuntimeSnapshot {
  readonly target: PlatformConfigTarget;
  readonly configTarget: string;
  readonly config: TargetConfig;
  readonly effectiveConfig?: EffectiveTargetConfig;
  readonly presentationMode: PresentationMode;
  readonly capabilities: PlatformCapabilities;
  readonly features: Record<PlatformFeature, FeatureAvailability>;
  readonly integrations: Record<TargetIntegration, IntegrationAvailability>;
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

export const targetIntegrations = [
  'identityUpgrade',
  'presentation',
  'sharing',
  'inboundShare',
  'notifications',
] as const satisfies readonly TargetIntegration[];

export const integrationAvailabilityStates = [
  'available',
  'disabled',
  'approval-required',
  'configuration-required',
  'unsupported',
] as const satisfies readonly IntegrationAvailabilityState[];

export const presentationModes = [
  'fullscreen',
  'inline-expanded',
] as const satisfies readonly PresentationMode[];

export const defaultTargetIntegrationConfig = {
  identityUpgrade: 'disabled',
  presentation: 'disabled',
  sharing: 'disabled',
  inboundShare: 'disabled',
  notifications: 'unsupported',
  presentationMode: 'fullscreen',
} as const satisfies TargetIntegrationConfig;

const integrationAvailabilityStateSet = new Set<IntegrationAvailabilityState>(
  integrationAvailabilityStates,
);
const presentationModeSet = new Set<PresentationMode>(presentationModes);

export function normalizeTargetIntegrationConfig(
  config: Partial<TargetIntegrationConfig> | undefined,
): TargetIntegrationConfig {
  if (config === undefined) {
    return defaultTargetIntegrationConfig;
  }

  return {
    identityUpgrade: normalizeIntegrationAvailabilityState(
      config.identityUpgrade,
      defaultTargetIntegrationConfig.identityUpgrade,
    ),
    presentation: normalizeIntegrationAvailabilityState(
      config.presentation,
      defaultTargetIntegrationConfig.presentation,
    ),
    sharing: normalizeIntegrationAvailabilityState(
      config.sharing,
      defaultTargetIntegrationConfig.sharing,
    ),
    inboundShare: normalizeIntegrationAvailabilityState(
      config.inboundShare,
      defaultTargetIntegrationConfig.inboundShare,
    ),
    notifications: normalizeIntegrationAvailabilityState(
      config.notifications,
      defaultTargetIntegrationConfig.notifications,
    ),
    presentationMode: normalizePresentationMode(config.presentationMode),
  };
}

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

export function getIntegrationAvailability(
  integration: TargetIntegration,
  config: TargetConfig,
  gateway?: PlatformGateway,
): IntegrationAvailability {
  const integrations = normalizeTargetIntegrationConfig(config.integrations);
  return createIntegrationAvailability(integration, integrations[integration], gateway);
}

export function createTargetRuntimeSnapshot(input: {
  readonly target: PlatformConfigTarget;
  readonly configTarget?: string;
  readonly config: TargetConfig;
  readonly effectiveConfig?: EffectiveTargetConfig;
  readonly capabilities: PlatformCapabilities;
  readonly adPlacements?: readonly AdPlacementDefinition[];
  readonly gateway?: PlatformGateway;
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
  const integrationConfig = normalizeTargetIntegrationConfig(input.config.integrations);
  const integrationEntries = targetIntegrations.map((integration) => {
    const availability = createIntegrationAvailability(
      integration,
      integrationConfig[integration],
      input.gateway,
    );

    return [integration, availability] as const;
  });
  const integrations = Object.fromEntries(integrationEntries) as Record<
    TargetIntegration,
    IntegrationAvailability
  >;

  return {
    target: input.target,
    configTarget,
    config: input.config,
    ...(input.effectiveConfig === undefined ? {} : { effectiveConfig: input.effectiveConfig }),
    presentationMode: integrationConfig.presentationMode,
    capabilities: input.capabilities,
    features,
    integrations,
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
  const {
    identity: gatewayIdentity,
    presentation: gatewayPresentation,
    sharing: gatewaySharing,
    notifications: gatewayNotifications,
    ...gatewayWithoutIntegrations
  } = gateway;
  const integrations = normalizeTargetIntegrationConfig(config.integrations);
  const isIntegrationAvailable = (integration: TargetIntegration): boolean => (
    createIntegrationAvailability(integration, integrations[integration], gateway).state
      === 'available'
  );
  const identityUpgradeAvailable = isIntegrationAvailable('identityUpgrade');
  const presentationAvailable = isIntegrationAvailable('presentation');
  const sharingAvailable = isIntegrationAvailable('sharing');
  const inboundShareAvailable = isIntegrationAvailable('inboundShare');
  const notificationsAvailable = isIntegrationAvailable('notifications');
  const getIdentitySession = gatewayIdentity.getSession?.bind(gatewayIdentity);
  const requestIdentityUpgrade = gatewayIdentity.requestUpgrade?.bind(gatewayIdentity);
  const shareOutbound = gatewaySharing?.share?.bind(gatewaySharing);
  const readInboundShare = gatewaySharing?.readInboundShare?.bind(gatewaySharing);
  const exposeOutboundShare = sharingAvailable && shareOutbound !== undefined;
  const exposeInboundShare = inboundShareAvailable && readInboundShare !== undefined;
  const identity: PlatformGateway['identity'] = {
    getPlayer: gatewayIdentity.getPlayer.bind(gatewayIdentity),
    ...(getIdentitySession === undefined ? {} : { getSession: getIdentitySession }),
    ...(!identityUpgradeAvailable || requestIdentityUpgrade === undefined
      ? {}
      : { requestUpgrade: requestIdentityUpgrade }),
  };
  const presentation = presentationAvailable ? gatewayPresentation : undefined;
  const sharing: PlatformGateway['sharing'] =
    !exposeOutboundShare && !exposeInboundShare
      ? undefined
      : {
          ...(exposeOutboundShare ? { share: shareOutbound } : {}),
          ...(exposeInboundShare ? { readInboundShare } : {}),
        };
  const notifications = notificationsAvailable ? gatewayNotifications : undefined;
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
    ...gatewayWithoutIntegrations,
    identity,
    ...(presentation === undefined ? {} : { presentation }),
    ...(sharing === undefined ? {} : { sharing }),
    ...(notifications === undefined ? {} : { notifications }),
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
        gateway,
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

function isIntegrationAdapterSupported(
  integration: TargetIntegration,
  gateway: PlatformGateway | undefined,
): boolean {
  if (gateway === undefined) {
    return false;
  }

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

function createIntegrationAvailability(
  integration: TargetIntegration,
  configuredState: IntegrationAvailabilityState,
  gateway: PlatformGateway | undefined,
): IntegrationAvailability {
  const adapterSupported = isIntegrationAdapterSupported(integration, gateway);

  return {
    integration,
    state: adapterSupported ? configuredState : 'unsupported',
    configuredState,
    adapterSupported,
  };
}

function normalizeIntegrationAvailabilityState(
  input: IntegrationAvailabilityState | undefined,
  fallback: IntegrationAvailabilityState,
): IntegrationAvailabilityState {
  if (input !== undefined && integrationAvailabilityStateSet.has(input)) {
    return input;
  }

  return fallback;
}

function normalizePresentationMode(input: PresentationMode | undefined): PresentationMode {
  if (input !== undefined && presentationModeSet.has(input)) {
    return input;
  }

  return defaultTargetIntegrationConfig.presentationMode;
}
