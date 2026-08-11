import { describe, expect, it, vi } from 'vitest';

import type { Entitlement, PlatformGateway, ProductInfo } from '@mpgd/platform';

import {
  createMicrosoftStoreCommerceAdapter,
  microsoftStoreBillingMethod,
  microsoftStoreDigitalGoodsEvidenceSchema,
  withMicrosoftStoreCommerceAdapter,
} from './microsoft-store';

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
    const events: string[] = [];
    const complete = vi.fn(async (status?: 'success' | 'fail' | 'unknown') => {
      events.push(`complete:${status}`);
    });
    const verifyAndGrant = vi.fn(async () => {
      events.push('authority');
      return {
        status: 'completed' as const,
        transactionId: 'ledger-1',
        alreadyProcessed: true,
      };
    });
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
    const purchase = adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-1',
    });
    expect(createPaymentRequest).toHaveBeenCalledOnce();
    await expect(purchase).resolves.toEqual({
      status: 'completed',
      transactionId: 'ledger-1',
      authoritativeGrant: { ledgerEntryId: 'ledger-1', alreadyProcessed: true },
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
    expect(events).toEqual(['authority', 'complete:success']);
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

  it('rejects empty Store price values instead of presenting them as free', async () => {
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async verifyAndGrant() {
          throw new Error('must not run');
        },
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
              price: { currency: 'USD', value: ' \n ' },
            }];
          },
          async listPurchases() {
            return [];
          },
        };
      },
    });

    await expect(adapter.getProducts()).resolves.toEqual([]);
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-invalid-price',
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

  it('reconciles independent unconsumed products concurrently', async () => {
    const secondProduct = Object.freeze({
      ...product,
      id: 'HINT_PACK_120',
      title: '120 hints',
    }) satisfies ProductInfo;
    let releaseAuthority: (() => void) | undefined;
    const authorityGate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const verifyAndGrant = vi.fn(async (input: { readonly productId: string }) => {
      await authorityGate;
      return {
        status: 'completed' as const,
        transactionId: `ledger-${input.productId}`,
      };
    });
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [
        { info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' },
        { info: secondProduct, inAppOfferToken: 'ttokdoku_hint_pack_120' },
      ],
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
            return [
              {
                itemId: 'ttokdoku_hint_pack_20',
                purchaseToken: 'ttokdoku_hint_pack_20',
              },
              {
                itemId: 'ttokdoku_hint_pack_120',
                purchaseToken: 'ttokdoku_hint_pack_120',
              },
            ];
          },
        };
      },
      createRecoveryId: () => crypto.randomUUID(),
    });

    const restoration = adapter.restore?.();
    expect(restoration).toBeDefined();
    await vi.waitFor(() => {
      expect(verifyAndGrant).toHaveBeenCalledTimes(2);
    });
    releaseAuthority?.();
    await expect(restoration).resolves.toEqual({ restoredEntitlements: [entitlement] });
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

    await adapter.getProducts();
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-3',
    })).resolves.toEqual({ status: 'cancelled', entitlementIds: [] });
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-3-retry',
    })).resolves.toEqual({ status: 'cancelled', entitlementIds: [] });
    expect(verifyAndGrant).not.toHaveBeenCalled();
  });

  it('reports reconciliation pending without completing a paid response twice', async () => {
    const complete = vi.fn(async () => {});
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async verifyAndGrant() {
          throw new Error('must not run');
        },
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
            throw new Error('Store ownership has not propagated yet');
          },
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            return { details: { purchaseToken: 'ttokdoku_hint_pack_20' }, complete };
          },
        };
      },
    });

    await adapter.getProducts();
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-pending',
    })).resolves.toEqual({
      status: 'pending',
      entitlementIds: [],
      evidence: {
        schema: microsoftStoreDigitalGoodsEvidenceSchema,
        payload: {
          itemId: 'ttokdoku_hint_pack_20',
          purchaseToken: 'ttokdoku_hint_pack_20',
        },
      },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('unknown');
  });

  it('dismisses the paid response even when the error reporter throws', async () => {
    const complete = vi.fn(async () => {});
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async verifyAndGrant() {
          throw new Error('must not run');
        },
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
            throw new Error('ownership unavailable');
          },
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            return { details: { purchaseToken: 'ttokdoku_hint_pack_20' }, complete };
          },
        };
      },
      onError() {
        throw new Error('reporter failed');
      },
    });

    await adapter.getProducts();
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-throwing-reporter',
    })).rejects.toThrow('reporter failed');
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith('unknown');
  });

  it('reports failed authoritative fulfillment to the payment UI', async () => {
    const complete = vi.fn(async () => {});
    const adapter = createMicrosoftStoreCommerceAdapter({
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async verifyAndGrant() {
          return { status: 'failed' };
        },
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
            return [{
              itemId: 'ttokdoku_hint_pack_20',
              purchaseToken: 'ttokdoku_hint_pack_20',
            }];
          },
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            return { details: { purchaseToken: 'ttokdoku_hint_pack_20' }, complete };
          },
        };
      },
    });

    await adapter.getProducts();
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-failed-authority',
    })).resolves.toMatchObject({ status: 'failed' });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith('fail');
  });

  it('recovers a paid purchase when the PaymentResponse omits its token', async () => {
    const complete = vi.fn(async () => {});
    const verifyAndGrant = vi.fn(async () => ({
      status: 'completed' as const,
      transactionId: 'ledger-recovered-response',
    }));
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
            return [{
              itemId: 'ttokdoku_hint_pack_20',
              purchaseToken: 'ttokdoku_hint_pack_20',
            }];
          },
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            return { details: {}, complete };
          },
        };
      },
    });

    await adapter.getProducts();
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-missing-response-token',
    })).resolves.toMatchObject({
      status: 'completed',
      transactionId: 'ledger-recovered-response',
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith('success');
    expect(verifyAndGrant).toHaveBeenCalledWith(expect.objectContaining({
      purchaseToken: 'ttokdoku_hint_pack_20',
    }));
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
