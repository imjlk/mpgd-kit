import {
  bridgeStorageLoadProtocol,
  decodeBridgeStorageLoadData,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import type {
  IdentitySession,
  IdentityUpgradeResult,
  InboundShare,
  LaunchIntent,
  NotificationSubscriptionResult,
  NotificationSubscriptionStatus,
  PlatformCapabilities,
  PlatformGateway,
  PresentationResult,
  ShareResult,
} from '@mpgd/platform';

import { createAitLifecycleAdapter } from './lifecycle.js';

export interface GamePlatformBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
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
}

export function createAitPlatformGateway(input: {
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: GamePlatformBridge;
  readonly fallbackBridge?: GamePlatformBridge;
}): PlatformGateway {
  async function request<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    const bridge = input.bridge ?? getBridge() ?? input.fallbackBridge;

    if (bridge === undefined) {
      throw new Error('AIT bridge is not installed.');
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
      throw new Error(response.error.message);
    }

    return response.data as TData;
  }

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
    commerce: {
      getProducts: () => request('commerce.getProducts', {}),
      purchase: (payload) => request('commerce.purchase', payload),
      restore: () => request('commerce.restore', {}),
      getEntitlements: () => request('commerce.getEntitlements', {}),
    },
    ads: {
      preload: (payload) => request('ads.preload', payload),
      showRewarded: (payload) => request('ads.showRewarded', payload),
      showInterstitial: (payload) => request('ads.showInterstitial', payload),
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

  return {
    async request(input) {
      switch (input.method) {
        case 'runtime.getCapabilities':
          return ok(input, {
            nativeIap: true,
            nativeAds: true,
            rewardedAds: true,
            interstitialAds: true,
            nativeLeaderboard: true,
            achievements: false,
            cloudSave: false,
            socialShare: true,
            haptics: true,
            localizedContent: true,
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
