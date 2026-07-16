import { describe, expect, it } from 'vitest';

import {
  createVerse8CommerceProducts,
  createVerse8PlatformGateway,
  type Verse8AdsClient,
  type Verse8AuthClient,
  type Verse8VisibilitySource,
  type Verse8VXShopClient,
} from './index';

const credential = {
  account: '0x1234567890abcdef' as const,
  verse: 'production',
  exp: 4_000_000_000,
};

describe('adapter-verse8', () => {
  it('derives VXShop mappings only from catalog products configured for Verse8', () => {
    expect(createVerse8CommerceProducts({
      version: 'test',
      products: [{
        id: 'COINS_100',
        type: 'consumable',
        grant: { type: 'currency', currency: 'coin', amount: 100 },
        platformProductIds: { verse8: 'coins-100' },
      }, {
        id: 'REMOVE_ADS',
        type: 'non_consumable',
        grant: { type: 'entitlement', entitlement: 'remove_ads' },
        platformProductIds: { android: 'remove_ads' },
      }],
    })).toEqual([{
      id: 'COINS_100',
      type: 'consumable',
      platformProductId: 'coins-100',
    }]);
  });

  it('exposes Verse8 host ads while keeping unimplemented capabilities unavailable', async () => {
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      resolveAdPlacementId() {
        return 'verse8-placement';
      },
    });

    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: false,
      nativeAds: true,
      rewardedAds: true,
      interstitialAds: true,
      nativeLeaderboard: false,
      cloudSave: false,
      localizedContent: true,
    });
    expect(gateway.target).toBe('verse8');
    expect(gateway.sharing).toBeUndefined();
    expect(gateway.notifications).toBeUndefined();
  });

  it('maps Verse8 signer credentials to a server-verified identity', async () => {
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: credential.account,
    });
    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'authenticated',
      playerId: credential.account,
      trustLevel: 'server-verified',
    });
  });

  it('maps a verified self-signed credential to platform-anonymous identity', async () => {
    const authClient: Verse8AuthClient = {
      getUser(options) {
        if (options?.requireTrustedSigner === true) {
          throw new Error('not signed by the trusted Verse8 signer');
        }

        return credential;
      },
    };
    const gateway = createVerse8PlatformGateway({ authClient });

    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'platform-anonymous',
      playerId: credential.account,
      trustLevel: 'platform-asserted',
    });
  });

  it('falls back to a local guest when the auth credential is unusable', async () => {
    const gateway = createVerse8PlatformGateway({
      authClient: {
        getUser() {
          throw new Error('missing auth token');
        },
      },
    });

    await expect(gateway.identity.getPlayer()).resolves.toBeNull();
    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'guest',
      trustLevel: 'local',
    });
  });

  it('keeps commerce, unmapped ads, and leaderboard unavailable', async () => {
    const gateway = createVerse8PlatformGateway({ authClient: authenticatedClient() });

    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
    });

    await expect(
      gateway.commerce.purchase({
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'purchase-1',
      }),
    ).resolves.toEqual({ status: 'failed', entitlementIds: [] });
    await expect(
      gateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'reward-1',
      }),
    ).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
    await expect(
      gateway.leaderboard.submitScore({
        leaderboardId: 'default',
        score: 1,
        runId: 'run-1',
        submittedAt: new Date().toISOString(),
      }),
    ).resolves.toEqual({ submitted: false });
  });

  it('opens VXShop as pending while entitlements remain Agent8-server authoritative', async () => {
    const shopCalls: unknown[] = [];
    const shop = createShopClient(shopCalls);
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      vxShop: {
        purchaseEventAuthority: 'agent8-server',
        products: [{
          id: 'REMOVE_ADS',
          type: 'non_consumable',
          platformProductId: 'remove-ads',
        }],
        async loadEntitlements() {
          return [{
            id: 'remove_ads',
            source: 'purchase',
            grantedAt: '2026-07-16T00:00:00.000Z',
          }];
        },
        client: shop,
        canOpenShop: () => true,
      },
    });

    await expect(gateway.getCapabilities()).resolves.toMatchObject({ nativeIap: true });
    await expect(gateway.commerce.getProducts()).resolves.toEqual([{
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      title: 'Remove Ads',
      description: 'Remove advertisements.',
      price: {
        formatted: '100 VX',
        currencyCode: 'VX',
      },
    }]);
    await expect(gateway.commerce.purchase({
      productId: 'REMOVE_ADS',
      source: 'shop',
      idempotencyKey: 'purchase-1',
    })).resolves.toEqual({
      status: 'pending',
      entitlementIds: [],
    });
    await expect(gateway.commerce.getEntitlements()).resolves.toEqual([{
      id: 'remove_ads',
      source: 'purchase',
      grantedAt: '2026-07-16T00:00:00.000Z',
    }]);
    expect(shopCalls).toEqual([
      ['init', { autoRefresh: false }],
      ['refresh'],
      ['refresh'],
      ['buyItem', 'remove-ads'],
    ]);
  });

  it('fails closed when VXShop cannot open or the configured product is unavailable', async () => {
    const shop = createShopClient([]);
    const baseOptions = {
      purchaseEventAuthority: 'agent8-server' as const,
      products: [{
        id: 'REMOVE_ADS',
        type: 'non_consumable' as const,
        platformProductId: 'remove-ads',
      }],
      async loadEntitlements() {
        return [];
      },
      client: shop,
    };
    const standaloneGateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      vxShop: {
        ...baseOptions,
        canOpenShop: () => false,
      },
    });

    await expect(standaloneGateway.commerce.purchase({
      productId: 'REMOVE_ADS',
      source: 'shop',
      idempotencyKey: 'purchase-standalone',
    })).resolves.toEqual({ status: 'failed', entitlementIds: [] });

    const throwingAvailabilityGateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      vxShop: {
        ...baseOptions,
        canOpenShop() {
          throw new Error('host inspection failed');
        },
      },
    });

    await expect(throwingAvailabilityGateway.commerce.purchase({
      productId: 'REMOVE_ADS',
      source: 'shop',
      idempotencyKey: 'purchase-host-error',
    })).resolves.toEqual({ status: 'failed', entitlementIds: [] });

    const missingProductGateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      vxShop: {
        ...baseOptions,
        products: [{
          id: 'COINS_100',
          type: 'consumable',
          platformProductId: 'missing-product',
        }],
        canOpenShop: () => true,
      },
    });

    await expect(missingProductGateway.commerce.purchase({
      productId: 'COINS_100',
      source: 'shop',
      idempotencyKey: 'purchase-missing',
    })).resolves.toEqual({ status: 'failed', entitlementIds: [] });
  });

  it('turns rewarded callbacks into evidence candidates without trusting reward values', async () => {
    const calls: unknown[] = [];
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      adsClient: createAdsClient({
        async showRewarded(input) {
          calls.push(input);
          return {
            status: 'rewarded',
            requestId: 'verse8-request-1',
            reward: {
              amount: 999_999,
              type: 'untrusted-client-value',
            },
            platform: 'web',
          };
        },
      }),
      adsTimeoutMs: 12_000,
      resolveAdPlacementId(placementId) {
        return placementId === 'CONTINUE_AFTER_FAIL' ? 'rewarded_continue' : undefined;
      },
    });

    await expect(
      gateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'reward-1',
      }),
    ).resolves.toEqual({
      status: 'completed',
      rewardGranted: true,
      ledgerEntryId: 'verse8-request-1',
      evidence: {
        schema: 'verse8.ads.reward.v1',
        payload: {
          requestId: 'verse8-request-1',
          placementId: 'rewarded_continue',
          platform: 'web',
        },
      },
    });
    expect(calls).toEqual([
      {
        placementId: 'rewarded_continue',
        timeoutMs: 12_000,
        meta: {
          logicalPlacementId: 'CONTINUE_AFTER_FAIL',
        },
      },
    ]);
  });

  it('maps dismissed and unsupported host outcomes without producing grant evidence', async () => {
    const dismissedGateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      adsClient: createAdsClient({
        async showRewarded() {
          return {
            status: 'dismissed',
            requestId: 'dismissed-request',
          };
        },
        async showInterstitial() {
          return {
            status: 'dismissed',
            requestId: 'interstitial-request',
          };
        },
      }),
      resolveAdPlacementId() {
        return 'verse8-placement';
      },
    });

    await expect(
      dismissedGateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'dismissed',
      }),
    ).resolves.toEqual({ status: 'skipped', rewardGranted: false });
    await expect(
      dismissedGateway.ads.showInterstitial?.({
        placementId: 'STAGE_END_INTERSTITIAL',
      }),
    ).resolves.toEqual({ status: 'shown' });

    const unsupportedGateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      adsClient: createAdsClient({
        async showRewarded() {
          return {
            status: 'failed',
            requestId: 'unsupported-request',
            error: { code: 'unsupported_env' },
          };
        },
      }),
      resolveAdPlacementId() {
        return 'verse8-placement';
      },
    });

    await expect(
      unsupportedGateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'unsupported',
      }),
    ).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
  });

  it('persists local data with a Verse8-specific namespace', async () => {
    const values = new Map<string, string>();
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      storage: {
        getItem(key) {
          return values.get(key) ?? null;
        },
        setItem(key, value) {
          values.set(key, value);
        },
      },
    });

    await gateway.storage.save({ key: 'save:v1', value: { coins: 25 } });

    expect(values.get(`mpgd:verse8:${credential.account}:save:v1`)).toBe('{"coins":25}');
    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
      value: { coins: 25 },
    });

    const guestGateway = createVerse8PlatformGateway({
      authClient: {
        getUser() {
          throw new Error('missing auth token');
        },
      },
      storage: {
        getItem(key) {
          return values.get(key) ?? null;
        },
        setItem(key, value) {
          values.set(key, value);
        },
      },
    });

    await guestGateway.storage.save({ key: 'save:v1', value: { coins: 0 } });

    expect(values.get('mpgd:verse8:guest:save:v1')).toBe('{"coins":0}');
    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
      value: { coins: 25 },
    });
  });

  it('translates iframe visibility changes into lifecycle events', () => {
    let listener: (() => void) | undefined;
    let hidden = false;
    const visibility: Verse8VisibilitySource = {
      get hidden() {
        return hidden;
      },
      addEventListener(_type, callback) {
        listener = callback;
      },
      removeEventListener() {},
    };
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      visibility,
    });
    const calls: string[] = [];

    gateway.lifecycle.onPause(() => calls.push('pause'));
    gateway.lifecycle.onResume(() => calls.push('resume'));
    hidden = true;
    listener?.();
    hidden = false;
    listener?.();

    expect(calls).toEqual(['pause', 'resume']);
  });
});

function authenticatedClient(): Verse8AuthClient {
  return {
    getUser() {
      return credential;
    },
  };
}

function createAdsClient(
  overrides: Partial<Verse8AdsClient> = {},
): Verse8AdsClient {
  return {
    async showRewarded() {
      return {
        status: 'failed',
        requestId: 'default-rewarded-request',
        error: { code: 'platform_error' },
      };
    },
    async showInterstitial() {
      return {
        status: 'failed',
        requestId: 'default-interstitial-request',
        error: { code: 'platform_error' },
      };
    },
    ...overrides,
  };
}

function createShopClient(calls: unknown[]): Verse8VXShopClient {
  const item = {
    productId: 'remove-ads',
    name: 'Remove Ads',
    description: 'Remove advertisements.',
    price: 100,
    purchasable: true,
    purchaseLimitReached: false,
  };

  return {
    init(options) {
      calls.push(['init', options]);
    },
    getItem(productId) {
      return productId === item.productId ? item : undefined;
    },
    getItems() {
      return [item];
    },
    buyItem(productId) {
      calls.push(['buyItem', productId]);
    },
    async refresh() {
      calls.push(['refresh']);
    },
  };
}
