import {
  assertBridgeResponse,
  bridgeStorageLoadProtocol,
  createCommerceV2UnavailableBridgeError,
  createNotificationsV2UnavailableBridgeError,
  decodeBridgeStorageLoadData,
  isBridgeNotificationsV2Method,
  type BridgeCommerceEvent,
  type BridgeEventStream,
  type BridgeMethod,
  type BridgeNotificationsEvent,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import {
  createUnsupportedCommerceCapabilities,
  PlatformOperationError,
  type CommerceCapabilities,
  type IdentitySession,
  type IdentityUpgradeResult,
  type InboundShare,
  type LaunchIntent,
  type NotificationSubscriptionResult,
  type NotificationSubscriptionStatus,
  type PlatformCapabilities,
  type PlatformGateway,
  type PresentationResult,
  type PromotionRewardAvailability,
  type PromotionRewardResult,
  type ShareResult,
} from '@mpgd/platform';
import {
  assertAdAvailability,
  assertAdPreparationResult,
  assertAdPresentationEvent,
  assertAdShowInput,
  assertAdShowResult,
  toAdAdapter,
  type AdProvider,
} from '@mpgd/platform/ads';
import {
  commerceProtocolVersion,
  isCommerceCapabilities,
  type CommerceProvider,
} from '@mpgd/platform/commerce';
// Types only: the notifications validators load with the bridge client
// (`./notifications-lazy`), so a game whose host offers no notifications
// channel carries none of them.
import type { NotificationCapabilities, NotificationProvider } from '@mpgd/platform/notifications';

import { createAitBridgeCommerceProvider } from './commerce-bridge.js';
import { aitCommerceStoreId, createAitCommerceCapabilities } from './commerce-provider.js';
import { createAitLifecycleAdapter } from './lifecycle.js';
import { createLazyAitBridgeNotificationProvider } from './notifications-lazy.js';
import { aitNotificationProviderId } from './notifications-provider-id.js';
import { unsupportedNotificationCapabilities } from './notifications-unsupported.js';
import { normalizeAitAppName, readAitShareRequest } from './share-link.js';

export interface GamePlatformBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
  /** Native observations are scoped to this host; SDK commands still use request envelopes. */
  readonly advertising?: Pick<AdProvider, 'id' | 'protocol' | 'protocolVersion' | 'rewardSignal' | 'subscribe'>;
  /**
   * Commerce v2 event channel (`@mpgd/bridge` `BridgeCommerceEvent`
   * envelopes). A host that serves the `commerce.v2.*` methods exposes it; the
   * gateway then offers `commerce` over this bridge.
   */
  readonly commerceV2?: BridgeEventStream<BridgeCommerceEvent>;
  /**
   * Notifications v2 event channel (`@mpgd/bridge` `BridgeNotificationsEvent`
   * envelopes). A host that serves the `notifications.v2.*` methods exposes
   * it; the gateway then offers `notificationsV2` over this bridge.
   */
  readonly notificationsV2?: BridgeEventStream<BridgeNotificationsEvent>;
}

export interface AitSandboxStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem?: (key: string) => void;
}

export interface CreateAitSandboxBridgeOptions {
  /** Persistent browser storage used by local AIT playtests. Defaults to localStorage when available. */
  readonly storage?: AitSandboxStorage | null;
  /** Namespace for persisted sandbox values so they cannot collide with application-owned keys. */
  readonly storageKeyPrefix?: string;
  /**
   * The build id the gateway sends (`runtime.buildId`). Only the sandbox build
   * (`ait-sandbox`, the build `pnpm dev:ait` makes) gets the commerce v2 event
   * channel and the evidence-only commerce stub; any other build, or no build
   * id, exposes no channel, so the gateway offers no `commerce` and reports the
   * unsupported commerce block, and the `commerce.v2.*` methods answer
   * `COMMERCE_V2_UNAVAILABLE`.
   */
  readonly buildId?: string;
  /**
   * The app name `intoss://` share links must carry, as the host bridge's
   * `appName`; both default to `mpgd-kit`. Root-relative and `https://` share
   * links do not depend on it.
   */
  readonly appName?: string;
}

export function createAitPlatformGateway(input: {
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: GamePlatformBridge;
  readonly fallbackBridge?: GamePlatformBridge;
}): PlatformGateway {
  const advertisingBridge = input.bridge ?? getBridge() ?? input.fallbackBridge;
  const advertising = advertisingBridge?.advertising;
  async function requestAdvertising(method: BridgeMethod, payload: unknown): Promise<unknown> {
    if (advertisingBridge === undefined) {
      throw new PlatformOperationError({
        code: 'AIT_BRIDGE_NOT_INSTALLED',
      });
    }
    const id = crypto.randomUUID();
    const response = assertBridgeResponse(
      await advertisingBridge.request({ id, method, payload, meta: { target: 'ait', appVersion: input.appVersion, buildId: input.buildId, sentAt: new Date().toISOString() } }),
    );
    if (response.id !== id) {
      throw new TypeError('Advertising response belongs to another bridge request.');
    }
    if (!response.ok) {
      throw new PlatformOperationError(response.error);
    }
    return response.data;
  }
  const provider: AdProvider | undefined = advertising === undefined
    ? undefined
    : {
        id: advertising.id,
        protocol: advertising.protocol,
        protocolVersion: advertising.protocolVersion,
        rewardSignal: advertising.rewardSignal,
        getAvailability: async (payload) =>
          assertAdAvailability(await requestAdvertising('ads.getAvailability', payload)),
        preload: async (payload) =>
          assertAdPreparationResult(await requestAdvertising('ads.prepare', payload)),
        show: async (supplied) => {
          const request = assertAdShowInput(supplied);
          const result = assertAdShowResult(await requestAdvertising('ads.show', request));
          if (result.providerId !== advertising.id || result.invocationId !== request.invocationId || result.format !== request.format) {
            throw new TypeError('Advertising result belongs to another invocation.');
          }
          return result;
        },
        subscribe: (listener) =>
          advertising.subscribe((event) => listener(assertAdPresentationEvent(event))),
      };
  if (provider !== undefined) {
    toAdAdapter(provider);
  }
  function request<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    return requestOn(input.bridge ?? getBridge() ?? input.fallbackBridge, method, payload);
  }

  async function requestOn<TData>(
    bridge: GamePlatformBridge | undefined,
    method: BridgeMethod,
    payload: unknown,
  ): Promise<TData> {
    if (bridge === undefined) {
      throw new PlatformOperationError({
        code: 'AIT_BRIDGE_NOT_INSTALLED',
        message: 'AIT bridge is not installed.',
        retryable: false,
      });
    }

    const response = await bridge.request({
      id: crypto.randomUUID(),
      method,
      payload,
      meta: {
        target: 'ait',
        appVersion: input.appVersion,
        buildId: input.buildId,
        sentAt: new Date().toISOString(),
      },
    });

    if (!response.ok) {
      throw new PlatformOperationError(response.error);
    }

    return response.data as TData;
  }

  // The bridge is resolved once, like the advertising surface, and commerce
  // commands go to that same bridge: the host that pushes commerce v2 events
  // is the one that serves the v2 methods, even if the global bridge is
  // reinstalled later.
  const commerceBridge = advertisingBridge;
  const commerceEventSource = commerceBridge?.commerceV2;
  const commerce: CommerceProvider | undefined = commerceEventSource === undefined
    ? undefined
    : createAitBridgeCommerceProvider({
        store: aitCommerceStoreId,
        request: (method, payload) => requestOn(commerceBridge, method, payload),
        subscribe: (listener) => commerceEventSource.subscribe(listener),
      });

  // Notifications v2, like commerce, stays on the bridge that offered its
  // event channel.
  const notificationEventSource = commerceBridge?.notificationsV2;
  const notificationsV2: NotificationProvider | undefined = notificationEventSource === undefined
    ? undefined
    : createLazyAitBridgeNotificationProvider({
        provider: aitNotificationProviderId,
        request: (method, payload) => requestOn(commerceBridge, method, payload),
        subscribe: (listener) => notificationEventSource.subscribe(listener),
      });

  function requestNotificationsV1<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    return notificationsV2 === undefined
      ? request<TData>(method, payload)
      : requestOn<TData>(commerceBridge, method, payload);
  }

  return {
    target: 'ait',
    async getCapabilities() {
      const bridgeNow = input.bridge ?? getBridge() ?? input.fallbackBridge;
      const [hostAnswer, notifications] = await Promise.all([
        requestOn<Readonly<Record<string, unknown>>>(bridgeNow, 'runtime.getCapabilities', {}),
        notificationsV2 === undefined ? undefined : readNotificationCapabilities(notificationsV2),
      ]);
      let capabilities = withNotificationCapabilities(
        toGatewayCapabilities(hostAnswer, commerce !== undefined),
        notifications,
      );
      if (commerce !== undefined && commerceBridge !== bridgeNow) {
        const pinned = toGatewayCapabilities(
          await requestOn<Readonly<Record<string, unknown>>>(commerceBridge, 'runtime.getCapabilities', {}),
          true,
        );
        capabilities = { ...capabilities, commerce: pinned.commerce };
      }
      return capabilities;
    },
    identity: {
      getPlayer: () => request('identity.getPlayer', {}),
      getSession: () => request<IdentitySession>('identity.getSession', {}),
      requestUpgrade: (payload) =>
        request<IdentityUpgradeResult>('identity.requestUpgrade', payload),
    },
    presentation: {
      getLaunchIntent: () => request<LaunchIntent>('presentation.getLaunchIntent', {}),
      requestGameSurface: (payload) =>
        request<PresentationResult>('presentation.requestGameSurface', payload),
    },
    sharing: {
      share: (payload) => request<ShareResult>('share.share', payload),
      readInboundShare: () => request<InboundShare | null>('share.readInboundShare', {}),
    },
    // v1 is served from the v2 provider, so it reads the bridge v2 is pinned
    // to whenever the gateway exposes v2.
    notifications: {
      getStatus: (topic) =>
        requestNotificationsV1<NotificationSubscriptionStatus>('notifications.getStatus', { topic }),
      requestSubscription: (topic) =>
        requestNotificationsV1<NotificationSubscriptionResult>(
          'notifications.requestSubscription',
          { topic },
        ),
    },
    promotions: {
      getAvailability: (payload) =>
        request<PromotionRewardAvailability>('promotions.getAvailability', payload),
      grantReward: (payload) => request<PromotionRewardResult>('promotions.grantReward', payload),
      recoverReward: (payload) => request<PromotionRewardResult>('promotions.recoverReward', payload),
    },
    ...(commerce === undefined ? {} : { commerce }),
    ...(notificationsV2 === undefined ? {} : { notificationsV2 }),
    ads: {
      ...(provider === undefined ? {} : { provider }),
      preload: (payload) => request('ads.preload', payload),
      showRewarded: (payload) => request('ads.showRewarded', payload),
      showInterstitial: (payload) => request('ads.showInterstitial', payload),
      mountBanner: (payload) => request('ads.mountBanner', payload),
      unmountBanner: (payload) => request('ads.unmountBanner', payload),
    },
    leaderboard: {
      submitScore: (payload) => request('leaderboard.submitScore', payload),
      open: (payload) => request('leaderboard.open', payload ?? {}),
    },
    lifecycle: createAitLifecycleAdapter(),
    storage: {
      async load(payload) {
        return decodeBridgeStorageLoadData(await request<unknown>('storage.load', payload));
      },
      save: (payload) => request('storage.save', payload),
    },
  };
}

export {
  aitIapDiagnosticCodes,
  aitIapProductNotGrantedByPartnerCode,
  type AitIapDiagnosticCode,
} from './iap-diagnostics.js';
export { aitBrowserOrigins, isAitBrowserOrigin } from './origins.js';
export {
  aitCommerceStoreId,
  aitIapCommerceErrorCodeMap,
  createAitCommerceCapabilities,
  createAitCommerceProvider,
  type AitCommerceProvider,
  type AitKnownPendingOrder,
  type AitPendingOrdersChange,
  type AitPendingOrdersChangeListener,
  type CreateAitCommerceProviderInput,
} from './commerce-provider.js';
export {
  createAitBridgeCommerceProvider,
  type CreateAitBridgeCommerceProviderInput,
} from './commerce-bridge.js';
export type {
  AitIapControllerOptions,
  AitIapDependencies,
  AitIapHostDependencies,
  AitIapPreparationInput,
  AitIapPreparer,
  AitIapProductConfig,
  AitIapProductGrantVerificationInput,
  AitIapProductGrantVerifier,
} from './iap.js';

export {
  aitLifecyclePauseEvent,
  aitLifecycleResumeEvent,
  createAitLifecycleAdapter,
  dispatchAitLifecycleEvent,
} from './lifecycle.js';

function getBridge(): GamePlatformBridge | undefined {
  return (globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge }).__GAME_PLATFORM_BRIDGE__;
}

/**
 * The capability snapshot the gateway reports for a host answer. A host built
 * before commerce v2 became the only commerce surface may still send the
 * removed `nativeIap` and `subscriptionIap` flags, at the top level or under
 * `providerAvailability`: they are dropped, so a snapshot never carries them. The `commerce` block is always valid: the
 * host's block when the gateway has a commerce provider and the block is
 * well-formed, the temporarily-unavailable block when the provider exists but
 * the host's block is missing or malformed, and the unsupported block for a
 * gateway without a provider (it sells nothing, whatever the host claims).
 */
function toGatewayCapabilities(
  hostAnswer: Readonly<Record<string, unknown>>,
  hasCommerceProvider: boolean,
): PlatformCapabilities {
  const capabilities: Record<string, unknown> = { ...hostAnswer };
  delete capabilities.nativeIap;
  delete capabilities.subscriptionIap;
  const availability = capabilities.providerAvailability;
  if (typeof availability === 'object' && availability !== null && !Array.isArray(availability)) {
    // The same retired keys under `providerAvailability`: a stale host still
    // sends them, and the snapshot contract has no place for them.
    const {
      nativeIap: _retiredNativeIap,
      subscriptionIap: _retiredSubscriptionIap,
      ...current
    } = availability as Readonly<Record<string, unknown>>;
    capabilities.providerAvailability = current;
  }
  const hostCommerce = capabilities.commerce;
  if (!hasCommerceProvider) {
    capabilities.commerce = createUnsupportedCommerceCapabilities();
  } else if (isCommerceCapabilities(hostCommerce)) {
    capabilities.commerce = copyCommerceCapabilities(hostCommerce);
  } else {
    // The gateway has a provider but the host did not describe it with a
    // valid block (a stale or broken host): report the store as temporarily
    // unavailable, nothing sold, rather than as permanently unsupported.
    capabilities.commerce = {
      ...createUnsupportedCommerceCapabilities(),
      availability: 'temporarily-unavailable',
    };
  }
  return capabilities as unknown as PlatformCapabilities;
}

/** Bound on one notifications capability read, as `withTargetAvailability` bounds it. */
const notificationCapabilityReadTimeoutMs = 3_000;

/** Failures the same host answers the same way again; `@mpgd/target-config` reads them as unsupported. */
const unsupportedNotificationReadCodes: ReadonlySet<unknown> = new Set([
  'NOTIFICATIONS_V2_UNAVAILABLE',
  'NOTIFICATIONS_UNSUPPORTED',
  'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED',
]);

/**
 * One bounded read of the bridge provider's block. The provider validated
 * it, so it is a fresh, exact block; a read that fails or stalls yields a
 * block that offers nothing, with the availability that explains why.
 */
async function readNotificationCapabilities(
  provider: NotificationProvider,
): Promise<NotificationCapabilities> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.getCapabilities(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Notification capabilities read timed out.')),
          notificationCapabilityReadTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    const failure = typeof error === 'object' && error !== null
      ? error as { readonly code?: unknown; readonly retryable?: unknown }
      : {};
    let availability: NotificationCapabilities['availability'] = 'temporarily-unavailable';
    if (failure.code === 'NOTIFICATIONS_CONFIGURATION_REQUIRED') {
      availability = 'configuration-required';
    } else if (failure.retryable !== true && unsupportedNotificationReadCodes.has(failure.code)) {
      availability = 'unsupported';
    }
    return { ...unsupportedNotificationCapabilities(), availability };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Adds the notifications v2 block exactly when the gateway exposes
 * `notificationsV2`, with `providerAvailability.pushNotifications` equal to
 * its availability (`PlatformCapabilities.notifications`).
 */
function withNotificationCapabilities(
  capabilities: PlatformCapabilities,
  notifications: NotificationCapabilities | undefined,
): PlatformCapabilities {
  if (notifications === undefined) {
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

/** A fresh block on every read, whatever object the host answered with. */
function copyCommerceCapabilities(capabilities: CommerceCapabilities): CommerceCapabilities {
  return {
    purchase: { ...capabilities.purchase },
    catalog: { ...capabilities.catalog },
    lifecycle: { ...capabilities.lifecycle },
    authority: { ...capabilities.authority },
    availability: capabilities.availability,
  };
}

export function createAitSandboxBridge(
  options: CreateAitSandboxBridgeOptions = {},
): GamePlatformBridge {
  const storage = new Map<string, unknown>();
  let persistentStorage: AitSandboxStorage | undefined;
  if (options.storage === undefined) {
    persistentStorage = resolveAitSandboxBrowserStorage();
  } else {
    persistentStorage = options.storage ?? undefined;
  }
  // PlatformGateway storage exposes load/save only. Sandbox callers should use stable,
  // namespaced keys whose values are overwritten instead of creating an unbounded key stream.
  const storageKeyPrefix = options.storageKeyPrefix ?? 'mpgd:ait-sandbox:';
  // Commerce exists only for the sandbox build: an evidence-only stub whose
  // order ids no backend authority knows, so a verify request for them fails
  // closed. Every other build keeps the fail-closed bridge error and no event
  // channel, so its gateway offers no `commerce` provider at all and reports
  // the unsupported commerce block.
  const commerceEnabled = options.buildId === aitSandboxBuildId;
  // The same default as the host bridge, so an unconfigured sandbox refuses
  // what an unconfigured host refuses.
  const sandboxAppName = normalizeAitAppName(options.appName ?? 'mpgd-kit');

  return {
    // The sandbox emits no commerce events; the channel exists so the gateway
    // offers `commerce` for the sandbox build the way it does for the host.
    ...(commerceEnabled ? { commerceV2: { subscribe: () => () => {} } } : {}),
    async request(input) {
      // Both the bridge option and the build id the gateway sends must name
      // the sandbox build; a bridge wired behind another gateway stays closed.
      const commerceServed = commerceEnabled && input.meta.buildId === aitSandboxBuildId;
      // Only the Toss app shows an agreement sheet, so only the host bridge
      // serves notifications v2. Every sandbox build answers the dedicated
      // code for every v2 method and exposes no notifications event channel,
      // so its gateway offers no `notificationsV2`.
      if (isBridgeNotificationsV2Method(input.method)) {
        return createNotificationsV2UnavailableBridgeError(input, 'Apps in Toss sandbox bridge');
      }
      switch (input.method) {
        case 'runtime.getCapabilities':
          return ok(input, {
            nativeAds: true,
            bannerAds: false,
            rewardedAds: true,
            interstitialAds: true,
            nativeLeaderboard: true,
            remoteLeaderboard: false,
            achievements: false,
            cloudSave: false,
            socialShare: true,
            haptics: true,
            localizedContent: true,
            // Only the sandbox build sells (the evidence-only stub below);
            // every other build reports the unsupported block.
            commerce: commerceServed
              ? createAitCommerceCapabilities('available')
              : createUnsupportedCommerceCapabilities(),
          });

        case 'identity.getPlayer':
          return ok(input, {
            playerId: 'ait-sandbox-player',
            displayName: 'AIT Sandbox Player',
          });

        case 'identity.getSession':
          return ok(input, {
            identityLevel: 'platform-anonymous',
            playerId: 'ait-sandbox-player',
            trustLevel: 'platform-asserted',
          });

        case 'identity.requestUpgrade':
          return ok(input, {
            status: 'unavailable',
            reloadExpected: false,
          });

        case 'presentation.getLaunchIntent':
          return ok(input, {
            entry: 'home',
          });

        case 'presentation.requestGameSurface':
          return ok(input, 'already-fullscreen');

        case 'share.share':
          // The sandbox reads share requests exactly as the host does, so a
          // request the host would refuse is not reported as shared here.
          return ok(
            input,
            readAitShareRequest(input.payload, sandboxAppName) === undefined
              ? { status: 'unavailable' }
              : { status: 'shared', completion: 'presented' },
          );

        case 'share.readInboundShare':
          return ok(input, null);

        case 'notifications.getStatus':
          return ok(input, 'configuration-required');

        case 'notifications.requestSubscription':
          return ok(input, 'unavailable');

        case 'promotions.getAvailability':
          return ok(input, 'configuration-required');

        case 'promotions.recoverReward':
        case 'promotions.grantReward':
          return ok(input, { status: 'unavailable' });

        case 'ads.preload':
          return ok(input, {});

        case 'ads.showRewarded':
          return ok(input, {
            status: 'completed',
            rewardGranted: true,
            ledgerEntryId: `ait-sandbox-reward-${input.id}`,
          });

        case 'ads.showInterstitial':
          return ok(input, {
            status: 'shown',
          });

        case 'ads.mountBanner':
          return ok(input, { status: 'unavailable' });

        case 'ads.unmountBanner':
          return ok(input, {});

        case 'leaderboard.submitScore':
          return ok(input, {
            submitted: true,
          });

        case 'leaderboard.open':
          return ok(input, {});

        case 'storage.load': {
          const payload = input.payload as { readonly key?: string };
          if (payload.key === undefined) {
            return ok(input, {
              __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
              found: false,
            } satisfies BridgeStorageLoadData);
          }
          if (storage.has(payload.key)) {
            return ok(input, {
              __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
              found: true,
              value: cloneJsonValue(storage.get(payload.key)),
            } satisfies BridgeStorageLoadData);
          }
          const persistent = loadPersistentSandboxValue(
            persistentStorage,
            `${storageKeyPrefix}${payload.key}`,
          );
          // Browser storage access failures commonly remain blocked for the page lifetime. The
          // sandbox intentionally degrades once per bridge instead of retrying and logging on every
          // load. Production AIT storage uses the host bridge and is not affected by this fallback.
          if (!persistent.storageAvailable && persistentStorage !== undefined) {
            console.warn(
              '[mpgd/adapter-ait] AIT sandbox persistent storage is unavailable; subsequent saves are memory-only and will not survive reloads.',
            );
            persistentStorage = undefined;
          }
          if (persistent.found) {
            // Keep the hydrated cache detached from the returned parsed value. Callers may mutate
            // their result, while a later memory load must still model serialized storage.
            storage.set(payload.key, cloneJsonValue(persistent.value));
            return ok(input, {
              __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
              found: true,
              value: persistent.value,
            } satisfies BridgeStorageLoadData);
          }
          return ok(input, {
            __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
            found: false,
          } satisfies BridgeStorageLoadData);
        }

        case 'storage.save': {
          const payload = input.payload as { readonly key?: string; readonly value?: unknown };

          if (payload.key !== undefined) {
            let serialized: string;
            let value: unknown;
            try {
              serialized = serializeJsonValue(payload.value);
              value = JSON.parse(serialized) as unknown;
            } catch {
              return createSandboxBridgeError(
                input,
                'STORAGE_SERIALIZATION_FAILED',
                'AIT sandbox storage values must be JSON-serializable.',
              );
            }

            try {
              savePersistentSandboxValue(
                persistentStorage,
                `${storageKeyPrefix}${payload.key}`,
                serialized,
              );
            } catch {
              // The helper reports the original failure and the loss of reload durability. The
              // sandbox still honors its memory fallback so local gameplay can continue.
              persistentStorage = undefined;
            }
            storage.set(payload.key, value);
          }

          return ok(input, {});
        }

        case 'commerce.v2.getCapabilities':
        case 'commerce.v2.fetchProducts':
        case 'commerce.v2.requestPurchase':
        case 'commerce.v2.getAvailablePurchases':
        case 'commerce.v2.finishTransaction':
        case 'commerce.v2.restorePurchases':
          return commerceServed
            ? ok(input, answerSandboxCommerceV2(input))
            : createCommerceV2UnavailableBridgeError(input, 'Apps in Toss sandbox bridge');

        default:
          return createSandboxBridgeError(
            input,
            'UNSUPPORTED_METHOD',
            `Unsupported AIT sandbox method: ${input.method}`,
          );
      }
    },
  };
}

/** The build id the starter sets for `pnpm dev:ait`; only that build gets the self-completing v2 stub. */
const aitSandboxBuildId = 'ait-sandbox';
const aitSandboxCommerceLogicalId = 'COINS_100';
const aitSandboxCommerceSku = 'coins_100';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function answerSandboxCommerceV2(input: BridgeRequest): unknown {
  switch (input.method) {
    case 'commerce.v2.getCapabilities':
      return {
        protocolVersion: commerceProtocolVersion,
        store: aitCommerceStoreId,
        capabilities: createAitCommerceCapabilities('available'),
      };
    case 'commerce.v2.fetchProducts':
      return {
        products: [
          {
            logicalId: aitSandboxCommerceLogicalId,
            store: aitCommerceStoreId,
            storeSku: aitSandboxCommerceSku,
            kind: 'consumable',
            title: '100 Coins',
            description: 'Adds 100 sandbox coins.',
            price: { formatted: 'KRW 1,100', currencyCode: 'KRW' },
          },
        ],
      };
    case 'commerce.v2.requestPurchase': {
      const logicalId = isRecord(input.payload) ? input.payload.logicalId : undefined;
      if (logicalId !== aitSandboxCommerceLogicalId) {
        // The sandbox sells one product; anything else is not for sale here.
        return {
          outcome: 'failed',
          error: {
            code: 'ITEM_UNAVAILABLE',
            retryable: false,
            message: `The Apps in Toss sandbox sells ${aitSandboxCommerceLogicalId} only.`,
          },
        };
      }
      // One order per attempt key, so a retried request answers the same order.
      const idempotencyKey = isRecord(input.payload) ? input.payload.idempotencyKey : undefined;
      const orderId = `ait-sandbox-${
        typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : input.id
      }`;
      return {
        outcome: 'purchased',
        purchase: {
          store: aitCommerceStoreId,
          transactionId: orderId,
          storeSku: aitSandboxCommerceSku,
          logicalId: aitSandboxCommerceLogicalId,
          quantity: 1,
          state: 'purchased',
          token: orderId,
          evidence: {
            schema: 'apps-in-toss.iap.callback.v1',
            payload: { orderId, sku: aitSandboxCommerceSku, source: 'process-product-grant' },
          },
          accountBinding: { kind: 'host-identity' },
        },
      };
    }
    case 'commerce.v2.getAvailablePurchases':
      return { purchases: [] };
    case 'commerce.v2.finishTransaction':
      return { finished: true };
    case 'commerce.v2.restorePurchases':
      return { restored: true };
    default:
      throw new Error(`Unsupported AIT sandbox commerce v2 method: ${input.method}`);
  }
}

function resolveAitSandboxBrowserStorage(): AitSandboxStorage | undefined {
  try {
    return (globalThis as { readonly localStorage?: AitSandboxStorage }).localStorage;
  } catch (error) {
    reportAitSandboxStorageResolutionFailure(error);
    return undefined;
  }
}

function loadPersistentSandboxValue(
  storage: AitSandboxStorage | undefined,
  key: string,
):
  | { readonly found: false; readonly storageAvailable: boolean }
  | { readonly found: true; readonly storageAvailable: true; readonly value: unknown } {
  if (storage === undefined) {
    return { found: false, storageAvailable: false };
  }

  let serialized: string | null;
  try {
    serialized = storage.getItem(key);
  } catch (error) {
    console.debug(
      '[mpgd/adapter-ait] AIT sandbox persistent storage load failed; treating the key as missing.',
      error,
    );
    return { found: false, storageAvailable: false };
  }

  if (serialized === null) {
    return { found: false, storageAvailable: true };
  }

  try {
    return {
      found: true,
      storageAvailable: true,
      value: JSON.parse(serialized) as unknown,
    };
  } catch (error) {
    console.warn(
      `[mpgd/adapter-ait] Removing corrupt sandbox storage value for key "${key}".`,
      error,
    );
    if (storage.removeItem === undefined) {
      console.warn(
        '[mpgd/adapter-ait] Corrupt sandbox storage cannot be removed; disabling persistent storage for this bridge.',
      );
      return { found: false, storageAvailable: false };
    }
    try {
      storage.removeItem(key);
    } catch (cleanupError) {
      console.warn(
        '[mpgd/adapter-ait] Corrupt sandbox storage cleanup failed; disabling persistent storage for this bridge.',
        cleanupError,
      );
      return { found: false, storageAvailable: false };
    }
    return { found: false, storageAvailable: true };
  }
}

function savePersistentSandboxValue(
  storage: AitSandboxStorage | undefined,
  key: string,
  serialized: string,
): void {
  if (storage === undefined) {
    return;
  }

  try {
    storage.setItem(key, serialized);
  } catch (error) {
    console.warn(
      '[mpgd/adapter-ait] AIT sandbox persistent storage save failed; subsequent saves are memory-only and will not survive reloads.',
      error,
    );
    throw error;
  }
}

function reportAitSandboxStorageResolutionFailure(error: unknown): void {
  console.debug(
    '[mpgd/adapter-ait] AIT sandbox browser storage resolution failed; using memory storage.',
    error,
  );
}

function cloneJsonValue(input: unknown): unknown {
  return JSON.parse(serializeJsonValue(input)) as unknown;
}

function serializeJsonValue(input: unknown): string {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) {
    throw new Error('AIT sandbox storage values must be JSON-serializable.');
  }
  return serialized;
}

function ok(input: BridgeRequest, data: unknown): BridgeResponse {
  return {
    id: input.id,
    ok: true,
    data,
  };
}

function createSandboxBridgeError(
  input: BridgeRequest,
  code: string,
  message: string,
  retryable = false,
): BridgeResponse {
  return {
    id: input.id,
    ok: false,
    error: { code, message, retryable },
  };
}
