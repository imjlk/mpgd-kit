import {
  createUnsupportedCapabilities,
  type AdAdapter,
  type CommerceCapabilities,
  type IdentitySession,
  type LaunchEntry,
  type LaunchIntent,
  type LifecycleAdapter,
  type PlatformGateway,
  type PlayerIdentity,
  type ShareIntent,
} from '@mpgd/platform';
import type {
  CommerceProvider,
  RequestPurchaseResult,
  StoreProduct,
} from '@mpgd/platform/commerce';
import {
  hasNetworkPathPrefix,
  hasRouteControlCharacter,
  normalizeRootRelativeRoute,
} from '@mpgd/platform/routes';

import { createUnavailableAdAdapter } from './unavailable-ads.js';

export { createUnavailableAdAdapter } from './unavailable-ads.js';

/** Evidence schema attached to a `mockCommerce` purchase. Not accepted by any backend claim. */
export const browserMockPurchaseEvidenceSchema = 'mpgd.browser.mock-purchase.v1';
/** Evidence schema attached to a `mockCommerce` rewarded-ad result. Not accepted by any backend claim. */
export const browserMockRewardEvidenceSchema = 'mpgd.browser.mock-reward.v1';

/** Store id of the `mockCommerce` storefront. No backend registry routes it. */
export const browserMockCommerceStoreId = 'browser-mock';

const mockProductId = 'COINS_100';

export interface BrowserPlatformGatewayOptions {
  /** Supply a lifecycle owner when embedding the browser adapter. */
  readonly lifecycle?: LifecycleAdapter;
  readonly locationHref?: string;
  readonly share?: (data: ShareData) => Promise<void>;
  readonly writeClipboardText?: (text: string) => Promise<void>;
  /** Override browser storage for embedded runtimes and deterministic tests. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /**
   * Opt in to a local-demo mock storefront: a sample catalog and evidence-only
   * results. `gateway.commerce` becomes a commerce v2 provider (store id
   * `browser-mock`, one consumable `COINS_100`) whose `requestPurchase`
   * answers `purchased` with a mock `transactionId` and `token` and a
   * `mpgd.browser.mock-purchase.v1` evidence envelope; `showRewarded()`
   * resolves `status: 'completed', rewardGranted: false` with no
   * `ledgerEntryId` and a `mpgd.browser.mock-reward.v1` envelope. Neither
   * schema is accepted by backend claim APIs, so no code path in this adapter
   * can grant: even an accidentally shipped opt-in only exercises the UI flow.
   *
   * Off by default. Without it the gateway has no `commerce` provider, reports
   * the unsupported commerce capability block and ads as unavailable, so a
   * gateway built from this adapter (including Microsoft Store builds that
   * reuse it as a base) cannot be mistaken for a ledger authority.
   */
  readonly mockCommerce?: boolean;
}

export function createBrowserPlatformGateway(
  options: BrowserPlatformGatewayOptions = {},
): PlatformGateway {
  const pauseListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();
  const shareSupported = canShare(options);
  const mockCommerce = options.mockCommerce === true;
  const commerce = mockCommerce ? createMockCommerceProvider() : undefined;

  if (options.lifecycle === undefined && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      const listeners = document.hidden ? pauseListeners : resumeListeners;

      for (const listener of listeners) {
        listener();
      }
    });
  }

  return {
    target: 'browser',
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        // A fresh copy per read; the default gateway sells nothing and keeps
        // the unsupported block from createUnsupportedCapabilities().
        ...(commerce === undefined ? {} : { commerce: await commerce.getCapabilities() }),
        rewardedAds: mockCommerce,
        interstitialAds: mockCommerce,
        cloudSave: tryResolveBrowserStorage(options.storage) !== undefined,
        socialShare: shareSupported,
        localizedContent: true,
      };
    },
    identity: {
      async getPlayer(): Promise<PlayerIdentity> {
        return {
          playerId: 'browser-player',
          displayName: 'Browser Player',
        };
      },
      async getSession(): Promise<IdentitySession> {
        return {
          identityLevel: 'guest',
          playerId: 'browser-player',
          trustLevel: 'local',
        };
      },
      async requestUpgrade() {
        return {
          status: 'unavailable',
          reloadExpected: false,
        };
      },
    },
    presentation: {
      async getLaunchIntent() {
        return launchIntentFromUrl(resolveBrowserUrl(options.locationHref));
      },
      async requestGameSurface() {
        return 'already-fullscreen';
      },
    },
    sharing: {
      ...(shareSupported
        ? {
            async share(intent: ShareIntent) {
              return shareFromBrowser(intent, options);
            },
          }
        : {}),
      async readInboundShare() {
        return inboundShareFromUrl(resolveBrowserUrl(options.locationHref));
      },
    },
    notifications: {
      async getStatus() {
        return 'unsupported';
      },
      async requestSubscription() {
        return 'unavailable';
      },
    },
    ...(commerce === undefined ? {} : { commerce }),
    ads: mockCommerce ? createMockAds() : createUnavailableAdAdapter(),
    leaderboard: {
      async submitScore() {
        return {
          submitted: true,
        };
      },
      async open() {},
    },
    lifecycle: options.lifecycle ?? {
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
        const value = resolveBrowserStorage(options.storage).getItem(`mpgd:${input.key}`);
        return value === null ? null : { value: JSON.parse(value) };
      },
      async save(input) {
        resolveBrowserStorage(options.storage).setItem(
          `mpgd:${input.key}`,
          serializeBrowserStorageValue(input.value),
        );
      },
    },
  };
}

/**
 * Local-demo only: a one-product commerce v2 provider whose checkout answers
 * `purchased` as UI evidence. The `mpgd.browser.mock-purchase.v1` envelope is
 * accepted by no backend registry, no purchase carries a `settlement`, and the
 * provider never finishes anything (`lifecycle.finish: 'none'`), so only a
 * backend ledger could credit a wallet and none will for this evidence.
 */
function createMockCommerceProvider(): CommerceProvider {
  const store = browserMockCommerceStoreId;
  const createProduct = (): StoreProduct => ({
    logicalId: mockProductId,
    store,
    storeSku: mockProductId,
    kind: 'consumable',
    title: '100 Coins',
    description: 'Adds 100 demo coins.',
    price: { formatted: '$0.99', currencyCode: 'USD', amountMicros: 990_000 },
  });

  return {
    store,
    async getCapabilities() {
      return createMockCommerceCapabilities();
    },
    async fetchProducts(input) {
      if (input.type === 'subscription') {
        return [];
      }
      const product = createProduct();
      return input.logicalIds === undefined || input.logicalIds.includes(product.logicalId)
        ? [product]
        : [];
    },
    async requestPurchase(input): Promise<RequestPurchaseResult> {
      if (input.logicalId !== mockProductId || (input.quantity !== undefined && input.quantity > 1)) {
        return {
          outcome: 'failed',
          error: {
            code: 'ITEM_UNAVAILABLE',
            retryable: false,
            message: `The browser mock storefront does not sell ${input.logicalId}.`,
          },
        };
      }
      const transactionId = `browser-purchase-${crypto.randomUUID()}`;
      return {
        outcome: 'purchased',
        purchase: {
          store,
          transactionId,
          storeSku: mockProductId,
          logicalId: mockProductId,
          quantity: 1,
          state: 'purchased',
          token: transactionId,
          evidence: {
            schema: browserMockPurchaseEvidenceSchema,
            payload: { productId: input.logicalId },
          },
        },
      };
    },
    async getAvailablePurchases() {
      return [];
    },
    subscribe() {
      return () => {};
    },
  };
}

function createMockCommerceCapabilities(): CommerceCapabilities {
  return {
    purchase: { consumable: true, durable: false, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: false },
    lifecycle: {
      availablePurchases: false,
      pending: false,
      restore: false,
      events: false,
      finish: 'none',
    },
    authority: { evidence: 'client-token', accountBinding: 'optional' },
    availability: 'available',
  };
}

/**
 * Local-demo only: completes a rewarded-ad flow as UI evidence without any ad
 * SDK. The result is never granted and never carries a `ledgerEntryId`.
 */
function createMockAds(): AdAdapter {
  return {
    async preload() {},
    async showRewarded(request) {
      return {
        status: 'completed',
        rewardGranted: false,
        evidence: {
          schema: browserMockRewardEvidenceSchema,
          payload: { placementId: request.placementId },
        },
      };
    },
    async showInterstitial() {
      return {
        status: 'unavailable',
      };
    },
  };
}

function resolveBrowserStorage(
  override: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): Pick<Storage, 'getItem' | 'setItem'> {
  const storage = tryResolveBrowserStorage(override);

  if (storage !== undefined) {
    return storage;
  }

  throw new Error('Browser storage is unavailable.');
}

function tryResolveBrowserStorage(
  override: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): Pick<Storage, 'getItem' | 'setItem'> | undefined {
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

  return undefined;
}

function serializeBrowserStorageValue(value: unknown): string {
  const serialized = JSON.stringify(value);

  if (typeof serialized !== 'string') {
    throw new Error('Browser storage values must be JSON serializable.');
  }

  return serialized;
}

const launchEntries = new Set<LaunchEntry>([
  'home',
  'daily',
  'practice',
  'free-play',
  'continue',
  'leaderboard',
  'friend-challenge',
]);

function launchIntentFromUrl(url: URL | undefined): LaunchIntent {
  const params = mergedSearchParams(url);
  const requestedEntry = params.get('entry');
  const inbound = inboundShareFromParams(params);
  let entry: LaunchEntry;

  if (requestedEntry !== null && launchEntries.has(requestedEntry as LaunchEntry)) {
    entry = requestedEntry as LaunchEntry;
  } else if (inbound?.challengeToken === undefined) {
    entry = 'home';
  } else {
    entry = 'friend-challenge';
  }

  return {
    entry,
    ...(inbound?.puzzleId === undefined ? {} : { puzzleId: inbound.puzzleId }),
    ...(inbound?.challengeToken === undefined
      ? {}
      : { referralToken: inbound.challengeToken }),
  };
}

function inboundShareFromUrl(url: URL | undefined) {
  return inboundShareFromParams(mergedSearchParams(url));
}

function inboundShareFromParams(params: URLSearchParams) {
  const puzzleId = nonEmptyParam(params.get('puzzleId'));
  const challengeToken = nonEmptyParam(params.get('challengeToken'));

  if (puzzleId === undefined && challengeToken === undefined) {
    return null;
  }

  return {
    ...(puzzleId === undefined ? {} : { puzzleId }),
    ...(challengeToken === undefined ? {} : { challengeToken }),
  };
}

function mergedSearchParams(url: URL | undefined): URLSearchParams {
  const params = new URLSearchParams(url?.search ?? '');
  const nestedParams = params.get('queryParams');

  if (nestedParams === null) {
    return params;
  }

  try {
    const parsed = JSON.parse(nestedParams) as unknown;

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && !params.has(key)) {
          params.set(key, value);
        }
      }
    }
  } catch {
    // Inbound query payloads are untrusted. Invalid nested data is ignored.
  }

  return params;
}

async function shareFromBrowser(
  intent: ShareIntent,
  options: BrowserPlatformGatewayOptions,
) {
  // The intent may come from untyped game code; answer like the other adapters.
  const candidate: unknown = intent;
  const text = isRecord(candidate) ? candidate['text'] : undefined;
  const url = isRecord(candidate) ? toShareableUrl(candidate['deepLink']) : undefined;

  if (typeof text !== 'string' || url === undefined) {
    return { status: 'unavailable' } as const;
  }

  const share = options.share ?? globalThis.navigator?.share?.bind(globalThis.navigator);

  if (share !== undefined) {
    try {
      await share({
        title: intent.title,
        text,
        url,
      });

      return { status: 'shared' } as const;
    } catch (error) {
      if (isAbortError(error)) {
        return { status: 'cancelled' } as const;
      }

      console.warn('Browser share failed; falling back to clipboard.', error);
    }
  }

  const writeClipboardText =
    options.writeClipboardText
    ?? globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);

  if (writeClipboardText === undefined) {
    return { status: 'unavailable' } as const;
  }

  try {
    await writeClipboardText(`${text}\n${url}`);
    return { status: 'shared' } as const;
  } catch {
    return { status: 'unavailable' } as const;
  }
}

/**
 * The link a browser share passes on, or `undefined` when it could reach
 * another host or is not a web link, following the `ShareIntent.deepLink`
 * contract. A root-relative link is normalized with `normalizeRootRelativeRoute`
 * from `@mpgd/platform/routes` and stays relative, so Web Share resolves it
 * against the document as before. An absolute link must spell out `http://` or
 * `https://`, carry no credentials, and keep a path no client can read as
 * another host. Page-relative links (`./daily`, `?x=1`) are refused, as on the
 * other targets.
 */
function toShareableUrl(deepLink: unknown): string | undefined {
  if (typeof deepLink !== 'string' || hasRouteControlCharacter(deepLink)) {
    return undefined;
  }

  if (deepLink.startsWith('/')) {
    return normalizeRootRelativeRoute(deepLink);
  }

  // `https:/daily` and `https:host/x` parse as absolute links to another host
  // without a base but resolve on the page with one, so only the full form counts.
  if (!/^https?:\/\//iu.test(deepLink)) {
    return undefined;
  }

  let parsed: URL;

  try {
    parsed = new URL(deepLink);
  } catch {
    return undefined;
  }

  return parsed.username === ''
    && parsed.password === ''
    && !hasNetworkPathPrefix(parsed.pathname)
    ? parsed.href
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canShare(options: BrowserPlatformGatewayOptions): boolean {
  return (
    options.share !== undefined
    || options.writeClipboardText !== undefined
    || typeof globalThis.navigator?.share === 'function'
    || typeof globalThis.navigator?.clipboard?.writeText === 'function'
  );
}

function resolveBrowserUrl(locationHref: string | undefined): URL | undefined {
  const href = locationHref ?? globalThis.location?.href;

  if (href === undefined) {
    return undefined;
  }

  try {
    return new URL(href);
  } catch {
    return undefined;
  }
}

function nonEmptyParam(value: string | null): string | undefined {
  return value === null || value.length === 0 ? undefined : value;
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object'
      && error !== null
      && (error as { readonly name?: unknown }).name === 'AbortError';
}
