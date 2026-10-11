import {
  assertBridgeResponse,
  bridgeStorageLoadProtocol,
  createCommerceV2UnavailableBridgeError,
  decodeBridgeStorageLoadData,
  type BridgeEventSource,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import {
  PlatformOperationError,
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
import { commerceProtocolVersion, type CommerceProvider } from '@mpgd/platform/commerce';

import { createAitBridgeCommerceProvider } from './commerce-bridge.js';
import { aitCommerceStoreId, createAitCommerceCapabilities } from './commerce-provider.js';
import { createAitLifecycleAdapter } from './lifecycle.js';

export interface GamePlatformBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
  /** Native observations are scoped to this host; SDK commands still use request envelopes. */
  readonly advertising?: Pick<AdProvider, 'id' | 'protocol' | 'protocolVersion' | 'rewardSignal' | 'subscribe'>;
  /**
   * Commerce v2 event channel (`@mpgd/bridge` `BridgeEvent` envelopes). A host
   * that serves the `commerce.v2.*` methods exposes it; the gateway then
   * offers `commerceV2` over this bridge.
   */
  readonly commerceV2?: BridgeEventSource;
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
   * channel and the evidence-only v2 stub; any other build, or no build id,
   * exposes no channel, so the gateway offers no `commerceV2`, and the v2
   * methods answer `COMMERCE_V2_UNAVAILABLE`.
   */
  readonly buildId?: string;
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
  const commerceV2: CommerceProvider | undefined = commerceEventSource === undefined
    ? undefined
    : createAitBridgeCommerceProvider({
        store: aitCommerceStoreId,
        request: (method, payload) => requestOn(commerceBridge, method, payload),
        subscribe: (listener) => commerceEventSource.subscribe(listener),
      });

  return {
    target: 'ait',
    async getCapabilities() {
      return { ...await request<PlatformCapabilities>('runtime.getCapabilities', {}) };
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
    notifications: {
      getStatus: (topic) =>
        request<NotificationSubscriptionStatus>('notifications.getStatus', { topic }),
      requestSubscription: (topic) =>
        request<NotificationSubscriptionResult>('notifications.requestSubscription', { topic }),
    },
    promotions: {
      getAvailability: (payload) =>
        request<PromotionRewardAvailability>('promotions.getAvailability', payload),
      grantReward: (payload) => request<PromotionRewardResult>('promotions.grantReward', payload),
    },
    commerce: {
      getProducts: () => request('commerce.getProducts', {}),
      purchase: (payload) => request('commerce.purchase', payload),
      restore: () => request('commerce.restore', {}),
      getEntitlements: () => request('commerce.getEntitlements', {}),
    },
    ...(commerceV2 === undefined ? {} : { commerceV2 }),
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
  AitIapEntitlementReader,
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
  // Commerce v2 exists only for the sandbox build: an evidence-only stub
  // whose order ids no backend authority knows, so a verify request for them
  // fails closed. Every other build keeps the fail-closed bridge error and
  // no event channel, so its gateway offers no `commerceV2` at all.
  const commerceV2Enabled = options.buildId === aitSandboxBuildId;

  return {
    // The sandbox emits no commerce events; the channel exists so the gateway
    // offers `commerceV2` for the sandbox build the way it does for the host.
    ...(commerceV2Enabled ? { commerceV2: { subscribe: () => () => {} } } : {}),
    async request(input) {
      // Both the bridge option and the build id the gateway sends must name
      // the sandbox build; a bridge wired behind another gateway stays closed.
      const commerceV2Served = commerceV2Enabled && input.meta.buildId === aitSandboxBuildId;
      switch (input.method) {
        case 'runtime.getCapabilities':
          return ok(input, {
            nativeIap: true,
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
            // The sandbox build also serves commerce v2, so its snapshot
            // carries the block the flags derive from.
            ...(commerceV2Served
              ? { subscriptionIap: false, commerce: createAitCommerceCapabilities('available') }
              : {}),
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
          return ok(input, {
            status: 'shared',
          });

        case 'share.readInboundShare':
          return ok(input, null);

        case 'notifications.getStatus':
          return ok(input, 'configuration-required');

        case 'notifications.requestSubscription':
          return ok(input, 'unavailable');

        case 'promotions.getAvailability':
          return ok(input, 'configuration-required');

        case 'promotions.grantReward':
          return ok(input, { status: 'unavailable' });

        case 'commerce.getProducts':
          return ok(input, [
            {
              id: 'COINS_100',
              type: 'consumable',
              title: '100 Coins',
              description: 'Adds 100 sandbox coins.',
              price: {
                formatted: 'KRW 1,100',
                currencyCode: 'KRW',
              },
            },
          ]);

        case 'commerce.purchase':
          return ok(input, {
            status: 'completed',
            transactionId: `ait-sandbox-${input.id}`,
            entitlementIds: ['COINS_100'],
          });

        case 'commerce.restore':
          return ok(input, {
            restoredEntitlements: [],
          });

        case 'commerce.getEntitlements':
          return ok(input, []);

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
          return commerceV2Served
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
