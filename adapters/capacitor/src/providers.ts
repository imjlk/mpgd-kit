import {
  bridgeCommerceV2Methods,
  bridgeNotificationsV2Methods,
  isBridgeCommerceV2Method,
  isBridgeNotificationsV2Method,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeNotificationsEvent,
  type BridgeNotificationsV2Method,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import type { AdProvider } from '@mpgd/platform/ads';
import { isAdMobClientRewardEvidence } from '@mpgd/game-services/admob-client-reward';
import {
  PlatformOperationError,
  type CommerceCapabilities,
  type NotificationSubscriptionAdapter,
  type PlatformProviderAvailability,
  type PlatformProviderFeature,
} from '@mpgd/platform';
import {
  createUnsupportedCommerceCapabilities,
  isCommerceCapabilities,
  type CommerceProvider,
} from '@mpgd/platform/commerce';
// Types only: the validators stay in `@mpgd/adapter-capacitor/notifications`,
// so a game without notifications does not bundle them.
import type { NotificationCapabilities, NotificationProvider } from '@mpgd/platform/notifications';

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
   * serves the six `commerce.v2.*` methods and must implement `subscribe`;
   * `createCommerceServiceProvider` builds one from a `CommerceProvider`.
   */
  readonly bridge: NativeBridge;
  /**
   * The non-commerce features this provider serves. A provider with `commerce`
   * may declare none: commerce readiness is the provider's own capability
   * block, not a feature.
   */
  readonly features: readonly PlatformProviderFeature[];
  /**
   * Declared bridge methods, owned through `features`. A provider with
   * `commerce` declares no `commerce.v2.*` method: the six are implied and
   * owned by the commerce provider, so its own list may be empty.
   */
  readonly methods: readonly BridgeMethod[];
  /** Optional native event surface. The base adapter never imports its SDK. */
  readonly adProvider?: AdProvider;
  /**
   * Optional commerce provider (`createStoreCommerceProvider`). Its
   * `getCapabilities()` is the gateway's commerce block; `getAvailability`
   * covers the declared `features`.
   */
  readonly commerce?: CommerceProvider;
  /**
   * Optional notifications v2 service (`createNotificationServiceProvider`
   * from `@mpgd/adapter-capacitor/notifications`). The nine
   * `notifications.v2.*` methods are implied, and the gateway serves both
   * `notificationsV2` and the v1 `notifications` adapter from it.
   */
  readonly notificationsV2?: CapacitorNotificationsV2Service;
  getAvailability(): Promise<Readonly<Partial<Record<
    PlatformProviderFeature,
    PlatformProviderAvailability
  >>>>;
}

/**
 * What the gateway needs from a notifications v2 service. It comes from
 * `@mpgd/adapter-capacitor/notifications`, which holds the validators, so the
 * base adapter loads none of them.
 */
export interface CapacitorNotificationsV2Service {
  /** The service's own capability block, validated and copied. */
  getCapabilities(): Promise<NotificationCapabilities>;
  /** Throws when `data` is not a valid answer to `method`. */
  assertResult(method: BridgeNotificationsV2Method, data: unknown): void;
  /**
   * The game-facing surfaces over the gateway's request path: the
   * `notificationsV2` provider, and the v1 adapter served from it (RFC
   * "Capabilities": an adapter that exposes both backs v1 with v2).
   */
  createGatewaySurface(input: {
    readonly request: <TData>(method: BridgeNotificationsV2Method, payload: unknown) => Promise<TData>;
    readonly subscribe: (listener: (event: BridgeNotificationsEvent) => void) => () => void;
  }): {
    readonly notificationsV2: NotificationProvider;
    readonly notifications: NotificationSubscriptionAdapter;
  };
}

/** The provider the registry serves notifications v2 from. */
export interface CapacitorNotificationServiceProvider extends CapacitorServiceProvider {
  readonly notificationsV2: CapacitorNotificationsV2Service;
  readonly bridge: NativeBridge & Required<Pick<NativeBridge, 'subscribe'>>;
}

/** The provider the registry serves commerce v2 from. */
export interface CapacitorCommerceServiceProvider extends CapacitorServiceProvider {
  readonly commerce: CommerceProvider;
  readonly bridge: NativeBridge & Required<Pick<NativeBridge, 'subscribe'>>;
}

const featureMethods = {
  rewardedAds: ['ads.preload', 'ads.showRewarded'],
  interstitialAds: ['ads.preload', 'ads.showInterstitial'],
  bannerAds: ['ads.mountBanner', 'ads.unmountBanner'],
  nativeLeaderboard: ['leaderboard.submitScore', 'leaderboard.open'],
  identityUpgrade: ['identity.getPlayer', 'identity.getSession', 'identity.requestUpgrade'],
  pushNotifications: ['notifications.getStatus', 'notifications.requestSubscription'],
} as const satisfies Record<PlatformProviderFeature, readonly BridgeMethod[]>;

const providerFeatures = Object.keys(featureMethods) as PlatformProviderFeature[];
const providerMethodSet = new Set<BridgeMethod>(Object.values(featureMethods).flat());
const impliedCommerceMethods: readonly BridgeMethod[] = bridgeCommerceV2Methods;
const impliedNotificationMethods: readonly BridgeMethod[] = bridgeNotificationsV2Methods;
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
   * Always present, and a fresh copy on every read: the registered commerce
   * provider's validated `getCapabilities()` answer, the degraded block
   * (`availability: 'temporarily-unavailable'`, nothing sold) when that bounded
   * read stalled, failed, or returned a shape the contract rejects, or
   * `createUnsupportedCommerceCapabilities()` when no commerce provider is
   * registered.
   */
  readonly commerce: CommerceCapabilities;
  /**
   * Present exactly when a notifications v2 service is registered: its
   * validated block, or the degraded block (`availability:
   * 'temporarily-unavailable'`, nothing offered) when that bounded read
   * stalled or failed. `availability.pushNotifications` equals its
   * `availability`.
   */
  readonly notifications?: NotificationCapabilities;
}

export interface CapacitorProviderRegistry {
  readonly byMethod: ReadonlyMap<BridgeMethod, CapacitorServiceProvider>;
  /** The provider that serves commerce v2, when one is registered. */
  readonly commerce?: CapacitorCommerceServiceProvider;
  /** The provider that serves notifications v2, when one is registered. */
  readonly notifications?: CapacitorNotificationServiceProvider;
  /** Feature readiness plus the commerce block, from one bounded read per provider. */
  getCapabilitySnapshot(): Promise<CapacitorProviderCapabilitySnapshot>;
  assertMethodReady(method: BridgeMethod, payload?: unknown): Promise<void>;
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
  let notifications: CapacitorNotificationServiceProvider | undefined;

  for (const provider of providers) {
    if (provider.id.trim() === '' || ids.has(provider.id)) {
      throw new Error(`Capacitor provider ID is empty or registered twice: ${provider.id}`);
    }
    ids.add(provider.id);
    if (provider.commerce === undefined && provider.notificationsV2 === undefined
      && (provider.features.length === 0 || provider.methods.length === 0)) {
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
            + 'register a commerce provider through `commerce` instead, commerce v2 is '
            + 'unavailable as a declared method.',
        );
      }
      if (isBridgeNotificationsV2Method(method)) {
        // A notifications v2 provider is registered through `notificationsV2`;
        // a declared method would bypass the pass-through readiness rule.
        throw new Error(
          `Capacitor provider ${provider.id} cannot declare notifications v2 method ${method}: `
            + 'notifications v2 is unavailable as a declared method. Register a notifications '
            + 'service through `notificationsV2` instead.',
        );
      }
      if (!providerMethodSet.has(method)) {
        throw new Error(`Capacitor provider ${provider.id} cannot replace base method ${method}.`);
      }
    }
    const implied = [
      ...(provider.commerce === undefined ? [] : impliedCommerceMethods),
      ...(provider.notificationsV2 === undefined ? [] : impliedNotificationMethods),
    ];
    for (const method of [...methods, ...implied]) {
      if (byMethod.has(method)) {
        throw new Error(`Capacitor bridge method ${method} has multiple providers.`);
      }
    }
    const owned = new Set<BridgeMethod>([...methods, ...implied]);
    if (provider.commerce !== undefined && provider.bridge.subscribe === undefined) {
      // Without the event surface a purchase that completes after the store
      // UI closed would never reach the reconciler.
      throw new Error(
        `Capacitor provider ${provider.id} declares a commerce provider but its bridge has no `
          + 'subscribe; build it with createCommerceServiceProvider.',
      );
    }
    if (provider.notificationsV2 !== undefined && provider.bridge.subscribe === undefined) {
      // Opens and endpoint changes arrive only as events.
      throw new Error(
        `Capacitor provider ${provider.id} declares a notifications service but its bridge has `
          + 'no subscribe; build it with createNotificationServiceProvider.',
      );
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
    if (provider.notificationsV2 !== undefined) {
      // Validated above: the bridge implements `subscribe`.
      notifications = provider as CapacitorNotificationServiceProvider;
    }
  }
  if (notifications !== undefined && byFeature.has('pushNotifications')) {
    // The v1 adapter is served from the v2 provider, so the two report the
    // same readiness (RFC "Capabilities").
    throw new Error(
      `Capacitor provider ${byFeature.get('pushNotifications')?.id} declares pushNotifications, `
        + `which the notifications v2 provider ${notifications.id} serves.`,
    );
  }

  interface ProviderStates {
    readonly states: Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>>;
    /** The validated commerce block, when this provider serves commerce and the read succeeded. */
    readonly commerce?: CommerceCapabilities;
    /** The validated notifications block, when this provider serves it and the read succeeded. */
    readonly notifications?: NotificationCapabilities;
  }

  const readFeatureStates = async (
    provider: CapacitorServiceProvider,
  ): Promise<ProviderStates['states']> => {
    const states: Partial<Record<PlatformProviderFeature, PlatformProviderAvailability>> = {};
    if (provider.features.length === 0) {
      return states;
    }
    const reported = await readWithTimeout(
      Promise.resolve().then(() => provider.getAvailability()),
    );
    for (const feature of provider.features) {
      const state: unknown = isRecord(reported) ? reported[feature] : undefined;
      states[feature] = availabilitySet.has(state as PlatformProviderAvailability)
        ? state as PlatformProviderAvailability
        : 'temporarily-unavailable';
    }
    return states;
  };

  const readProviderStates = async (
    provider: CapacitorServiceProvider,
  ): Promise<ProviderStates> => {
    const [states, commerceBlock, notificationsBlock] = await Promise.all([
      readFeatureStates(provider),
      provider.commerce === undefined
        ? Promise.resolve(undefined)
        : readCommerceCapabilities(provider.commerce),
      provider.notificationsV2 === undefined
        ? Promise.resolve(undefined)
        : readNotificationCapabilities(provider.notificationsV2),
    ]);
    return {
      states,
      ...(commerceBlock === undefined ? {} : { commerce: commerceBlock }),
      ...(notificationsBlock === undefined ? {} : { notifications: notificationsBlock }),
    };
  };

  const getCapabilitySnapshot = async (): Promise<CapacitorProviderCapabilitySnapshot> => {
    const states = {} as Record<PlatformProviderFeature, PlatformProviderAvailability>;
    for (const feature of providerFeatures) {
      states[feature] = 'unsupported';
    }
    let commerceBlock: CommerceCapabilities | undefined;
    let notificationsBlock: NotificationCapabilities | undefined;
    const snapshots = await Promise.all(providers.map(readProviderStates));
    for (const snapshot of snapshots) {
      Object.assign(states, snapshot.states);
      commerceBlock = snapshot.commerce ?? commerceBlock;
      notificationsBlock = snapshot.notifications ?? notificationsBlock;
    }
    if (commerce === undefined) {
      commerceBlock = createUnsupportedCommerceCapabilities();
    } else if (commerceBlock === undefined) {
      // One bounded read serves the block, so a stalled, failed, or invalid
      // provider degrades it without rejecting the snapshot.
      commerceBlock = createDegradedCommerceCapabilities();
    }
    if (notifications === undefined) {
      return { availability: states, commerce: commerceBlock };
    }
    notificationsBlock ??= createDegradedNotificationCapabilities();
    // The v1 readiness follows the v2 block it is served from.
    states.pushNotifications = notificationsBlock.availability;
    return { availability: states, commerce: commerceBlock, notifications: notificationsBlock };
  };

  const getAvailability = async (): Promise<Readonly<Record<
    PlatformProviderFeature,
    PlatformProviderAvailability
  >>> => (await getCapabilitySnapshot()).availability;

  return {
    byMethod,
    ...(commerce === undefined ? {} : { commerce }),
    ...(notifications === undefined ? {} : { notifications }),
    getAvailability,
    getCapabilitySnapshot,
    async assertMethodReady(method, payload) {
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
      // An unrelated provider must not delay an ad or identity call, and neither
      // may its commerce capability read.
      const states = await readFeatureStates(provider);
      let relevant = provider.features.filter((feature) =>
        (featureMethods[feature] as readonly BridgeMethod[]).includes(method),
      );
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
        throw new PlatformOperationError({ code: 'NATIVE_PROVIDER_UNSUPPORTED' });
      }
      const ready = method === 'ads.preload' && preloadFormat === undefined
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

export function assertProviderResponseData(
  method: BridgeMethod,
  data: unknown,
  provider?: CapacitorServiceProvider,
): void {
  const valid = isValidProviderData(method, data, provider);
  if (!valid) {
    throw new PlatformOperationError({
      // A notifications v2 answer that breaks the contract is the provider's
      // configuration error (RFC "Bridge and versioning"), as on Apps in Toss.
      code: isBridgeNotificationsV2Method(method)
        ? 'NOTIFICATIONS_CONFIGURATION_REQUIRED'
        : 'NATIVE_PROVIDER_INVALID_RESPONSE',
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

/**
 * One bounded notifications capability read. The service validates and copies
 * its own block; a stalled or throwing read yields `undefined`.
 */
async function readNotificationCapabilities(
  service: CapacitorNotificationsV2Service,
): Promise<NotificationCapabilities | undefined> {
  return readWithTimeout(Promise.resolve().then(() => service.getCapabilities()));
}

/**
 * The notifications block a gateway reports while its service cannot be
 * read: nothing offered, `availability: 'temporarily-unavailable'`. The same
 * fields as `createUnsupportedNotificationCapabilities()`, written out so the
 * base adapter loads no notifications module.
 */
export function createDegradedNotificationCapabilities(): NotificationCapabilities {
  return {
    availability: 'temporarily-unavailable',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isVoidData(value: unknown): boolean {
  return value === undefined || value === null || (isRecord(value) && Object.keys(value).length === 0);
}

function isValidProviderData(
  method: BridgeMethod,
  value: unknown,
  provider: CapacitorServiceProvider | undefined,
): boolean {
  if (isBridgeCommerceV2Method(method)) {
    try {
      assertCommerceBridgeResult(method, value);
      return true;
    } catch {
      return false;
    }
  }
  if (isBridgeNotificationsV2Method(method)) {
    // The service validates with `assertBridgeNotificationsV2Result` from
    // `@mpgd/bridge/notifications`; a provider without one serves no v2
    // method, so its answer is rejected.
    if (provider?.notificationsV2 === undefined) {
      return false;
    }
    try {
      provider.notificationsV2.assertResult(method, value);
      return true;
    } catch {
      return false;
    }
  }
  switch (method) {
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

function isEvidence(value: unknown): boolean {
  return isRecord(value)
    && isString(value.schema)
    && isRecord(value.payload)
    && Object.values(value.payload).every((entry) =>
      isString(entry) || typeof entry === 'number' || typeof entry === 'boolean');
}
