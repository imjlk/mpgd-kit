import {
  createUnsupportedCapabilities,
  type IdentitySession,
  type LaunchEntry,
  type LaunchIntent,
  type PlatformGateway,
  type PlayerIdentity,
  type ProductInfo,
  type ShareIntent,
} from '@mpgd/platform';

const mockProducts = [
  {
    id: 'COINS_100',
    type: 'consumable',
    title: '100 Coins',
    description: 'Adds 100 demo coins.',
    price: {
      formatted: '$0.99',
      currencyCode: 'USD',
    },
  },
] as const satisfies readonly ProductInfo[];

export interface BrowserPlatformGatewayOptions {
  readonly locationHref?: string;
  readonly share?: (data: ShareData) => Promise<void>;
  readonly writeClipboardText?: (text: string) => Promise<void>;
  /** Override browser storage for embedded runtimes and deterministic tests. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export function createBrowserPlatformGateway(
  options: BrowserPlatformGatewayOptions = {},
): PlatformGateway {
  const pauseListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();
  const shareSupported = canShare(options);

  if (typeof document !== 'undefined') {
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
        rewardedAds: true,
        interstitialAds: true,
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
    commerce: {
      async getProducts() {
        return mockProducts;
      },
      async purchase() {
        return {
          status: 'completed',
          transactionId: `browser-purchase-${crypto.randomUUID()}`,
          entitlementIds: ['COINS_100'],
        };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded() {
        return {
          status: 'completed',
          rewardGranted: true,
          ledgerEntryId: `browser-reward-${crypto.randomUUID()}`,
        };
      },
      async showInterstitial() {
        return {
          status: 'unavailable',
        };
      },
    },
    leaderboard: {
      async submitScore() {
        return {
          submitted: true,
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
  const share = options.share ?? globalThis.navigator?.share?.bind(globalThis.navigator);

  if (share !== undefined) {
    try {
      await share({
        title: intent.title,
        text: intent.text,
        url: intent.deepLink,
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
    await writeClipboardText(`${intent.text}\n${intent.deepLink}`);
    return { status: 'shared' } as const;
  } catch {
    return { status: 'unavailable' } as const;
  }
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
