import {
  createUnsupportedCapabilities,
  type CommerceCapabilities,
  type PlatformGateway,
  type PlatformTarget,
  type RewardedAdResult,
} from '@mpgd/platform';
import type { CommerceProvider, RequestPurchaseResult } from '@mpgd/platform/commerce';

/**
 * A gateway whose commerce is a v2 provider: the game-services client buys
 * through the reconciler, so the smoke exercises the one purchase path.
 */
export function createCapableMockGateway(input: {
  readonly target: Extract<PlatformTarget, 'android' | 'ios' | 'ait'>;
  readonly playerId: string;
  /** The store's answer to a checkout; defaults to a synchronous `purchased` answer. */
  readonly purchaseOutcome?: RequestPurchaseResult;
  readonly rewardedAdResult?: RewardedAdResult;
  readonly leaderboardSubmitted?: boolean;
}): PlatformGateway {
  const store = `${input.target}-mock-store`;
  const commerceCapabilities: CommerceCapabilities = {
    purchase: { consumable: true, durable: false, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: false,
      events: true,
      finish: 'none',
    },
    authority: { evidence: 'client-token', accountBinding: 'optional' },
    availability: 'available',
  };
  const commerce: CommerceProvider = {
    store,
    async getCapabilities() {
      return structuredClone(commerceCapabilities);
    },
    async fetchProducts() {
      return [
        {
          logicalId: 'COINS_100',
          store,
          storeSku: 'coins_100',
          kind: 'consumable',
          title: '100 Coins',
          description: 'Adds 100 coins.',
          price: {
            formatted: '$0.99',
            currencyCode: 'USD',
          },
        },
      ];
    },
    async requestPurchase(request) {
      return input.purchaseOutcome ?? {
        outcome: 'purchased',
        purchase: {
          store,
          transactionId: `${input.target}-txn-${request.idempotencyKey}`,
          storeSku: 'coins_100',
          logicalId: request.logicalId,
          quantity: 1,
          state: 'purchased',
          token: `${input.target}-token-${request.idempotencyKey}`,
          evidence: {
            schema: 'mpgd.smoke.purchase.v1',
            payload: { token: `${input.target}-token-${request.idempotencyKey}` },
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

  return {
    target: input.target,
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        nativeAds: true,
        rewardedAds: true,
        interstitialAds: true,
        nativeLeaderboard: true,
        commerce: structuredClone(commerceCapabilities),
      };
    },
    identity: {
      async getPlayer() {
        return {
          playerId: input.playerId,
        };
      },
    },
    commerce,
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
