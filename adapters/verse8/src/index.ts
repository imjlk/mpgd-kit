import {
  Verse8Ads,
  type InterstitialAdResult as Verse8InterstitialAdResult,
  type RewardedAdResult as Verse8RewardedAdResult,
} from '@verse8/ads';
import { Verse8, VXShop } from '@verse8/platform/vanilla';

import type { ProductCatalog } from '@mpgd/catalog';
import {
  createUnsupportedCapabilities,
  type CommerceAdapter,
  type Entitlement,
  type IdentitySession,
  type LogicalAdPlacementId,
  type LogicalProductId,
  type PlatformGateway,
  type PlayerIdentity,
  type ProductType,
  type StorageAdapter,
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

/**
 * Game-owned Agent8 RPC wrapper. The adapter deliberately does not import the
 * React-based Agent8 browser SDK.
 */
export interface Verse8Agent8StorageClient extends StorageAdapter {}

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

export interface Verse8VXShopItem {
  readonly productId: string;
  readonly name: string;
  readonly description: string;
  readonly price: number;
  readonly purchasable: boolean;
  readonly purchaseLimitReached: boolean;
}

export interface Verse8VXShopClient {
  init(options?: {
    readonly verseId?: string;
    readonly account?: string;
    readonly autoRefresh?: boolean;
  }): void;
  getItem(productId: string): Verse8VXShopItem | undefined;
  getItems(): readonly Verse8VXShopItem[];
  buyItem(productId: string): void;
  refresh(): Promise<void>;
}

export interface Verse8CommerceProduct {
  readonly id: LogicalProductId;
  readonly type: ProductType;
  readonly platformProductId: string;
}

export interface Verse8CommerceOptions {
  /**
   * Explicitly acknowledges that grants are handled only by Verse8's reserved
   * Agent8 `$onItemPurchased` server event, never by the client dialog callback.
   */
  readonly purchaseEventAuthority: 'agent8-server';
  readonly products: readonly Verse8CommerceProduct[];
  readonly loadEntitlements: () => Promise<readonly Entitlement[]>;
  readonly client?: Verse8VXShopClient;
  readonly init?: {
    readonly verseId?: string;
    readonly account?: string;
    readonly autoRefresh?: boolean;
  };
  readonly canOpenShop?: () => boolean;
}

export function createVerse8CommerceProducts(
  catalog: ProductCatalog,
): readonly Verse8CommerceProduct[] {
  return normalizeCommerceProducts(
    catalog.products.flatMap((product) => {
      const platformProductId = product.platformProductIds.verse8;

      return platformProductId === undefined || product.grant.type === 'resource'
        ? []
        : [
            {
              id: product.id,
              type: product.type,
              platformProductId,
            },
          ];
    }),
  );
}

export interface Verse8PlatformGatewayOptions {
  readonly authClient?: Verse8AuthClient;
  readonly adsClient?: Verse8AdsClient;
  readonly adsTimeoutMs?: number;
  readonly resolveAdPlacementId?: (placementId: LogicalAdPlacementId) => string | undefined;
  readonly vxShop?: Verse8CommerceOptions;
  readonly agent8Storage?: Verse8Agent8StorageClient;
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
  const commerce = createVerse8Commerce(options.vxShop);
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
        nativeIap: commerce !== undefined,
        nativeAds: adsAvailable,
        rewardedAds: adsAvailable,
        interstitialAds: adsAvailable,
        cloudSave: options.agent8Storage !== undefined,
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
    commerce: commerce ?? createUnavailableVerse8Commerce(),
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
        if (options.agent8Storage !== undefined) {
          return options.agent8Storage.load(input);
        }

        const storage = options.storage ?? resolveStorage();
        const value = storage?.getItem(storageKey(authClient, input.key));

        return value === undefined || value === null
          ? null
          : { value: JSON.parse(value) as unknown };
      },
      async save(input) {
        if (options.agent8Storage !== undefined) {
          await options.agent8Storage.save(input);
          return;
        }

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

function createVerse8Commerce(
  options: Verse8CommerceOptions | undefined,
): CommerceAdapter | undefined {
  if (options === undefined) {
    return undefined;
  }

  if (options.purchaseEventAuthority !== 'agent8-server' || options.products.length === 0) {
    return undefined;
  }

  const products = normalizeCommerceProducts(options.products);
  const client = options.client ?? VXShop;
  let initialized = false;

  const ensureInitialized = () => {
    if (initialized) {
      return;
    }

    if (options.init === undefined) {
      client.init({ autoRefresh: false });
    } else {
      client.init({ ...options.init, autoRefresh: false });
    }
    initialized = true;
  };

  const loadEntitlements = async (): Promise<readonly Entitlement[]> => {
    try {
      return [...await options.loadEntitlements()];
    } catch {
      return [];
    }
  };

  return {
    async getProducts() {
      try {
        ensureInitialized();
        await client.refresh();
        const shopItems = new Map(client.getItems().map((item) => [item.productId, item]));

        return products.flatMap((product) => {
          const item = shopItems.get(product.platformProductId);

          return item === undefined
            ? []
            : [{
                id: product.id,
                type: product.type,
                title: item.name,
                description: item.description,
                price: {
                  formatted: `${item.price} VX`,
                  currencyCode: 'VX',
                },
              }];
        });
      } catch {
        return [];
      }
    },
    async purchase(input) {
      const product = products.find((candidate) => candidate.id === input.productId);

      if (product === undefined) {
        return failedPurchase();
      }

      try {
        if (!(options.canOpenShop ?? canOpenDefaultVerse8Shop)()) {
          return failedPurchase();
        }

        ensureInitialized();
        await client.refresh();
        const item = client.getItem(product.platformProductId);

        if (
          item === undefined
          || item.purchasable !== true
          || item.purchaseLimitReached === true
        ) {
          return failedPurchase();
        }

        client.buyItem(product.platformProductId);

        return {
          status: 'pending',
          entitlementIds: [],
        };
      } catch {
        return failedPurchase();
      }
    },
    async restore() {
      return {
        restoredEntitlements: await loadEntitlements(),
      };
    },
    getEntitlements: loadEntitlements,
  };
}

function normalizeCommerceProducts(
  products: readonly Verse8CommerceProduct[],
): readonly Verse8CommerceProduct[] {
  const logicalIds = new Set<string>();
  const platformIds = new Set<string>();

  return products.map((product) => {
    const platformProductId = product.platformProductId.trim();

    if (product.id.trim().length === 0 || platformProductId.length === 0) {
      throw new Error('Verse8 commerce product IDs must be non-empty.');
    }

    if (logicalIds.has(product.id) || platformIds.has(platformProductId)) {
      throw new Error('Verse8 commerce product IDs must be unique.');
    }

    logicalIds.add(product.id);
    platformIds.add(platformProductId);

    return {
      ...product,
      platformProductId,
    };
  });
}

function createUnavailableVerse8Commerce(): CommerceAdapter {
  return {
    async getProducts() {
      return [];
    },
    async purchase() {
      return failedPurchase();
    },
    async getEntitlements() {
      return [];
    },
  };
}

function failedPurchase() {
  return {
    status: 'failed' as const,
    entitlementIds: [],
  };
}

function canOpenDefaultVerse8Shop(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
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
