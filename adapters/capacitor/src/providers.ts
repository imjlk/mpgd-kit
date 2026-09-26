import type { BridgeMethod, BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import {
  PlatformOperationError,
  type PlatformProviderAvailability,
  type PlatformProviderFeature,
  type ProductType,
} from '@mpgd/platform';

export interface NativeBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

/**
 * An optional, separately installed provider handles only its declared bridge
 * methods. The base game-services plugin remains responsible for local storage.
 * A provider may be backed by a native plugin or by a server-backed adapter;
 * neither dependency is imported by the base Capacitor adapter.
 */
export interface CapacitorServiceProvider {
  readonly id: string;
  readonly bridge: NativeBridge;
  readonly features: readonly PlatformProviderFeature[];
  readonly methods: readonly BridgeMethod[];
  getAvailability(): Promise<Readonly<Partial<Record<
    PlatformProviderFeature,
    PlatformProviderAvailability
  >>>>;
}

const featureMethods = {
  nativeIap: [
    'commerce.getProducts',
    'commerce.purchase',
    'commerce.restore',
    'commerce.getEntitlements',
  ],
  subscriptionIap: [
    'commerce.getProducts',
    'commerce.purchase',
    'commerce.restore',
    'commerce.getEntitlements',
  ],
  rewardedAds: ['ads.preload', 'ads.showRewarded'],
  interstitialAds: ['ads.preload', 'ads.showInterstitial'],
  bannerAds: ['ads.mountBanner', 'ads.unmountBanner'],
  nativeLeaderboard: ['leaderboard.submitScore', 'leaderboard.open'],
  identityUpgrade: ['identity.getPlayer', 'identity.getSession', 'identity.requestUpgrade'],
  pushNotifications: ['notifications.getStatus', 'notifications.requestSubscription'],
} as const satisfies Record<PlatformProviderFeature, readonly BridgeMethod[]>;

const providerFeatures = Object.keys(featureMethods) as PlatformProviderFeature[];
const providerMethodSet = new Set<BridgeMethod>(Object.values(featureMethods).flat());
const availabilitySet = new Set<PlatformProviderAvailability>([
  'unsupported',
  'configuration-required',
  'action-required',
  'temporarily-unavailable',
  'available',
]);
const availabilityTimeoutMs = 3_000;

export interface CapacitorProviderRegistry {
  readonly byMethod: ReadonlyMap<BridgeMethod, CapacitorServiceProvider>;
  assertMethodReady(
    method: BridgeMethod,
    payload?: unknown,
    productType?: ProductType,
  ): Promise<void>;
  getAvailability(): Promise<Readonly<Record<
    PlatformProviderFeature,
    PlatformProviderAvailability
  >>>;
}

export function createCapacitorProviderRegistry(
  input: readonly CapacitorServiceProvider[],
): CapacitorProviderRegistry {
  const providers = input.map((provider) => ({
    ...provider,
    methods: [...provider.methods],
    features: [...provider.features],
    getAvailability: () => provider.getAvailability(),
  }));
  const byMethod = new Map<BridgeMethod, CapacitorServiceProvider>();
  const byFeature = new Map<PlatformProviderFeature, CapacitorServiceProvider>();
  const ids = new Set<string>();

  for (const provider of providers) {
    if (provider.id.trim() === '' || ids.has(provider.id)) {
      throw new Error(`Capacitor provider ID is empty or registered twice: ${provider.id}`);
    }
    ids.add(provider.id);
    if (provider.features.length === 0 || provider.methods.length === 0) {
      throw new Error(`Capacitor provider ${provider.id} must declare features and methods.`);
    }

    const methods = new Set(provider.methods);
    if (methods.size !== provider.methods.length) {
      throw new Error(`Capacitor provider ${provider.id} repeats a bridge method.`);
    }
    for (const method of methods) {
      if (!providerMethodSet.has(method)) {
        throw new Error(`Capacitor provider ${provider.id} cannot replace base method ${method}.`);
      }
      if (byMethod.has(method)) {
        throw new Error(`Capacitor bridge method ${method} has multiple providers.`);
      }
    }
    for (const feature of provider.features) {
      const required = featureMethods[feature];
      if (required === undefined || byFeature.has(feature)) {
        throw new Error(`Capacitor feature ${feature} has multiple or invalid providers.`);
      }
      if (required.some((method) => !methods.has(method))) {
        throw new Error(`Capacitor provider ${provider.id} lacks methods for ${feature}.`);
      }
      byFeature.set(feature, provider);
    }
    if ([...methods].some((method) => !provider.features.some(
      (feature) => (featureMethods[feature] as readonly BridgeMethod[]).includes(method),
    ))) {
      throw new Error(`Capacitor provider ${provider.id} declares an unowned method.`);
    }
    for (const method of methods) {
      byMethod.set(method, provider);
    }
  }

  const readProviderStates = async (
    provider: CapacitorServiceProvider,
  ): Promise<Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>>> => {
    let reported: Readonly<Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>>>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      reported = await Promise.race([
        Promise.resolve().then(() => provider.getAvailability()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Provider availability timed out.')),
            availabilityTimeoutMs);
        }),
      ]);
      if (!isRecord(reported)) {
        throw new Error('Invalid provider availability.');
      }
    } catch {
      reported = {};
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    const states: Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>> = {};
    for (const feature of provider.features) {
      const state: unknown = reported[feature];
      states[feature] = availabilitySet.has(state as PlatformProviderAvailability)
        ? state as PlatformProviderAvailability
        : 'temporarily-unavailable';
    }
    return states;
  };

  const getAvailability = async (): Promise<Readonly<Record<
    PlatformProviderFeature,
    PlatformProviderAvailability
  >>> => {
    const states = {} as Record<PlatformProviderFeature, PlatformProviderAvailability>;
    for (const feature of providerFeatures) {
      states[feature] = 'unsupported';
    }
    const snapshots = await Promise.all(providers.map(readProviderStates));
    for (const snapshot of snapshots) {
      Object.assign(states, snapshot);
    }
    return states;
  };

  return {
    byMethod,
    getAvailability,
    async assertMethodReady(method, payload, productType) {
      const provider = byMethod.get(method);
      if (provider === undefined) {
        return;
      }
      if (method === 'ads.unmountBanner') {
        // Teardown must reach the provider that mounted the banner even after
        // its serving state becomes unavailable.
        return;
      }
      // An unrelated provider must not delay a purchase, ad, or identity call.
      const states = await readProviderStates(provider);
      let relevant = provider.features.filter((feature) =>
        (featureMethods[feature] as readonly BridgeMethod[]).includes(method),
      );
      if (method === 'commerce.purchase' && relevant.length > 1) {
        relevant = relevant.filter((feature) => feature === (
          productType === 'subscription' ? 'subscriptionIap'
            : productType === 'consumable' || productType === 'non_consumable'
              ? 'nativeIap' : undefined
        ));
      }
      const preloadFormat = method === 'ads.preload' && isRecord(payload)
        ? payload.format
        : undefined;
      if (method === 'ads.preload' && preloadFormat !== undefined) {
        const feature = preloadFormat === 'rewarded'
          ? 'rewardedAds'
          : preloadFormat === 'interstitial'
            ? 'interstitialAds'
            : undefined;
        relevant = feature === undefined ? [] : relevant.filter((item) => item === feature);
      }
      if (relevant.length === 0) {
        throw new PlatformOperationError({
          code: method === 'commerce.purchase'
            ? 'NATIVE_PROVIDER_PRODUCT_TYPE_REQUIRED'
            : 'NATIVE_PROVIDER_UNSUPPORTED',
        });
      }
      const ready = (method === 'ads.preload' && preloadFormat === undefined)
        || ((method === 'commerce.restore' || method === 'commerce.getEntitlements')
          && relevant.length > 1)
        ? relevant.every((feature) => states[feature] === 'available')
        : relevant.some((feature) => states[feature] === 'available');
      if (ready) {
        return;
      }
      // These methods exist to explain or resolve an action-required state.
      if (
        (method === 'identity.getPlayer' || method === 'identity.getSession'
          || method === 'identity.requestUpgrade'
          || method === 'notifications.getStatus'
          || method === 'notifications.requestSubscription')
        && relevant.some((feature) => states[feature] === 'action-required')
      ) {
        return;
      }

      const state = relevant.map((feature) => states[feature] ?? 'temporarily-unavailable').find((value) =>
        value !== 'unsupported' && value !== 'available') ?? 'unsupported';
      const code = {
        unsupported: 'NATIVE_PROVIDER_UNSUPPORTED',
        'configuration-required': 'NATIVE_PROVIDER_CONFIGURATION_REQUIRED',
        'action-required': 'NATIVE_PROVIDER_ACTION_REQUIRED',
        'temporarily-unavailable': 'NATIVE_PROVIDER_TEMPORARILY_UNAVAILABLE',
        available: 'NATIVE_PROVIDER_NOT_READY',
      } satisfies Record<PlatformProviderAvailability, string>;
      throw new PlatformOperationError({
        code: code[state],
        retryable: state === 'temporarily-unavailable',
      });
    },
  };
}

export function assertProviderResponseData(method: BridgeMethod, data: unknown): void {
  const valid = isValidProviderData(method, data);
  if (!valid) {
    throw new PlatformOperationError({
      code: 'NATIVE_PROVIDER_INVALID_RESPONSE',
      message: `Capacitor provider returned invalid data for ${method}.`,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isVoidData(value: unknown): boolean {
  return value === undefined || value === null || (isRecord(value) && Object.keys(value).length === 0);
}

function isValidProviderData(method: BridgeMethod, value: unknown): boolean {
  switch (method) {
    case 'commerce.getProducts':
      return Array.isArray(value) && value.every((product) =>
        isRecord(product)
        && isString(product.id)
        && ['consumable', 'non_consumable', 'subscription'].includes(product.type as string)
        && isString(product.title)
        && isString(product.description)
        && isRecord(product.price)
        && isString(product.price.formatted)
        && isString(product.price.currencyCode),
      );
    case 'commerce.purchase':
      return isRecord(value)
        && ['completed', 'cancelled', 'pending', 'failed'].includes(value.status as string)
        && isStringArray(value.entitlementIds)
        && (value.transactionId === undefined || isString(value.transactionId))
        && (value.authoritativeGrant === undefined || (
          value.status === 'completed'
          && isString(value.transactionId)
          && isRecord(value.authoritativeGrant)
          && isString(value.authoritativeGrant.ledgerEntryId)
          && value.authoritativeGrant.ledgerEntryId.length > 0
          && (value.authoritativeGrant.alreadyProcessed === undefined
            || typeof value.authoritativeGrant.alreadyProcessed === 'boolean')
        ))
        && (value.evidence === undefined || isEvidence(value.evidence));
    case 'commerce.restore':
      return isRecord(value)
        && Array.isArray(value.restoredEntitlements)
        && value.restoredEntitlements.every(isEntitlement)
        && (value.settledPurchases === undefined || (
          Array.isArray(value.settledPurchases)
          && value.settledPurchases.every((settlement) =>
            isRecord(settlement)
            && isString(settlement.transactionId)
            && isString(settlement.productId)
            && ['granted', 'refunded'].includes(settlement.status as string)
            && (settlement.ledgerEntryId === undefined || isString(settlement.ledgerEntryId))
            && (settlement.alreadyProcessed === undefined
              || typeof settlement.alreadyProcessed === 'boolean'),
          )
        ));
    case 'commerce.getEntitlements':
      return Array.isArray(value) && value.every(isEntitlement);
    case 'ads.preload':
    case 'ads.unmountBanner':
    case 'leaderboard.open':
      return isVoidData(value);
    case 'ads.showRewarded':
      return isRecord(value)
        && ['completed', 'pending', 'skipped', 'unavailable', 'failed'].includes(value.status as string)
        && typeof value.rewardGranted === 'boolean'
        && (!value.rewardGranted || (
          value.status === 'completed'
          && isString(value.ledgerEntryId)
          && value.ledgerEntryId.length > 0
        ))
        && (value.evidence === undefined || isEvidence(value.evidence));
    case 'ads.showInterstitial':
      return isRecord(value)
        && ['shown', 'skipped', 'unavailable'].includes(value.status as string);
    case 'ads.mountBanner':
      return isRecord(value)
        && ['mounted', 'unavailable', 'failed'].includes(value.status as string);
    case 'leaderboard.submitScore':
      return isRecord(value)
        && typeof value.submitted === 'boolean'
        && (value.rank === undefined || (
          typeof value.rank === 'number' && Number.isFinite(value.rank)
        ));
    case 'identity.getPlayer':
      return value === null || (isRecord(value)
        && isString(value.playerId)
        && (value.displayName === undefined || isString(value.displayName))
        && (value.avatarUrl === undefined || isString(value.avatarUrl)));
    case 'identity.getSession':
      return isRecord(value)
        && ['guest', 'platform-anonymous', 'authenticated'].includes(value.identityLevel as string)
        && ['local', 'platform-asserted', 'server-verified'].includes(value.trustLevel as string)
        && (value.playerId === undefined || isString(value.playerId));
    case 'identity.requestUpgrade':
      return isRecord(value)
        && ['completed', 'cancelled', 'unavailable'].includes(value.status as string)
        && typeof value.reloadExpected === 'boolean';
    case 'notifications.getStatus':
      return [
        'subscribed', 'not-subscribed', 'approval-required',
        'configuration-required', 'unsupported',
      ].includes(value as string);
    case 'notifications.requestSubscription':
      return ['subscribed', 'rejected', 'unavailable'].includes(value as string);
    default:
      return false;
  }
}

function isEntitlement(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && ['purchase', 'promotion', 'admin'].includes(value.source as string)
    && isString(value.grantedAt)
    && (value.expiresAt === undefined || isString(value.expiresAt));
}

function isEvidence(value: unknown): boolean {
  return isRecord(value)
    && isString(value.schema)
    && isRecord(value.payload)
    && Object.values(value.payload).every((entry) =>
      isString(entry) || typeof entry === 'number' || typeof entry === 'boolean');
}
