import type { MpgdLocale } from '@mpgd/i18n';
import type {
  PlatformCapabilities,
  PlatformGateway,
  PlatformProviderAvailability,
} from '@mpgd/platform';

import type { EffectiveTargetConfig } from './effective.js';

export type PlatformFeature =
  | 'iap'
  | 'subscriptions'
  | 'bannerAds'
  | 'rewardedAds'
  | 'interstitialAds'
  | 'leaderboard'
  | 'nativeLeaderboard'
  | 'remoteLeaderboard'
  | 'localization';

export type AdPlacementType = 'rewarded' | 'interstitial' | 'banner';
const adPlacementFeatureByType = {
  rewarded: 'rewardedAds',
  interstitial: 'interstitialAds',
  banner: 'bannerAds',
} as const satisfies Record<AdPlacementType, PlatformFeature>;
type PlatformConfigTarget = PlatformGateway['target'];

export type TargetRuntimeKind =
  | 'web'
  | 'web-preview'
  | 'microsoft-store-pwa'
  | 'capacitor-android'
  | 'capacitor-ios'
  | 'apps-in-toss'
  | 'devvit-web'
  | 'verse8-web'
  | 'wechat-minigame'
  | 'tiktok-minigame';

export type ReleaseProfile =
  | 'web'
  | 'web-preview'
  | 'microsoft-store'
  | 'google-play'
  | 'app-store'
  | 'apps-in-toss'
  | 'devvit'
  | 'verse8'
  | 'wechat-minigame'
  | 'tiktok-minigame';

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
  | 'action-required'
  | 'configuration-required'
  | 'temporarily-unavailable'
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
  /** Optional for matrices authored before subscriptions were distinct. */
  readonly subscriptions?: boolean;
  /** Optional for target matrices authored before inline banner support. */
  readonly bannerAds?: boolean;
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
  readonly leaderboard: boolean;
  /** Optional narrower policies; absent values inherit leaderboard. */
  readonly nativeLeaderboard?: boolean;
  readonly remoteLeaderboard?: boolean;
  readonly localization: boolean;
}

export interface TargetCapabilityConfig {
  readonly storage: StorageSupport;
  readonly localization: boolean;
}

export interface TargetLocalizationConfig {
  readonly fallbackLocale: MpgdLocale;
}

export interface TargetMonetizationConfig {
  readonly iap: boolean;
  /** Optional for target matrices authored before inline banner support. */
  readonly bannerAds?: boolean;
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
  readonly localization: TargetLocalizationConfig;
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
  | 'capability-unsupported'
  | 'configuration-required'
  | 'action-required'
  | 'temporarily-unavailable';

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
  'subscriptions',
  'bannerAds',
  'rewardedAds',
  'interstitialAds',
  'leaderboard',
  'nativeLeaderboard',
  'remoteLeaderboard',
  'localization',
] as const satisfies readonly PlatformFeature[];

export function adPlacementFeatureFor(type: AdPlacementType): PlatformFeature {
  return adPlacementFeatureByType[type];
}

export const targetIntegrations = [
  'identityUpgrade',
  'presentation',
  'sharing',
  'inboundShare',
  'notifications',
] as const satisfies readonly TargetIntegration[];

type IntegrationUpperBound = 'available' | 'disabled' | 'unsupported';
const integrationUpperBoundsByRuntime = {
  'tiktok-minigame': {
    identityUpgrade: 'unsupported',
    presentation: 'available',
    sharing: 'available',
    inboundShare: 'unsupported',
    notifications: 'unsupported',
  },
  'verse8-web': {
    identityUpgrade: 'unsupported',
    presentation: 'available',
    sharing: 'unsupported',
    inboundShare: 'unsupported',
    notifications: 'unsupported',
  },
  'web-preview': {
    identityUpgrade: 'disabled',
    presentation: 'available',
    sharing: 'available',
    inboundShare: 'available',
    notifications: 'unsupported',
  },
  'wechat-minigame': {
    identityUpgrade: 'unsupported',
    presentation: 'available',
    sharing: 'available',
    inboundShare: 'unsupported',
    notifications: 'unsupported',
  },
} as const satisfies Record<
  'tiktok-minigame' | 'verse8-web' | 'web-preview' | 'wechat-minigame',
  Record<TargetIntegration, IntegrationUpperBound>
>;

type CompleteValueList<Union, Values extends readonly Union[]> =
  Exclude<Union, Values[number]> extends never ? Values : never;

const integrationAvailabilityStateValues = [
  'available',
  'disabled',
  'approval-required',
  'action-required',
  'configuration-required',
  'temporarily-unavailable',
  'unsupported',
] as const satisfies readonly IntegrationAvailabilityState[];
export const integrationAvailabilityStates: CompleteValueList<
  IntegrationAvailabilityState,
  typeof integrationAvailabilityStateValues
> = integrationAvailabilityStateValues;

const presentationModeValues = [
  'fullscreen',
  'inline-expanded',
] as const satisfies readonly PresentationMode[];
export const presentationModes: CompleteValueList<
  PresentationMode,
  typeof presentationModeValues
> = presentationModeValues;

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

export function assertTargetIntegrationRuntimeBounds(
  runtime: TargetRuntimeKind,
  config: Partial<TargetIntegrationConfig> | undefined,
  label: string,
): TargetIntegrationConfig {
  const integrations = normalizeTargetIntegrationConfig(config);

  if (
    runtime !== 'tiktok-minigame'
    && runtime !== 'verse8-web'
    && runtime !== 'web-preview'
    && runtime !== 'wechat-minigame'
  ) {
    return integrations;
  }

  const upperBounds = integrationUpperBoundsByRuntime[runtime];

  for (const integration of targetIntegrations) {
    const state = integrations[integration];
    const upperBound = upperBounds[integration];

    if (!isIntegrationStateWithinUpperBound(state, upperBound)) {
      throw new Error(
        `${label} cannot configure ${integration} as ${state} for ${runtime} runtime; maximum supported state is ${upperBound}.`,
      );
    }
  }

  return integrations;
}

export function isMiniGameRuntime(
  runtime: TargetRuntimeKind,
): runtime is 'wechat-minigame' | 'tiktok-minigame' {
  return runtime === 'wechat-minigame' || runtime === 'tiktok-minigame';
}

function isIntegrationStateWithinUpperBound(
  state: IntegrationAvailabilityState,
  upperBound: IntegrationUpperBound,
): boolean {
  switch (upperBound) {
    case 'available':
      return true;
    case 'disabled':
      return state === 'disabled' || state === 'unsupported';
    case 'unsupported':
      return state === 'unsupported';
  }
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
  switch (feature) {
    case 'subscriptions':
      return config.features.iap && config.features.subscriptions === true;
    case 'nativeLeaderboard':
      return config.features.leaderboard
        && (config.features.nativeLeaderboard ?? config.leaderboard.native);
    case 'remoteLeaderboard':
      return config.features.leaderboard
        && (config.features.remoteLeaderboard ?? true);
    default:
      return config.features[feature] === true;
  }
}

export function applyTargetConfigToCapabilities(
  capabilities: PlatformCapabilities,
  config: TargetConfig,
): PlatformCapabilities {
  const bannerAds = capabilities.bannerAds === true && config.features.bannerAds === true;
  const rewardedAds = capabilities.rewardedAds && config.features.rewardedAds;
  const interstitialAds = capabilities.interstitialAds && config.features.interstitialAds;

  return {
    ...capabilities,
    nativeIap: capabilities.nativeIap && config.features.iap,
    ...(capabilities.subscriptionIap === undefined
      ? {}
      : { subscriptionIap: capabilities.subscriptionIap && isPlatformFeatureEnabled(config, 'subscriptions') }),
    nativeAds:
      capabilities.nativeAds &&
      (bannerAds || rewardedAds || interstitialAds),
    bannerAds,
    rewardedAds,
    interstitialAds,
    nativeLeaderboard: capabilities.nativeLeaderboard && isPlatformFeatureEnabled(config, 'nativeLeaderboard'),
    remoteLeaderboard: capabilities.remoteLeaderboard && isPlatformFeatureEnabled(config, 'remoteLeaderboard'),
    localizedContent: capabilities.localizedContent && config.features.localization,
  };
}

export function getFeatureAvailability(
  feature: PlatformFeature,
  config: TargetConfig,
  capabilities: PlatformCapabilities,
): FeatureAvailability {
  const targetEnabled = isPlatformFeatureEnabled(config, feature);
  const capabilitySupported = isFeatureCapabilitySupported(feature, capabilities, config);
  const providerState = getFeatureProviderAvailability(feature, capabilities, config);
  const enabled = targetEnabled && capabilitySupported && (
    providerState === undefined || providerState === 'available'
  );

  return {
    feature,
    enabled,
    targetEnabled,
    capabilitySupported,
    reason: !targetEnabled
      ? 'target-disabled'
      : enabled
        ? 'available'
        : providerState === 'configuration-required'
          || providerState === 'action-required'
          || providerState === 'temporarily-unavailable'
          ? providerState
          : 'capability-unsupported',
  };
}

export function getIntegrationAvailability(
  integration: TargetIntegration,
  config: TargetConfig,
  gateway?: PlatformGateway,
  capabilities?: PlatformCapabilities,
): IntegrationAvailability {
  const integrations = normalizeTargetIntegrationConfig(config.integrations);
  return createIntegrationAvailability(
    integration,
    integrations[integration],
    gateway,
    capabilities,
  );
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
  const availabilityConfig = resolveAvailabilityConfig(input.config, input.effectiveConfig);
  const features = {
    iap: getFeatureAvailability('iap', availabilityConfig, input.capabilities),
    subscriptions: getFeatureAvailability('subscriptions', availabilityConfig, input.capabilities),
    bannerAds: getFeatureAvailability('bannerAds', availabilityConfig, input.capabilities),
    rewardedAds: getFeatureAvailability('rewardedAds', availabilityConfig, input.capabilities),
    interstitialAds: getFeatureAvailability(
      'interstitialAds',
      availabilityConfig,
      input.capabilities,
    ),
    leaderboard: getFeatureAvailability('leaderboard', availabilityConfig, input.capabilities),
    nativeLeaderboard: getFeatureAvailability(
      'nativeLeaderboard',
      availabilityConfig,
      input.capabilities,
    ),
    remoteLeaderboard: getFeatureAvailability(
      'remoteLeaderboard',
      availabilityConfig,
      input.capabilities,
    ),
    localization: getFeatureAvailability('localization', availabilityConfig, input.capabilities),
  } satisfies Record<PlatformFeature, FeatureAvailability>;
  const integrationConfig = normalizeTargetIntegrationConfig(
    input.effectiveConfig?.integrations ?? input.config.integrations,
  );
  const integrationEntries = targetIntegrations.map((integration) => {
    const availability = createIntegrationAvailability(
      integration,
      integrationConfig[integration],
      input.gateway,
      input.capabilities,
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
      const feature = adPlacementFeatureFor(placement.type);
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
  const availabilityConfig = resolveAvailabilityConfig(config, options.effectiveConfig);
  const getGatewayCapabilities = (): Promise<PlatformCapabilities> => (
    gateway.getCapabilities()
  );
  const configTarget = options.configTarget ?? targetConfigKeyForPlatform(gateway.target);
  const {
    identity: gatewayIdentity,
    presentation: gatewayPresentation,
    sharing: gatewaySharing,
    notifications: gatewayNotifications,
    ...gatewayWithoutIntegrations
  } = gateway;
  const integrations = normalizeTargetIntegrationConfig(
    options.effectiveConfig?.integrations ?? config.integrations,
  );
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
  const getIapAvailability = async () => {
    const oneTimeEnabled = availabilityConfig.features.iap;
    const subscriptionsEnabled = isPlatformFeatureEnabled(availabilityConfig, 'subscriptions');
    if (!oneTimeEnabled && !subscriptionsEnabled) {
      return { oneTime: false, subscriptions: false };
    }
    const capabilities = await getGatewayCapabilities();
    return {
      oneTime: oneTimeEnabled && capabilities.nativeIap,
      subscriptions: subscriptionsEnabled && capabilities.subscriptionIap === true,
    };
  };
  const isLeaderboardAvailable = async (): Promise<boolean> => {
    if (!availabilityConfig.features.leaderboard) {
      return false;
    }

    const capabilities = await getGatewayCapabilities();
    return (
      capabilities.nativeLeaderboard && isPlatformFeatureEnabled(availabilityConfig, 'nativeLeaderboard')
    ) || (
      capabilities.remoteLeaderboard && isPlatformFeatureEnabled(availabilityConfig, 'remoteLeaderboard')
    );
  };
  const isAdPlacementAllowed = (
    placementId: string,
    expectedType: AdPlacementType,
  ): boolean => {
    const actualType = options.resolveAdPlacementType?.(placementId);

    if (actualType !== undefined && actualType !== expectedType) {
      return false;
    }

    return availabilityConfig.features[adPlacementFeatureFor(expectedType)] === true;
  };

  const canPreloadAdPlacement = (placementId: string): boolean => {
    const actualType = options.resolveAdPlacementType?.(placementId);

    if (actualType !== undefined) {
      return availabilityConfig.features[adPlacementFeatureFor(actualType)] === true;
    }

    return (
      availabilityConfig.features.rewardedAds ||
      availabilityConfig.features.interstitialAds ||
      availabilityConfig.features.bannerAds === true
    );
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
        capabilities: applyTargetConfigToCapabilities(
          await getGatewayCapabilities(),
          availabilityConfig,
        ),
        adPlacements: options.adPlacements ?? [],
        gateway,
      });
    },
    async getCapabilities() {
      return applyTargetConfigToCapabilities(
        await getGatewayCapabilities(),
        availabilityConfig,
      );
    },
    commerce: {
      async getProducts() {
        const available = await getIapAvailability();
        if (!available.oneTime && !available.subscriptions) {
          return [];
        }
        return (await gateway.commerce.getProducts()).filter((product) =>
          product.type === 'subscription' ? available.subscriptions : available.oneTime,
        );
      },
      async purchase(input) {
        const available = await getIapAvailability();
        const configuredProduct = options.effectiveConfig?.monetization.products.find(
          (product) => product.id === input.productId,
        );
        let productType = configuredProduct?.type;
        if (
          productType === undefined
          && options.effectiveConfig === undefined
          && available.oneTime !== available.subscriptions
        ) {
          productType = (await gateway.commerce.getProducts()).find(
            (product) => product.id === input.productId,
          )?.type;
        }
        // When only one purchase route is available, unknown product types
        // must not fall through to that route. An effective catalog is binding.
        const allowed = productType === 'subscription'
          ? available.subscriptions
          : productType === undefined
            ? available.oneTime && available.subscriptions
            : available.oneTime;
        if (!allowed || (options.effectiveConfig !== undefined && configuredProduct?.enabled !== true)) {
          return {
            status: 'cancelled',
            entitlementIds: [],
          };
        }

        return gateway.commerce.purchase(input);
      },
      async restore() {
        const available = await getIapAvailability();
        if ((!available.oneTime && !available.subscriptions) || gateway.commerce.restore === undefined) {
          return {
            restoredEntitlements: [],
          };
        }

        return gateway.commerce.restore();
      },
      async getEntitlements() {
        const available = await getIapAvailability();
        return available.oneTime || available.subscriptions
          ? gateway.commerce.getEntitlements()
          : [];
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
      async mountBanner(input) {
        if (
          !isAdPlacementAllowed(input.placementId, 'banner')
          || gateway.ads.mountBanner === undefined
        ) {
          return { status: 'unavailable' };
        }

        return gateway.ads.mountBanner(input);
      },
      async unmountBanner(input) {
        if (gateway.ads.unmountBanner !== undefined) {
          await gateway.ads.unmountBanner(input);
        }
      },
    },
    leaderboard: {
      async submitScore(input) {
        if (!await isLeaderboardAvailable()) {
          return {
            submitted: false,
          };
        }

        return gateway.leaderboard.submitScore(input);
      },
      async open(input) {
        if (await isLeaderboardAvailable()) {
          await gateway.leaderboard.open(input);
        }
      },
    },
  };
}

function resolveAvailabilityConfig(
  config: TargetConfig,
  effectiveConfig: EffectiveTargetConfig | undefined,
): TargetConfig {
  return effectiveConfig === undefined
    ? config
    : {
        ...config,
        features: effectiveConfig.features,
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
  config: TargetConfig,
): boolean {
  switch (feature) {
    case 'iap':
      return capabilities.nativeIap;
    case 'subscriptions':
      return capabilities.subscriptionIap === true;
    case 'bannerAds':
      return capabilities.bannerAds === true;
    case 'rewardedAds':
      return capabilities.rewardedAds;
    case 'interstitialAds':
      return capabilities.interstitialAds;
    case 'leaderboard':
      return (
        capabilities.nativeLeaderboard && isPlatformFeatureEnabled(config, 'nativeLeaderboard')
      ) || (
        capabilities.remoteLeaderboard && isPlatformFeatureEnabled(config, 'remoteLeaderboard')
      );
    case 'nativeLeaderboard':
      return capabilities.nativeLeaderboard;
    case 'remoteLeaderboard':
      return capabilities.remoteLeaderboard;
    case 'localization':
      return capabilities.localizedContent;
  }
}

function getFeatureProviderAvailability(
  feature: PlatformFeature,
  capabilities: PlatformCapabilities,
  config: TargetConfig,
): PlatformProviderAvailability | undefined {
  const states = capabilities.providerAvailability;
  if (states === undefined) {
    return undefined;
  }

  switch (feature) {
    case 'iap':
      return states.nativeIap;
    case 'subscriptions':
      return states.subscriptionIap;
    case 'rewardedAds':
      return states.rewardedAds;
    case 'interstitialAds':
      return states.interstitialAds;
    case 'bannerAds':
      return states.bannerAds;
    case 'nativeLeaderboard':
      return states.nativeLeaderboard;
    case 'leaderboard':
      // A game-owned remote leaderboard remains usable without a native provider.
      return capabilities.remoteLeaderboard && isPlatformFeatureEnabled(config, 'remoteLeaderboard')
        ? 'available'
        : isPlatformFeatureEnabled(config, 'nativeLeaderboard')
          ? states.nativeLeaderboard
          : undefined;
    case 'remoteLeaderboard':
    case 'localization':
      return undefined;
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
  capabilities?: PlatformCapabilities,
): IntegrationAvailability {
  const adapterSupported = isIntegrationAdapterSupported(integration, gateway);
  const providerState = integration === 'identityUpgrade'
    ? capabilities?.providerAvailability?.identityUpgrade
    : integration === 'notifications'
      ? capabilities?.providerAvailability?.pushNotifications
      : undefined;
  const state = configuredState === 'disabled' || configuredState === 'unsupported'
    ? configuredState
    : !adapterSupported || providerState === 'unsupported'
      ? 'unsupported'
      : providerState !== undefined && providerState !== 'available'
        ? providerState
        : configuredState;

  return {
    integration,
    state,
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
