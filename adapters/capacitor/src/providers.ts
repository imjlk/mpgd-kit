import {
  bridgeCommerceV2Methods,
  isBridgeCommerceV2Method,
  isBridgeNotificationsV2Method,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import type { AdProvider } from '@mpgd/platform/ads';
import { isAdMobClientRewardEvidence } from '@mpgd/game-services/admob-client-reward';
import {
  PlatformOperationError,
  type CommerceCapabilities,
  type PlatformProviderAvailability,
  type PlatformProviderFeature,
  type ProductType,
} from '@mpgd/platform';
import {
  createUnsupportedCommerceCapabilities,
  isCommerceCapabilities,
  type CommerceProvider,
} from '@mpgd/platform/commerce';

import { assertCommerceBridgeResult } from './commerce-bridge.js';

export interface NativeBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
  /**
   * Optional event delivery in the bridge envelopes, told apart by `protocol`
   * (`{ protocol: 'mpgd.commerce.v2', sequence, event }` from store
   * providers). The base gateway works without it.
   */
  subscribe?(listener: (event: BridgeEvent) => void): () => void;
}

/**
 * An optional, separately installed provider handles only its declared bridge
 * methods. The base game-services plugin remains responsible for local storage.
 * A provider may be backed by a native plugin or by a server-backed adapter;
 * neither dependency is imported by the base Capacitor adapter.
 */
export interface CapacitorServiceProvider {
  readonly id: string;
  /**
   * Serves the declared `methods`. For a provider with `commerce`, it also
   * serves the ten commerce bridge methods and must implement `subscribe`;
   * `createCommerceServiceProvider` builds one from a `CommerceProvider`.
   */
  readonly bridge: NativeBridge;
  readonly features: readonly PlatformProviderFeature[];
  /**
   * Declared v1 bridge methods. A provider with `commerce` declares no
   * `commerce.*` method: the four v1 commerce methods and the six
   * `commerce.v2.*` methods are implied and owned by the v2 provider.
   */
  readonly methods: readonly BridgeMethod[];
  /** Optional native event surface. The base adapter never imports its SDK. */
  readonly adProvider?: AdProvider;
  /**
   * Optional commerce v2 provider (`createStoreCommerceProvider`). Its
   * `getCapabilities()` is the readiness of the declared `nativeIap` and
   * `subscriptionIap` features; `getAvailability` covers the other features.
   */
  readonly commerce?: CommerceProvider;
  getAvailability(): Promise<Readonly<Partial<Record<
    PlatformProviderFeature,
    PlatformProviderAvailability
  >>>>;
}

/** The provider the registry serves commerce v2 from. */
export interface CapacitorCommerceServiceProvider extends CapacitorServiceProvider {
  readonly commerce: CommerceProvider;
  readonly bridge: NativeBridge & Required<Pick<NativeBridge, 'subscribe'>>;
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
const commerceFeatures: readonly PlatformProviderFeature[] = ['nativeIap', 'subscriptionIap'];
const v1CommerceMethods: readonly BridgeMethod[] = featureMethods.nativeIap;
const impliedCommerceMethods: readonly BridgeMethod[] = [
  ...v1CommerceMethods,
  ...bridgeCommerceV2Methods,
];
const availabilitySet = new Set<PlatformProviderAvailability>([
  'unsupported',
  'configuration-required',
  'action-required',
  'temporarily-unavailable',
  'available',
]);
const availabilityTimeoutMs = 3_000;

export interface CapacitorProviderCapabilitySnapshot {
  readonly availability: Readonly<Record<PlatformProviderFeature, PlatformProviderAvailability>>;
  /**
   * Present when a commerce v2 provider is registered: its validated
   * `getCapabilities()` answer from the same bounded read that produced the
   * `nativeIap` and `subscriptionIap` states, or a degraded block
   * (`availability: 'temporarily-unavailable'`, nothing sold) when that read
   * stalled, failed, or returned a shape the contract rejects.
   */
  readonly commerce?: CommerceCapabilities;
}

export interface CapacitorProviderRegistry {
  readonly byMethod: ReadonlyMap<BridgeMethod, CapacitorServiceProvider>;
  /** The provider that serves commerce v2, when one is registered. */
  readonly commerce?: CapacitorCommerceServiceProvider;
  /** Feature readiness plus the commerce block, from one bounded read per provider. */
  getCapabilitySnapshot(): Promise<CapacitorProviderCapabilitySnapshot>;
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
  const providers: CapacitorServiceProvider[] = input.map((provider) => ({
    ...provider,
    methods: [...provider.methods],
    features: [...provider.features],
    getAvailability: () => provider.getAvailability(),
  }));
  const byMethod = new Map<BridgeMethod, CapacitorServiceProvider>();
  const byFeature = new Map<PlatformProviderFeature, CapacitorServiceProvider>();
  const ids = new Set<string>();
  let commerce: CapacitorCommerceServiceProvider | undefined;

  for (const provider of providers) {
    if (provider.id.trim() === '' || ids.has(provider.id)) {
      throw new Error(`Capacitor provider ID is empty or registered twice: ${provider.id}`);
    }
    ids.add(provider.id);
    if (provider.features.length === 0
      || (provider.methods.length === 0 && provider.commerce === undefined)) {
      throw new Error(`Capacitor provider ${provider.id} must declare features and methods.`);
    }

    const methods = new Set(provider.methods);
    if (methods.size !== provider.methods.length) {
      throw new Error(`Capacitor provider ${provider.id} repeats a bridge method.`);
    }
    for (const method of methods) {
      if (isBridgeCommerceV2Method(method)) {
        // A v2 provider is registered through `commerce`; its bridge methods are implied.
        throw new Error(
          `Capacitor provider ${provider.id} cannot declare commerce v2 method ${method}; `
            + 'register a v2 provider through `commerce` instead, commerce v2 is unavailable as '
            + 'a declared method.',
        );
      }
      if (isBridgeNotificationsV2Method(method)) {
        // A notifications v2 provider gets its own registry surface (P2); a
        // declared method would bypass the pass-through readiness rule.
        throw new Error(
          `Capacitor provider ${provider.id} cannot declare notifications v2 method ${method}; `
            + 'notifications v2 is unavailable as a declared method.',
        );
      }
      if (!providerMethodSet.has(method)) {
        throw new Error(`Capacitor provider ${provider.id} cannot replace base method ${method}.`);
      }
      if (provider.commerce !== undefined && v1CommerceMethods.includes(method)) {
        throw new Error(
          `Capacitor provider ${provider.id} cannot declare both a commerce v2 provider and `
            + `v1 method ${method}; the registry serves v1 callers from the v2 provider.`,
        );
      }
    }
    const implied = provider.commerce === undefined ? [] : impliedCommerceMethods;
    for (const method of [...methods, ...implied]) {
      if (byMethod.has(method)) {
        throw new Error(`Capacitor bridge method ${method} has multiple providers.`);
      }
    }
    const owned = new Set<BridgeMethod>([...methods, ...implied]);
    if (provider.commerce !== undefined) {
      if (!provider.features.some((feature) => commerceFeatures.includes(feature))) {
        throw new Error(
          `Capacitor provider ${provider.id} declares a commerce v2 provider but no commerce feature.`,
        );
      }
      if (provider.bridge.subscribe === undefined) {
        // Without the event surface a purchase that completes after the store
        // UI closed would never reach the reconciler.
        throw new Error(
          `Capacitor provider ${provider.id} declares a commerce v2 provider but its bridge has no `
            + 'subscribe; build it with createCommerceServiceProvider.',
        );
      }
    }
    for (const feature of provider.features) {
      const required = featureMethods[feature];
      if (required === undefined || byFeature.has(feature)) {
        throw new Error(`Capacitor feature ${feature} has multiple or invalid providers.`);
      }
      if (required.some((method) => !owned.has(method))) {
        throw new Error(`Capacitor provider ${provider.id} lacks methods for ${feature}.`);
      }
      byFeature.set(feature, provider);
    }
    if ([...methods].some((method) => !provider.features.some(
      (feature) => (featureMethods[feature] as readonly BridgeMethod[]).includes(method),
    ))) {
      throw new Error(`Capacitor provider ${provider.id} declares an unowned method.`);
    }
    for (const method of owned) {
      byMethod.set(method, provider);
    }
    if (provider.commerce !== undefined) {
      // Validated above: the bridge implements `subscribe`.
      commerce = provider as CapacitorCommerceServiceProvider;
    }
  }

  interface ProviderStates {
    readonly states: Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>>;
    /** The validated commerce v2 block, when this provider serves commerce and the read succeeded. */
    readonly commerce?: CommerceCapabilities;
  }

  const readProviderStates = async (
    provider: CapacitorServiceProvider,
  ): Promise<ProviderStates> => {
    const states: Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>> = {};
    const commerceOwned = provider.commerce === undefined
      ? []
      : provider.features.filter((feature) => commerceFeatures.includes(feature));
    const bridged = provider.features.filter((feature) => !commerceOwned.includes(feature));
    let commerceBlock: CommerceCapabilities | undefined;
    if (provider.commerce !== undefined && commerceOwned.length > 0) {
      commerceBlock = await readCommerceCapabilities(provider.commerce);
      Object.assign(states, deriveCommerceFeatureStates(commerceBlock, commerceOwned));
    }
    if (bridged.length > 0) {
      const reported = await readWithTimeout(
        Promise.resolve().then(() => provider.getAvailability()),
      );
      for (const feature of bridged) {
        const state: unknown = isRecord(reported) ? reported[feature] : undefined;
        states[feature] = availabilitySet.has(state as PlatformProviderAvailability)
          ? state as PlatformProviderAvailability
          : 'temporarily-unavailable';
      }
    }
    return { states, ...(commerceBlock === undefined ? {} : { commerce: commerceBlock }) };
  };

  const getCapabilitySnapshot = async (): Promise<CapacitorProviderCapabilitySnapshot> => {
    const states = {} as Record<PlatformProviderFeature, PlatformProviderAvailability>;
    for (const feature of providerFeatures) {
      states[feature] = 'unsupported';
    }
    let commerceBlock: CommerceCapabilities | undefined;
    const snapshots = await Promise.all(providers.map(readProviderStates));
    for (const snapshot of snapshots) {
      Object.assign(states, snapshot.states);
      commerceBlock = snapshot.commerce ?? commerceBlock;
    }
    if (commerce !== undefined && commerceBlock === undefined) {
      // One bounded read serves the feature states and the block, so a stalled,
      // failed, or invalid provider degrades both the same way.
      commerceBlock = createDegradedCommerceCapabilities();
    }
    return {
      availability: states,
      ...(commerceBlock === undefined ? {} : { commerce: commerceBlock }),
    };
  };

  const getAvailability = async (): Promise<Readonly<Record<
    PlatformProviderFeature,
    PlatformProviderAvailability
  >>> => (await getCapabilitySnapshot()).availability;

  return {
    byMethod,
    ...(commerce === undefined ? {} : { commerce }),
    getAvailability,
    getCapabilitySnapshot,
    async assertMethodReady(method, payload, productType) {
      const provider = byMethod.get(method);
      if (provider === undefined) {
        return;
      }
      if (isBridgeCommerceV2Method(method) || isBridgeNotificationsV2Method(method)) {
        // A v2 provider reads its own `availability` and answers with it
        // (commerce fails closed before any store UI opens; notifications
        // answer `unsupported` or `action-required` states and outcomes), so
        // the registry adds no second, stale snapshot that would turn those
        // answers into errors.
        return;
      }
      if (method === 'ads.unmountBanner') {
        // Teardown must reach the provider that mounted the banner even after
        // its serving state becomes unavailable.
        return;
      }
      // An unrelated provider must not delay a purchase, ad, or identity call.
      const { states } = await readProviderStates(provider);
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

/**
 * One bounded, validated capability read. A stalled, throwing, or invalid
 * provider yields `undefined`; the block is copied so the gateway never hands
 * out a provider-owned object.
 */
async function readCommerceCapabilities(
  provider: CommerceProvider,
): Promise<CommerceCapabilities | undefined> {
  const reported = await readWithTimeout(Promise.resolve().then(() => provider.getCapabilities()));
  if (!isCommerceCapabilities(reported)) {
    return undefined;
  }
  return {
    purchase: { ...reported.purchase },
    catalog: { ...reported.catalog },
    lifecycle: { ...reported.lifecycle },
    authority: { ...reported.authority },
    availability: reported.availability,
  };
}

/** The commerce block a gateway reports while its provider cannot be read. */
export function createDegradedCommerceCapabilities(): CommerceCapabilities {
  return { ...createUnsupportedCommerceCapabilities(), availability: 'temporarily-unavailable' };
}

async function readWithTimeout<T>(read: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Provider availability timed out.')),
          availabilityTimeoutMs,
        );
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Readiness of the commerce features a v2 provider declares, from its own
 * capability declaration: a feature it does not sell is `unsupported`, and a
 * read that failed or stalled is `temporarily-unavailable`.
 */
export function deriveCommerceFeatureStates(
  capabilities: CommerceCapabilities | undefined,
  features: readonly PlatformProviderFeature[],
): Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>> {
  const states: Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>> = {};
  const availability = capabilities === undefined
    || !availabilitySet.has(capabilities.availability)
    ? 'temporarily-unavailable'
    : capabilities.availability;
  for (const feature of features) {
    if (feature === 'nativeIap') {
      states.nativeIap = capabilities !== undefined
        && !(capabilities.purchase.consumable || capabilities.purchase.durable)
        ? 'unsupported'
        : availability;
    } else if (feature === 'subscriptionIap') {
      states.subscriptionIap = capabilities !== undefined && !capabilities.purchase.subscription
        ? 'unsupported'
        : availability;
    }
  }
  return states;
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
  if (isBridgeCommerceV2Method(method)) {
    try {
      assertCommerceBridgeResult(method, value);
      return true;
    } catch {
      return false;
    }
  }
  if (isBridgeNotificationsV2Method(method)) {
    // P2 must validate these answers here, with `assertBridgeNotificationsV2Result`
    // from `@mpgd/bridge/notifications`, when it lets a provider serve the
    // methods. Until then every notifications v2 answer is rejected.
    return false;
  }
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
        && (value.evidence === undefined || isEvidence(value.evidence))
        && (value.diagnostic === undefined || isCommerceDiagnostic(value.diagnostic));
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
              || typeof settlement.alreadyProcessed === 'boolean')
            && (settlement.idempotencyKey === undefined
              || isIdempotencyKey(settlement.idempotencyKey)),
          )
        ))
        && (value.diagnostic === undefined || isCommerceDiagnostic(value.diagnostic));
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
        && (value.status !== 'completed' || value.rewardGranted
          || value.evidence === undefined || isAdMobClientRewardEvidence(value))
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

/** Mirrors the stable, non-sensitive code format of `PlatformOperationError`. */
function isDiagnosticCode(value: unknown): value is string {
  return isString(value) && value.length <= 128 && /^[A-Z][A-Z0-9_:-]*$/u.test(value);
}

function isCommerceDiagnostic(value: unknown): boolean {
  return isRecord(value)
    && isDiagnosticCode(value.code)
    && typeof value.retryable === 'boolean'
    && (value.providerCode === undefined || isDiagnosticCode(value.providerCode));
}

function isIdempotencyKey(value: unknown): boolean {
  return isString(value)
    && value.length > 0
    && value.length <= 256
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isEvidence(value: unknown): boolean {
  return isRecord(value)
    && isString(value.schema)
    && isRecord(value.payload)
    && Object.values(value.payload).every((entry) =>
      isString(entry) || typeof entry === 'number' || typeof entry === 'boolean');
}
