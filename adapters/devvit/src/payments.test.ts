import { describe, expect, it, vi } from 'vitest';

import type { Entitlement, ProductInfo } from '@mpgd/platform';

import { createDevvitCommerceAdapter } from './payments';

const product = Object.freeze({
  id: 'FINAL_NINE_EMBER_THEME',
  type: 'non_consumable',
  title: 'Final Nine: Ember',
  description: 'A durable cosmetic theme.',
  price: Object.freeze({
    formatted: '5 Gold',
    currencyCode: 'XRG',
  }),
}) satisfies ProductInfo;
const entitlement = Object.freeze({
  id: 'cosmetic.final-nine.ember',
  source: 'purchase',
  grantedAt: '2026-07-15T00:00:00.000Z',
}) satisfies Entitlement;

describe('Devvit commerce adapter', () => {
  it('maps logical products to SKUs without granting from checkout results', async () => {
    const purchase = vi.fn(async () => ({
      status: 'completed' as const,
      orderId: 'order-1',
    }));
    const adapter = createDevvitCommerceAdapter({
      products: [{ info: product, sku: 'ttokdoku_final_nine_ember' }],
      client: {
        purchase,
        async getEntitlements() {
          return [entitlement];
        },
      },
    });

    await expect(adapter.getProducts()).resolves.toEqual([product]);
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-1',
    })).resolves.toEqual({
      status: 'completed',
      transactionId: 'order-1',
      entitlementIds: [],
    });
    expect(purchase).toHaveBeenCalledWith('ttokdoku_final_nine_ember', {
      logicalProductId: product.id,
      source: 'shop',
      operationId: 'checkout-1',
    });
    await expect(adapter.getEntitlements()).resolves.toEqual([entitlement]);
    await expect(adapter.restore?.()).resolves.toEqual({ restoredEntitlements: [entitlement] });
  });

  it('fails unknown products without starting checkout', async () => {
    const purchase = vi.fn();
    const adapter = createDevvitCommerceAdapter({
      products: [{ info: product, sku: 'ttokdoku_final_nine_ember' }],
      client: {
        purchase,
        async getEntitlements() {
          return [];
        },
      },
    });

    await expect(adapter.purchase({
      productId: 'UNKNOWN_PRODUCT',
      source: 'shop',
      idempotencyKey: 'checkout-2',
    })).resolves.toEqual({ status: 'failed', entitlementIds: [] });
    expect(purchase).not.toHaveBeenCalled();
  });

  it('reports checkout failures but does not hide entitlement read failures', async () => {
    const checkoutError = new Error('checkout unavailable');
    const entitlementError = new Error('authoritative read unavailable');
    const onCheckoutError = vi.fn();
    const adapter = createDevvitCommerceAdapter({
      products: [{ info: product, sku: 'ttokdoku_final_nine_ember' }],
      client: {
        async purchase() {
          throw checkoutError;
        },
        async getEntitlements() {
          throw entitlementError;
        },
      },
      onCheckoutError,
    });

    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-3',
    })).resolves.toEqual({ status: 'failed', entitlementIds: [] });
    expect(onCheckoutError).toHaveBeenCalledWith(checkoutError);
    await expect(adapter.getEntitlements()).rejects.toBe(entitlementError);
  });

  it('rejects duplicate logical products and SKUs', () => {
    const client = {
      async purchase() {
        return { status: 'cancelled' as const };
      },
      async getEntitlements() {
        return [];
      },
    };

    expect(() => createDevvitCommerceAdapter({
      products: [
        { info: product, sku: 'first' },
        { info: product, sku: 'second' },
      ],
      client,
    })).toThrow('Duplicate Devvit logical product ID');
    expect(() => createDevvitCommerceAdapter({
      products: [
        { info: product, sku: 'same' },
        { info: { ...product, id: 'OTHER_PRODUCT' }, sku: 'same' },
      ],
      client,
    })).toThrow('Duplicate Devvit product SKU');
  });
});
