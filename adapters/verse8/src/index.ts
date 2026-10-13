import {
  Verse8Ads,
  type InterstitialAdResult as Verse8InterstitialAdResult,
  type RewardedAdResult as Verse8RewardedAdResult,
} from '@verse8/ads';
import { Verse8, VXShop } from '@verse8/platform/vanilla';

import { resolveProductPlatformId, type CatalogTarget, type ProductCatalog } from '@mpgd/catalog';
import {
  createUnsupportedCapabilities,
  type IdentitySession,
  type LogicalAdPlacementId,
  type LogicalProductId,
  type PlatformGateway,
  type PlayerIdentity,
  type ProductType,
  type StorageAdapter,
} from '@mpgd/platform';

import { createVerse8AdProvider, type Verse8AdPresentationSource } from './ad-provider.js';
import { toAdAdapter } from '@mpgd/platform/ads';
import type { CommerceProvider } from '@mpgd/platform/commerce';
import { defaultVerse8CatalogTarget } from './catalog-target.js';
import {
  createVerse8CommerceProvider,
  type Verse8CommerceDialogClosedPayload,
  type Verse8PurchasesChangeListener,
  type Verse8PurchaseSource,
} from './commerce-provider.js';

export { verse8AdsRewardEvidenceSchema } from './ads-contract.js';
export type { Verse8AdPresentationEvent, Verse8AdPresentationSource } from './ad-provider.js';
export * from './commerce-contract.js';
export * from './commerce-provider.js';

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
    readonly requestId?: string;
    readonly meta?: Record<string, unknown>;
  }): Promise<Verse8RewardedAdResult>;
  showInterstitial(input: {
    readonly placementId: string;
    readonly timeoutMs?: number;
    readonly requestId?: string;
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
  /** The dialog closing; the commerce provider treats `purchased` as a signal to re-read the server. */
  onClose?(callback: (payload: Verse8CommerceDialogClosedPayload) => void): () => void;
}

export interface Verse8CommerceProduct {
  readonly id: LogicalProductId;
  readonly type: ProductType;
  readonly platformProductId: string;
}

/**
 * Installs the commerce provider (`createVerse8CommerceProvider`) as the
 * gateway's `commerce`, with its `commerce` capability block. Without
 * `vxShop`, or with an unacknowledged authority, no product, or no purchase
 * source, the gateway sells nothing: it has no `commerce` and reports
 * `createUnsupportedCommerceCapabilities()`.
 */
export interface Verse8CommerceOptions {
  /**
   * Explicitly acknowledges that grants are handled only by Verse8's reserved
   * Agent8 `$onItemPurchased` server event, never by the client dialog callback.
   */
  readonly purchaseEventAuthority: 'agent8-server';
  readonly products: readonly Verse8CommerceProduct[];
  /**
   * Commerce profile `verse8`: the purchases the Agent8 server recorded, read
   * through a game-owned authenticated method (`listPurchases` of
   * `createVerse8Agent8CommerceService`). VXShop reports no purchase id to the
   * iframe, so this is the only source of a transaction id; the backend's
   * `verse8.agent8-event.v1` lookup verifier answers the reconciler's verify
   * request from the ledger entry the Agent8 service writes. Owned entitlements
   * come from that ledger through `@mpgd/game-services`, not from the client.
   */
  readonly purchases: Verse8PurchaseSource;
  readonly client?: Verse8VXShopClient;
  readonly init?: {
    readonly verseId?: string;
    readonly account?: string;
    readonly autoRefresh?: boolean;
  };
  readonly canOpenShop?: () => boolean;
  /** Signal that the recorded purchases may have changed; defaults to the VXShop dialog closing after a purchase. */
  readonly onPurchasesChanged?: (listener: Verse8PurchasesChangeListener) => () => void;
}

export function createVerse8CommerceProducts(
  catalog: ProductCatalog,
  target: CatalogTarget = defaultVerse8CatalogTarget,
): readonly Verse8CommerceProduct[] {
  return normalizeCommerceProducts(
    catalog.products.flatMap((product) => {
      const platformProductId = resolveProductPlatformId(product, target);

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
  /** Required for rewarded v2: SDK 0.4 reward completion does not prove native closure. */
  readonly adPresentation?: Verse8AdPresentationSource;
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
  const ads = toAdAdapter(
    createVerse8AdProvider({
      client: adsClient,
      ...(options.resolveAdPlacementId === undefined ? {} : { resolvePlacement: options.resolveAdPlacementId }),
      ...(options.adPresentation === undefined ? {} : { presentation: options.adPresentation }),
      ...(options.adsTimeoutMs === undefined ? {} : { timeoutMs: options.adsTimeoutMs }),
    }),
  );
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
      const capabilities = {
        // Includes the unsupported commerce block, a fresh object per read.
        ...createUnsupportedCapabilities(),
        nativeAds: adsAvailable,
        rewardedAds: adsAvailable,
        interstitialAds: adsAvailable,
        cloudSave: options.agent8Storage !== undefined,
        localizedContent: true,
      };
      if (commerce === undefined) {
        return capabilities;
      }
      // The provider owns the block (fresh on every read).
      return { ...capabilities, commerce: await commerce.getCapabilities() };
    },
    identity: {
      async getPlayer() {
        return resolveVerse8Identity(authClient).player;
      },
      async getSession() {
        return resolveVerse8Identity(authClient).session;
      },
    },
    ...(commerce === undefined ? {} : { commerce }),
    ads,
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

        const storage = resolveStorage(options.storage);
        const value = storage.getItem(storageKey(authClient, input.key));

        return value === undefined || value === null
          ? null
          : { value: JSON.parse(value) as unknown };
      },
      async save(input) {
        if (options.agent8Storage !== undefined) {
          await options.agent8Storage.save(input);
          return;
        }

        resolveStorage(options.storage).setItem(
          storageKey(authClient, input.key),
          serializeStorageValue(input.value),
        );
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

/**
 * The commerce provider over the VXShop client and the catalog products,
 * offered only when the Agent8 purchase source is configured.
 */
function createVerse8Commerce(
  options: Verse8CommerceOptions | undefined,
): CommerceProvider | undefined {
  if (
    options === undefined
    || options.purchaseEventAuthority !== 'agent8-server'
    || options.products.length === 0
    || options.purchases === undefined
  ) {
    return undefined;
  }
  return createVerse8CommerceProvider({
    products: options.products,
    client: options.client ?? VXShop,
    purchases: options.purchases,
    ...(options.init === undefined ? {} : { init: options.init }),
    ...(options.canOpenShop === undefined ? {} : { canOpenShop: options.canOpenShop }),
    ...(options.onPurchasesChanged === undefined
      ? {}
      : { onPurchasesChanged: options.onPurchasesChanged }),
  });
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

function resolveStorage(override: Verse8Storage | undefined): Verse8Storage {
  if (override !== undefined) {
    return override;
  }

  try {
    if (globalThis.localStorage !== undefined) {
      return globalThis.localStorage;
    }
  } catch {
    // Access to browser storage can be denied by the embedding environment.
  }

  throw new Error('Verse8 local storage is unavailable.');
}

function serializeStorageValue(value: unknown): string {
  const serialized = JSON.stringify(value);

  if (typeof serialized !== 'string') {
    throw new Error('Verse8 local storage values must be JSON serializable.');
  }

  return serialized;
}

function resolveVisibilitySource(): Verse8VisibilitySource | undefined {
  return typeof document === 'undefined' ? undefined : document;
}
