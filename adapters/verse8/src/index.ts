import {
  Verse8Ads,
  type InterstitialAdResult as Verse8InterstitialAdResult,
  type RewardedAdResult as Verse8RewardedAdResult,
} from '@verse8/ads';
import { Verse8 } from '@verse8/platform/vanilla';

import {
  createUnsupportedCapabilities,
  type IdentitySession,
  type LogicalAdPlacementId,
  type PlatformGateway,
  type PlayerIdentity,
} from '@mpgd/platform';

import { verse8AdsRewardEvidenceSchema } from './ads-contract.js';

export { verse8AdsRewardEvidenceSchema } from './ads-contract.js';

export interface Verse8Credential {
  readonly account: `0x${string}`;
  readonly verse: string;
  readonly exp: number;
}

export interface Verse8AuthClient {
  getUser(options?: { readonly requireTrustedSigner?: boolean }): Verse8Credential;
}

export interface Verse8Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Verse8VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', callback: () => void): void;
  removeEventListener(type: 'visibilitychange', callback: () => void): void;
}

export interface Verse8AdsClient {
  showRewarded(input: {
    readonly placementId: string;
    readonly timeoutMs?: number;
    readonly meta?: Record<string, unknown>;
  }): Promise<Verse8RewardedAdResult>;
  showInterstitial(input: {
    readonly placementId: string;
    readonly timeoutMs?: number;
    readonly meta?: Record<string, unknown>;
  }): Promise<Verse8InterstitialAdResult>;
}

export interface Verse8PlatformGatewayOptions {
  readonly authClient?: Verse8AuthClient;
  readonly adsClient?: Verse8AdsClient;
  readonly adsTimeoutMs?: number;
  readonly resolveAdPlacementId?: (placementId: LogicalAdPlacementId) => string | undefined;
  readonly storage?: Verse8Storage;
  readonly visibility?: Verse8VisibilitySource;
}

interface ResolvedVerse8Identity {
  readonly player: PlayerIdentity | null;
  readonly session: IdentitySession;
}

export function createVerse8PlatformGateway(
  options: Verse8PlatformGatewayOptions = {},
): PlatformGateway {
  const authClient = options.authClient ?? createDefaultAuthClient();
  const adsClient = options.adsClient ?? Verse8Ads;
  const adsAvailable = options.resolveAdPlacementId !== undefined;
  const pauseListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();
  const visibility = options.visibility ?? resolveVisibilitySource();
  const onVisibilityChange = () => {
    const listeners = visibility?.hidden === true ? pauseListeners : resumeListeners;

    for (const listener of listeners) {
      listener();
    }
  };

  visibility?.addEventListener('visibilitychange', onVisibilityChange);

  return {
    target: 'verse8',
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        nativeAds: adsAvailable,
        rewardedAds: adsAvailable,
        interstitialAds: adsAvailable,
        localizedContent: true,
      };
    },
    identity: {
      async getPlayer() {
        return resolveVerse8Identity(authClient).player;
      },
      async getSession() {
        return resolveVerse8Identity(authClient).session;
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        return {
          status: 'failed',
          entitlementIds: [],
        };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded(input) {
        const placementId = options.resolveAdPlacementId?.(input.placementId);

        if (placementId === undefined) {
          return unavailableReward();
        }

        try {
          const result = await adsClient.showRewarded({
            placementId,
            ...(options.adsTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.adsTimeoutMs }),
            meta: {
              logicalPlacementId: input.placementId,
            },
          });

          if (result.status === 'rewarded') {
            return {
              status: 'completed',
              rewardGranted: true,
              ledgerEntryId: result.requestId,
              evidence: {
                schema: verse8AdsRewardEvidenceSchema,
                payload: {
                  requestId: result.requestId,
                  placementId,
                  ...(result.platform === undefined ? {} : { platform: result.platform }),
                },
              },
            };
          }

          if (result.status === 'dismissed') {
            return {
              status: 'skipped',
              rewardGranted: false,
            };
          }

          return result.error.code === 'unsupported_env'
            ? unavailableReward()
            : {
                status: 'failed',
                rewardGranted: false,
              };
        } catch {
          return {
            status: 'failed',
            rewardGranted: false,
          };
        }
      },
      async showInterstitial(input) {
        const placementId = options.resolveAdPlacementId?.(input.placementId);

        if (placementId === undefined) {
          return { status: 'unavailable' };
        }

        try {
          const result = await adsClient.showInterstitial({
            placementId,
            ...(options.adsTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.adsTimeoutMs }),
            meta: {
              logicalPlacementId: input.placementId,
            },
          });

          if (result.status === 'dismissed') {
            return { status: 'shown' };
          }

          return result.error.code === 'unsupported_env'
            ? { status: 'unavailable' }
            : { status: 'skipped' };
        } catch {
          return { status: 'skipped' };
        }
      },
    },
    leaderboard: {
      async submitScore() {
        return {
          submitted: false,
        };
      },
      async open() {},
    },
    lifecycle: {
      onPause(callback) {
        pauseListeners.add(callback);
        return () => pauseListeners.delete(callback);
      },
      onResume(callback) {
        resumeListeners.add(callback);
        return () => resumeListeners.delete(callback);
      },
    },
    storage: {
      async load(input) {
        const storage = options.storage ?? resolveStorage();
        const value = storage?.getItem(storageKey(authClient, input.key));

        return value === undefined || value === null
          ? null
          : { value: JSON.parse(value) as unknown };
      },
      async save(input) {
        const storage = options.storage ?? resolveStorage();
        storage?.setItem(storageKey(authClient, input.key), JSON.stringify(input.value));
      },
    },
    presentation: {
      async getLaunchIntent() {
        return {
          entry: 'home',
        };
      },
      async requestGameSurface() {
        return 'already-fullscreen';
      },
    },
  };
}

function unavailableReward() {
  return {
    status: 'unavailable' as const,
    rewardGranted: false,
  };
}

function createDefaultAuthClient(): Verse8AuthClient {
  return {
    getUser(options) {
      return Verse8.getUser(options);
    },
  };
}

function resolveVerse8Identity(authClient: Verse8AuthClient): ResolvedVerse8Identity {
  try {
    const credential = authClient.getUser({ requireTrustedSigner: true });

    return createResolvedIdentity(credential, 'authenticated', 'server-verified');
  } catch {
    try {
      const credential = authClient.getUser();

      return createResolvedIdentity(credential, 'platform-anonymous', 'platform-asserted');
    } catch {
      return {
        player: null,
        session: {
          identityLevel: 'guest',
          trustLevel: 'local',
        },
      };
    }
  }
}

function createResolvedIdentity(
  credential: Verse8Credential,
  identityLevel: IdentitySession['identityLevel'],
  trustLevel: IdentitySession['trustLevel'],
): ResolvedVerse8Identity {
  return {
    player: {
      playerId: credential.account,
    },
    session: {
      identityLevel,
      playerId: credential.account,
      trustLevel,
    },
  };
}

function storageKey(authClient: Verse8AuthClient, key: string): string {
  const playerId = resolveVerse8Identity(authClient).player?.playerId;
  const identityNamespace = playerId === undefined ? 'guest' : playerId.toLowerCase();

  return `mpgd:verse8:${identityNamespace}:${key}`;
}

function resolveStorage(): Verse8Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function resolveVisibilitySource(): Verse8VisibilitySource | undefined {
  return typeof document === 'undefined' ? undefined : document;
}
