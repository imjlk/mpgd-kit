import typia from 'typia';

import type { MpgdLocale } from '@mpgd/i18n';
import type {
  CommerceCapabilities,
  PlatformCapabilities,
  PlatformGateway,
  PlatformProviderAvailability,
} from '@mpgd/platform';
import type { CommerceBillingAuthority } from '@mpgd/platform/commerce-wallet';

import type { EffectiveTargetConfig } from './effective.js';

/** The notifications v2 capability block (`@mpgd/platform/notifications`). */
type NotificationCapabilities = NonNullable<PlatformCapabilities['notifications']>;
type NotificationProvider = NonNullable<PlatformGateway['notificationsV2']>;

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
  | 'crazygames-web'
  | 'oneplay-web'
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
  | 'crazygames'
  | 'oneplay'
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
  /**
   * Commerce v2 billing authority override (RFC "Billing authority and
   * memberships"). Absent, `resolveCommerceBillingAuthority(profile)` applies:
   * `web` and `web-preview` are `host`, every other profile `store`.
   * `google-play` and `app-store` are always `store`; `validate:target-config`
   * rejects `host` for them.
   */
  readonly billingAuthority?: CommerceBillingAuthority;
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
  'crazygames-web': {
    identityUpgrade: 'unsupported',
    presentation: 'available',
    sharing: 'unsupported',
    inboundShare: 'unsupported',
    notifications: 'unsupported',
  },
  'oneplay-web': {
    identityUpgrade: 'unsupported',
    presentation: 'available',
    sharing: 'unsupported',
    inboundShare: 'unsupported',
    notifications: 'unsupported',
  },
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
  'tiktok-minigame' | 'verse8-web' | 'web-preview' | 'wechat-minigame' | 'crazygames-web' | 'oneplay-web',
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
    && runtime !== 'crazygames-web'
    && runtime !== 'oneplay-web'
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
    commerce: applyTargetConfigToCommerceCapabilities(requireCommerce(capabilities), config),
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

/**
 * The commerce block as the target configuration allows it: one-time products
 * need `features.iap`, subscriptions need `features.subscriptions`, and a
 * target that allows neither reports the store as `unsupported`. The block is
 * the only source: there are no boolean `nativeIap` or `subscriptionIap` flags
 * to keep in step. A fresh object on every call.
 */
export function applyTargetConfigToCommerceCapabilities(
  commerce: CommerceCapabilities,
  config: TargetConfig,
): CommerceCapabilities {
  const oneTime = config.features.iap;
  const subscriptions = isPlatformFeatureEnabled(config, 'subscriptions');
  const declaresOneTime = commerce.purchase.consumable || commerce.purchase.durable;
  const declaresKind = declaresOneTime || commerce.purchase.subscription;
  // Sellable is what the configuration allows of what the provider declares.
  // A block that declares no kind at all (the unsupported or degraded block)
  // keeps its own availability, so a stalled provider still reads as
  // temporarily unavailable rather than unsupported.
  const sellable = declaresKind
    ? (oneTime && declaresOneTime) || (subscriptions && commerce.purchase.subscription)
    : oneTime || subscriptions;
  return {
    purchase: {
      consumable: commerce.purchase.consumable && oneTime,
      durable: commerce.purchase.durable && oneTime,
      subscription: commerce.purchase.subscription && subscriptions,
      quantity: commerce.purchase.quantity && oneTime,
    },
    catalog: {
      products: commerce.catalog.products && sellable,
      offers: commerce.catalog.offers && sellable,
      localizedPrice: commerce.catalog.localizedPrice && sellable,
    },
    lifecycle: { ...commerce.lifecycle },
    authority: { ...commerce.authority },
    availability: sellable ? commerce.availability : 'unsupported',
  };
}

/**
 * The required commerce block of a capability snapshot. A gateway that sells
 * nothing reports `createUnsupportedCommerceCapabilities()`; a snapshot
 * without the block is a gateway built before the block was required, and
 * it fails here with that reason rather than as a bare property error.
 */
function requireCommerce(capabilities: PlatformCapabilities): CommerceCapabilities {
  const commerce = (capabilities as { readonly commerce?: CommerceCapabilities }).commerce;
  if (commerce === undefined) {
    throw new TypeError(
      'PlatformCapabilities.commerce is required: report createUnsupportedCommerceCapabilities() '
        + 'for a gateway that sells nothing.',
    );
  }
  return commerce;
}

/**
 * The error a masked provider answers when it refuses a purchase before it
 * reaches the store. A purchase the target configuration or the catalog does
 * not sell is `ITEM_UNAVAILABLE`. A purchase the configuration allows but the
 * provider cannot take yet answers the provider's own class of error, as the
 * provider itself would: `CONFIGURATION_REQUIRED`, `ACTION_REQUIRED`, or the
 * retryable `STORE_UNAVAILABLE`, so the reconciler does not journal a
 * temporary outage as a terminal, non-retryable failure.
 */
function purchaseRefusal(readiness: PlatformProviderAvailability | undefined): {
  readonly code: 'ITEM_UNAVAILABLE' | 'CONFIGURATION_REQUIRED' | 'ACTION_REQUIRED' | 'STORE_UNAVAILABLE';
  readonly retryable: boolean;
} {
  switch (readiness) {
    case 'configuration-required':
      return { code: 'CONFIGURATION_REQUIRED', retryable: false };
    case 'action-required':
      return { code: 'ACTION_REQUIRED', retryable: false };
    case 'temporarily-unavailable':
      return { code: 'STORE_UNAVAILABLE', retryable: true };
    default:
      return { code: 'ITEM_UNAVAILABLE', retryable: false };
  }
}

/** One-time products are sold when the provider is available and declares a one-time kind. */
function commerceSellsOneTime(commerce: CommerceCapabilities): boolean {
  return commerce.availability === 'available'
    && (commerce.purchase.consumable || commerce.purchase.durable);
}

/**
 * Subscriptions are sold under the same readiness rule as one-time products:
 * the provider is available and declares the kind. A provider that is not
 * ready yet gets the retryable or configuration refusal from the mask instead
 * of a purchase that reaches the store.
 */
function commerceSellsSubscriptions(commerce: CommerceCapabilities): boolean {
  return commerce.availability === 'available' && commerce.purchase.subscription;
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
    notificationsV2: gatewayNotificationsV2,
    ...gatewayWithoutIntegrations
  } = gateway;
  const integrations = normalizeTargetIntegrationConfig(
    options.effectiveConfig?.integrations ?? config.integrations,
  );
  const isIntegrationCallable = (integration: TargetIntegration): boolean => {
    const state = createIntegrationAvailability(
      integration,
      integrations[integration],
      gateway,
    ).state;
    return state === 'available' || (
      state === 'action-required'
      && (integration === 'identityUpgrade' || integration === 'notifications')
    );
  };
  const identityUpgradeAvailable = isIntegrationCallable('identityUpgrade');
  const presentationAvailable = isIntegrationCallable('presentation');
  const sharingAvailable = isIntegrationCallable('sharing');
  const inboundShareAvailable = isIntegrationCallable('inboundShare');
  const notificationsAvailable = isIntegrationCallable('notifications');
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
  const notifications = notificationsAvailable && hasNotificationSubscriptionAdapter(gateway)
    ? gatewayNotifications
    : undefined;
  // Notifications v2 passes the same gate as the v1 adapter: a release gate
  // such as Devvit's `approval-required` stays in `integrations.notifications`
  // (notifications RFC "Capabilities").
  const notificationsV2 = notificationsAvailable && hasNotificationProvider(gateway)
    ? gatewayNotificationsV2
    : undefined;
  const readNotificationBlock = notificationsV2 === undefined
    ? undefined
    : createNotificationCapabilityReader(notificationsV2);
  // The capability snapshot describes what the game can reach: the v2 block
  // comes from the exposed provider and is left out while it is hidden.
  const readCapabilities = async (): Promise<PlatformCapabilities> => {
    const [capabilities, notificationCapabilities] = await Promise.all([
      getGatewayCapabilities(),
      readNotificationBlock?.(),
    ]);
    return withNotificationCapabilities(
      applyTargetConfigToCapabilities(capabilities, availabilityConfig),
      notificationCapabilities,
    );
  };
  const getIapAvailability = async () => {
    const oneTimeEnabled = availabilityConfig.features.iap;
    const subscriptionsEnabled = isPlatformFeatureEnabled(availabilityConfig, 'subscriptions');
    if (!oneTimeEnabled && !subscriptionsEnabled) {
      return {
        oneTime: false,
        subscriptions: false,
        oneTimeEnabled,
        subscriptionsEnabled,
        readiness: undefined,
      };
    }
    const commerce = requireCommerce(await getGatewayCapabilities());
    return {
      oneTime: oneTimeEnabled && commerceSellsOneTime(commerce),
      subscriptions: subscriptionsEnabled && commerceSellsSubscriptions(commerce),
      // What the target configuration allows, apart from what the provider can
      // sell right now: a refusal names the provider's readiness only when the
      // configuration would have allowed the purchase.
      oneTimeEnabled,
      subscriptionsEnabled,
      readiness: commerce.availability,
    };
  };
  const getLeaderboardRoute = async (): Promise<'native' | 'remote' | null> => {
    if (!availabilityConfig.features.leaderboard) {
      return null;
    }

    const capabilities = await getGatewayCapabilities();
    if (capabilities.nativeLeaderboard
      && isPlatformFeatureEnabled(availabilityConfig, 'nativeLeaderboard')) {
      return 'native';
    }
    if (capabilities.remoteLeaderboard
      && isPlatformFeatureEnabled(availabilityConfig, 'remoteLeaderboard')) {
      return 'remote';
    }
    return null;
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

  const canPreloadAdPlacement = (
    placementId: string,
    requestedFormat?: AdPlacementType,
  ): boolean => {
    const resolvedType = options.resolveAdPlacementType?.(placementId);
    if (resolvedType !== undefined && requestedFormat !== undefined
      && resolvedType !== requestedFormat) {
      return false;
    }
    const actualType = resolvedType ?? requestedFormat;

    if (actualType !== undefined) {
      return actualType !== 'banner'
        && availabilityConfig.features[adPlacementFeatureFor(actualType)] === true;
    }

    return (
      availabilityConfig.features.rewardedAds ||
      availabilityConfig.features.interstitialAds
    );
  };

  const commerceSource = gateway.commerce;
  // Recovery reads (`getAvailablePurchases`, `finishTransaction`, `subscribe`)
  // always pass through: an already paid purchase must stay recoverable and
  // finishable even when the target stops selling. Catalog reads, new
  // purchases, and a store resync obey the target configuration.
  const commerce: PlatformGateway['commerce'] = commerceSource === undefined
    ? undefined
    : {
        store: commerceSource.store,
        ...(commerceSource.presentation === undefined
          ? {}
          : { presentation: commerceSource.presentation }),
        async getCapabilities() {
          return applyTargetConfigToCommerceCapabilities(
            await commerceSource.getCapabilities(),
            availabilityConfig,
          );
        },
        async fetchProducts(input) {
          const available = await getIapAvailability();
          if (!available.oneTime && !available.subscriptions) {
            return [];
          }
          return (await commerceSource.fetchProducts(input)).filter((product) =>
            product.kind === 'subscription' ? available.subscriptions : available.oneTime,
          );
        },
        async requestPurchase(input) {
          const available = await getIapAvailability();
          const configuredProduct = options.effectiveConfig?.monetization.products.find(
            (product) => product.id === input.logicalId,
          );
          let isSubscription: boolean | undefined = configuredProduct === undefined
            ? undefined
            : configuredProduct.type === 'subscription';
          if (
            isSubscription === undefined
            && options.effectiveConfig === undefined
            && available.oneTime !== available.subscriptions
          ) {
            const kind = (await commerceSource.fetchProducts({
              logicalIds: [input.logicalId],
              type: 'all',
            })).find((product) => product.logicalId === input.logicalId)?.kind;
            isSubscription = kind === undefined ? undefined : kind === 'subscription';
          }
          // When only one purchase route is available, unknown product kinds
          // must not fall through to that route. An effective catalog is binding.
          const allowed = isSubscription === true
            ? available.subscriptions
            : isSubscription === undefined
              ? available.oneTime && available.subscriptions
              : available.oneTime;
          const catalogRefused =
            options.effectiveConfig !== undefined && configuredProduct?.enabled !== true;
          if (!allowed || catalogRefused) {
            const routeEnabled = isSubscription === true
              ? available.subscriptionsEnabled
              : isSubscription === undefined
                ? available.oneTimeEnabled && available.subscriptionsEnabled
                : available.oneTimeEnabled;
            return {
              outcome: 'failed',
              error: purchaseRefusal(routeEnabled && !catalogRefused ? available.readiness : undefined),
            };
          }

          return commerceSource.requestPurchase(input);
        },
        getAvailablePurchases: (input) => commerceSource.getAvailablePurchases(input),
        ...(commerceSource.finishTransaction === undefined
          ? {}
          : { finishTransaction: (input) => commerceSource.finishTransaction!(input) }),
        ...(commerceSource.restorePurchases === undefined
          ? {}
          : {
              async restorePurchases() {
                const available = await getIapAvailability();
                if (available.oneTime || available.subscriptions) {
                  await commerceSource.restorePurchases!();
                }
              },
            }),
        ...(commerceSource.getActiveSubscriptions === undefined
          ? {}
          : {
              async getActiveSubscriptions() {
                return (await getIapAvailability()).subscriptions
                  ? commerceSource.getActiveSubscriptions!()
                  : [];
              },
            }),
        subscribe: (listener) => commerceSource.subscribe(listener),
      };

  return {
    ...gatewayWithoutIntegrations,
    identity,
    ...(presentation === undefined ? {} : { presentation }),
    ...(sharing === undefined ? {} : { sharing }),
    ...(notifications === undefined ? {} : { notifications }),
    ...(notificationsV2 === undefined ? {} : { notificationsV2 }),
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
        capabilities: await readCapabilities(),
        adPlacements: options.adPlacements ?? [],
        gateway,
      });
    },
    getCapabilities: readCapabilities,
    ...(commerce === undefined ? {} : { commerce }),
    ads: {
      async preload(input) {
        if (canPreloadAdPlacement(input.placementId, input.format)) {
          const format = options.resolveAdPlacementType?.(input.placementId) ?? input.format;
          await gateway.ads.preload(format === undefined ? input : { ...input, format });
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
        const route = await getLeaderboardRoute();
        if (route === null) {
          return {
            submitted: false,
          };
        }

        return gateway.leaderboard.submitScore(
          gateway.target === 'android' || gateway.target === 'ios'
            ? { ...input, route }
            : input,
        );
      },
      async open(input) {
        const route = await getLeaderboardRoute();
        if (route !== null) {
          await gateway.leaderboard.open(
            gateway.target === 'android' || gateway.target === 'ios'
              ? { ...input, route }
              : input,
          );
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
    // Whether the provider sells the kind at all; its readiness is the
    // provider state (`commerce.availability`), so a store that is not ready
    // yet reads as that state rather than as unsupported.
    case 'iap': {
      const { purchase } = requireCommerce(capabilities);
      return purchase.consumable || purchase.durable;
    }
    case 'subscriptions':
      return requireCommerce(capabilities).purchase.subscription;
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
  const commerce = requireCommerce(capabilities);
  // The commerce block carries its own readiness. A feature the provider does
  // not sell reads as `unsupported`, as a state the provider never reported
  // would, so the reason stays `capability-unsupported`.
  switch (feature) {
    case 'iap':
      return commerce.purchase.consumable || commerce.purchase.durable
        ? commerce.availability
        : 'unsupported';
    case 'subscriptions':
      return commerce.purchase.subscription ? commerce.availability : 'unsupported';
    default:
      break;
  }

  const states = capabilities.providerAvailability;
  if (states === undefined) {
    return undefined;
  }

  switch (feature) {
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
      return hasNotificationSubscriptionAdapter(gateway) || hasNotificationProvider(gateway);
  }
}

function hasNotificationSubscriptionAdapter(gateway: PlatformGateway): boolean {
  return (
    typeof gateway.notifications?.getStatus === 'function'
    && typeof gateway.notifications?.requestSubscription === 'function'
  );
}

/** A notifications v2 provider counts only when its required methods are functions, as v1 does. */
function hasNotificationProvider(gateway: PlatformGateway): boolean {
  const provider = gateway.notificationsV2;
  return (
    typeof provider?.getCapabilities === 'function'
    && typeof provider.getPermission === 'function'
    && typeof provider.requestPermission === 'function'
    && typeof provider.subscribe === 'function'
  );
}

/** Bound on one notifications v2 capability read, as the Capacitor registry bounds commerce. */
const notificationCapabilityReadTimeoutMs = 3_000;
// A local check of the same shape as `isNotificationCapabilities` from
// `@mpgd/platform/notifications`: importing that module would put every
// notifications validator and the delivery policy into each game bundle.
const isNotificationCapabilitiesShape = typia.createEquals<NotificationCapabilities>();

/**
 * Reads the provider's block for every snapshot. Reads that overlap share one
 * provider read while it is in flight; nothing is kept once it settles, so
 * the next read asks the provider again. Each caller gets its own copy. A
 * read that starts while another is in flight gets that read's answer, which
 * can predate a change the caller just made (for example a login), so a game
 * that re-reads after a change awaits any read it started before.
 */
function createNotificationCapabilityReader(
  provider: NotificationProvider,
): () => Promise<NotificationCapabilities> {
  let inFlight: Promise<NotificationCapabilities> | undefined;
  return async () => {
    let read = inFlight;
    if (read === undefined) {
      const started = readNotificationCapabilities(provider);
      inFlight = started;
      // Never rejects: a failed read is a degraded block.
      void started.finally(() => {
        if (inFlight === started) {
          inFlight = undefined;
        }
      });
      read = started;
    }
    return copyNotificationCapabilities(await read);
  };
}

/**
 * One bounded read of the exposed provider's capabilities, copied into a
 * fresh block with exactly the declared keys. A provider that stalls, throws,
 * or answers a block the contract rejects yields a degraded block instead of
 * a stalled or rejected capability read.
 */
async function readNotificationCapabilities(
  provider: NotificationProvider,
): Promise<NotificationCapabilities> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reported: unknown = await Promise.race([
      Promise.resolve().then(() => provider.getCapabilities()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Notification capabilities read timed out.')),
          notificationCapabilityReadTimeoutMs,
        );
      }),
    ]);
    if (!isNotificationCapabilities(reported)) {
      return createDegradedNotificationCapabilities('temporarily-unavailable');
    }
    // The copy is checked too: the shape check skips the holes of a sparse
    // `purposes` list, which the copy turns into `undefined` entries.
    const copy = copyNotificationCapabilities(reported);
    return isNotificationCapabilities(copy)
      ? copy
      : createDegradedNotificationCapabilities('temporarily-unavailable');
  } catch (error) {
    return createDegradedNotificationCapabilities(degradedNotificationAvailability(error));
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isNotificationCapabilities(value: unknown): value is NotificationCapabilities {
  // The shape, plus `remote.addressing: 'none'` exactly when remote delivery is unsupported.
  return isNotificationCapabilitiesShape(value)
    && value.remote.supported !== (value.remote.addressing === 'none');
}

function copyNotificationCapabilities(
  capabilities: NotificationCapabilities,
): NotificationCapabilities {
  // Copied field by field: the validator lets an unknown key through when its
  // value is `undefined`, and an optional count may be present as `undefined`.
  // Neither reaches the snapshot, which keeps exact keys and shares nothing
  // with the provider.
  const { permission, remote, local } = capabilities;
  return {
    availability: capabilities.availability,
    permission: {
      scope: permission.scope,
      prompt: permission.prompt,
      readable: permission.readable,
      serverReadable: permission.serverReadable,
      allowance: permission.allowance,
      userGesture: permission.userGesture,
      ...(permission.promptLimit === undefined ? {} : { promptLimit: permission.promptLimit }),
      ...(permission.maxTopicsPerPrompt === undefined
        ? {}
        : { maxTopicsPerPrompt: permission.maxTopicsPerPrompt }),
      settings: permission.settings,
    },
    remote: {
      supported: remote.supported,
      purposes: [...remote.purposes],
      addressing: remote.addressing,
      content: remote.content,
    },
    local: {
      supported: local.supported,
      ...(local.maxPending === undefined ? {} : { maxPending: local.maxPending }),
    },
    open: capabilities.open,
  };
}

/**
 * Failures that the same host answers the same way again: a transport without
 * notifications v2 (`NOTIFICATIONS_V2_UNAVAILABLE`, or `UNSUPPORTED_METHOD`
 * and `INVALID_BRIDGE_REQUEST` from a bridge that predates the methods), an
 * unimplemented method, and a host app too old for the API.
 */
const unsupportedNotificationReadCodes: ReadonlySet<unknown> = new Set([
  'NOTIFICATIONS_V2_UNAVAILABLE',
  'NOTIFICATIONS_UNSUPPORTED',
  'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED',
  'UNSUPPORTED_METHOD',
  'INVALID_BRIDGE_REQUEST',
]);

/**
 * The availability a failed read reports: a lasting failure that is not
 * retryable is `unsupported`, a missing configuration is
 * `configuration-required`, and anything else, including a retryable
 * transport failure and a read that timed out, may pass. The block's
 * availability is also the push readiness (RFC "Capabilities"), so a gateway
 * must not expose `notificationsV2` over a transport without v2, as no adapter
 * exposes `commerce` over one; if it does, the integration reads
 * `unsupported`.
 */
function degradedNotificationAvailability(error: unknown): PlatformProviderAvailability {
  const failure = typeof error === 'object' && error !== null
    ? error as { readonly code?: unknown; readonly retryable?: unknown }
    : {};
  if (failure.code === 'NOTIFICATIONS_CONFIGURATION_REQUIRED') {
    return 'configuration-required';
  }
  return failure.retryable !== true && unsupportedNotificationReadCodes.has(failure.code)
    ? 'unsupported'
    : 'temporarily-unavailable';
}

/** A block that offers nothing, with the availability that explains why. */
function createDegradedNotificationCapabilities(
  availability: PlatformProviderAvailability,
): NotificationCapabilities {
  return {
    availability,
    permission: {
      scope: 'app',
      prompt: 'os',
      readable: true,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: false,
      settings: false,
    },
    remote: { supported: false, purposes: [], addressing: 'none', content: 'free-form' },
    local: { supported: false },
    open: 'none',
  };
}

/**
 * Adds the exposed provider's block, with `providerAvailability.pushNotifications`
 * equal to its availability, or leaves any block out when no provider is exposed.
 */
function withNotificationCapabilities(
  capabilities: PlatformCapabilities,
  notifications: NotificationCapabilities | undefined,
): PlatformCapabilities {
  if (notifications === undefined) {
    if (!Object.hasOwn(capabilities, 'notifications')) {
      return capabilities;
    }
    const { notifications: _hidden, ...withoutNotifications } = capabilities;
    return withoutNotifications;
  }
  return {
    ...capabilities,
    providerAvailability: {
      ...capabilities.providerAvailability,
      pushNotifications: notifications.availability,
    },
    notifications,
  };
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
