import {
  createUnsupportedCapabilities,
  type PlatformGateway,
  type PlayerIdentity,
  type ProductInfo,
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

export function createBrowserPlatformGateway(): PlatformGateway {
  const pauseListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();

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
        cloudSave: true,
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
        if (typeof localStorage === 'undefined') {
          return null;
        }

        const value = localStorage.getItem(`mpgd:${input.key}`);
        return value === null ? null : { value: JSON.parse(value) };
      },
      async save(input) {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`mpgd:${input.key}`, JSON.stringify(input.value));
        }
      },
    },
  };
}
