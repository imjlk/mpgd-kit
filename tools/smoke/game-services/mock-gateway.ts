import {
  createUnsupportedCapabilities,
  type PlatformGateway,
  type PlatformTarget,
  type ProductInfo,
  type PurchaseResult,
  type RewardedAdResult,
} from '@mpgd/platform';

export function createCapableMockGateway(input: {
  readonly target: Extract<PlatformTarget, 'android' | 'ios' | 'ait'>;
  readonly playerId: string;
  readonly purchaseResult?: PurchaseResult;
  readonly rewardedAdResult?: RewardedAdResult;
  readonly leaderboardSubmitted?: boolean;
}): PlatformGateway {
  const product = {
    id: 'COINS_100',
    type: 'consumable',
    title: '100 Coins',
    description: 'Adds 100 coins.',
    price: {
      formatted: '$0.99',
      currencyCode: 'USD',
    },
  } as const satisfies ProductInfo;

  return {
    target: input.target,
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        nativeIap: true,
        nativeAds: true,
        rewardedAds: true,
        interstitialAds: true,
        nativeLeaderboard: true,
      };
    },
    identity: {
      async getPlayer() {
        return {
          playerId: input.playerId,
        };
      },
    },
    commerce: {
      async getProducts() {
        return [product];
      },
      async purchase(payload) {
        return input.purchaseResult ?? {
          status: 'completed',
          transactionId: `${input.target}-txn-${payload.idempotencyKey}`,
          entitlementIds: [],
        };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded(payload) {
        return input.rewardedAdResult ?? {
          status: 'completed',
          rewardGranted: true,
          ledgerEntryId: `${input.target}-impression-${payload.idempotencyKey}`,
        };
      },
      async showInterstitial() {
        return {
          status: 'shown',
        };
      },
    },
    leaderboard: {
      async submitScore() {
        return {
          submitted: input.leaderboardSubmitted ?? true,
        };
      },
      async open() {},
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  };
}
