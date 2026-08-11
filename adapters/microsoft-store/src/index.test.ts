import { describe, expect, it, vi } from 'vitest';

import type { Entitlement, PlatformGateway, ProductInfo } from '@mpgd/platform';

import {
  createMicrosoftStoreCommerceAdapter,
  microsoftStoreBillingMethod,
  microsoftStoreDigitalGoodsEvidenceSchema,
  withMicrosoftStoreCommerceAdapter,
} from './index';

const product = Object.freeze({
  id: 'HINT_PACK_20',
  type: 'consumable',
  title: '20 hints',
  description: 'Adds 20 hints.',
  price: Object.freeze({ formatted: '$0.99', currencyCode: 'USD' }),
}) satisfies ProductInfo;
const entitlement = Object.freeze({
  id: 'hint-balance',
  source: 'purchase',
  grantedAt: '2026-08-11T00:00:00.000Z',
}) satisfies Entitlement;

describe('Microsoft Store Digital Goods commerce', () => {
  it('uses localized Store details and delegates fulfillment before reporting completion', async () => {
    const complete = vi.fn(async () => {});
    const verifyAndGrant = vi.fn(async () => ({
      status: 'completed' as const,
      transactionId: 'ledger-1',
    }));
    const createPaymentRequest = vi.fn(() => ({
      async show() {
        return { details: { purchaseToken: 'ttokdoku_hint_pack_20' }, complete };
      },
    }));
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        verifyAndGrant,
        async getEntitlements() {
          return [entitlement];
        },
      },
      async getDigitalGoodsService() {
        return {
          async getDetails() {
            return [{
              itemId: 'ttokdoku_hint_pack_20',
              title: 'Hint Pack: 20',
              description: 'Store description',
              price: { currency: 'USD', value: '0.99' },
            }];
          },
          async listPurchases() {
            return [{
              itemId: 'ttokdoku_hint_pack_20',
              purchaseToken: 'ttokdoku_hint_pack_20',
            }];
          },
        };
      },
      createPaymentRequest,
      locale: 'en-US',
    });

    await expect(adapter.getProducts()).resolves.toEqual([{
      ...product,
      title: 'Hint Pack: 20',
      description: 'Store description',
      price: { formatted: '$0.99', currencyCode: 'USD' },
    }]);
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-1',
    })).resolves.toEqual({
      status: 'completed',
      transactionId: 'ledger-1',
      entitlementIds: [],
      evidence: {
        schema: microsoftStoreDigitalGoodsEvidenceSchema,
        payload: {
          itemId: 'ttokdoku_hint_pack_20',
          purchaseToken: 'ttokdoku_hint_pack_20',
        },
      },
    });
    expect(createPaymentRequest).toHaveBeenCalledWith([{
      supportedMethods: microsoftStoreBillingMethod,
      data: { sku: 'ttokdoku_hint_pack_20' },
    }]);
    expect(complete).toHaveBeenCalledWith('success');
    expect(verifyAndGrant).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'HINT_PACK_20',
      inAppOfferToken: 'ttokdoku_hint_pack_20',
      purchaseToken: 'ttokdoku_hint_pack_20',
      idempotencyKey: 'checkout-1',
    }));
  });

  it('fails closed when authoritative fulfillment is not configured', async () => {
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'configuration-required';
        },
        async verifyAndGrant() {
          throw new Error('must not run');
        },
        async getEntitlements() {
          return [];
        },
      },
      async getDigitalGoodsService() {
        throw new Error('must not run');
      },
    });

    await expect(adapter.getAvailability()).resolves.toBe('configuration-required');
    await expect(adapter.getProducts()).resolves.toEqual([]);
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-2',
    })).resolves.toEqual({ status: 'failed', entitlementIds: [] });
  });

  it('recovers unconsumed Store purchases through the same authority boundary', async () => {
    const verifyAndGrant = vi.fn(async () => ({
      status: 'completed' as const,
      transactionId: 'ledger-recovered',
    }));
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        verifyAndGrant,
        async getEntitlements() {
          return [entitlement];
        },
      },
      async getDigitalGoodsService() {
        return {
          async getDetails() {
            return [];
          },
          async listPurchases() {
            return [{
              itemId: 'ttokdoku_hint_pack_20',
              purchaseToken: 'ttokdoku_hint_pack_20',
            }];
          },
        };
      },
      createRecoveryId: () => 'recovery-1',
    });

    await expect(adapter.restore?.()).resolves.toEqual({
      restoredEntitlements: [entitlement],
    });
    expect(verifyAndGrant).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'recovery-1',
      source: 'recovery',
    }));
  });

  it('maps user cancellation without calling the authority', async () => {
    const verifyAndGrant = vi.fn();
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        verifyAndGrant,
        async getEntitlements() {
          return [];
        },
      },
      async getDigitalGoodsService() {
        return {
          async getDetails() {
            return [{
              itemId: 'ttokdoku_hint_pack_20',
              title: '20 hints',
              price: { currency: 'USD', value: '0.99' },
            }];
          },
          async listPurchases() {
            return [];
          },
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            throw new DOMException('cancelled', 'AbortError');
          },
        };
      },
    });

    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-3',
    })).resolves.toEqual({ status: 'cancelled', entitlementIds: [] });
    expect(verifyAndGrant).not.toHaveBeenCalled();
  });

  it('only installs on a first-class Microsoft Store gateway', async () => {
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async verifyAndGrant() {
          return { status: 'pending' };
        },
        async getEntitlements() {
          return [];
        },
      },
      async getDigitalGoodsService() {
        return {
          async getDetails() {
            return [];
          },
          async listPurchases() {
            return [];
          },
        };
      },
    });

    const gateway = withMicrosoftStoreCommerceAdapter(createGateway('microsoft-store'), adapter);
    await expect(gateway.getCapabilities()).resolves.toMatchObject({ nativeIap: true });
    expect(() => withMicrosoftStoreCommerceAdapter(createGateway('browser'), adapter))
      .toThrow('only be installed on a microsoft-store gateway');
  });
});

function createGateway(target: PlatformGateway['target']): PlatformGateway {
  return {
    target,
    async getCapabilities() {
      return {
        nativeIap: false,
        nativeAds: false,
        rewardedAds: false,
        interstitialAds: false,
        nativeLeaderboard: false,
        achievements: false,
        cloudSave: true,
        socialShare: true,
        haptics: false,
        localizedContent: true,
      };
    },
    identity: {
      async getPlayer() {
        return null;
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        return { status: 'cancelled', entitlementIds: [] };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded() {
        return { status: 'unavailable', rewardGranted: false };
      },
    },
    leaderboard: {
      async submitScore() {
        return { submitted: false };
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
