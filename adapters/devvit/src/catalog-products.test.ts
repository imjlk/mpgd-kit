import { describe, expect, it } from 'vitest';

import {
  createDevvitCommerceBridgeProducts,
  createDevvitCommerceProducts,
} from './catalog-products';

const catalog = {
  products: [
    {
      id: 'COINS_100',
      type: 'consumable' as const,
      platformProductIds: { android: 'coins_100', reddit: 'coins_100' },
    },
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable' as const,
      platformProductIds: { reddit: 'remove_ads' },
    },
    {
      id: 'WEB_ONLY',
      type: 'consumable' as const,
      platformProductIds: { android: 'web_only' },
    },
    {
      id: 'MEMBERSHIP',
      type: 'subscription' as const,
      platformProductIds: { reddit: 'membership' },
    },
  ],
};

describe('createDevvitCommerceBridgeProducts', () => {
  it('pairs each one-time product that names a Reddit SKU with it', () => {
    expect(createDevvitCommerceBridgeProducts(catalog)).toEqual([
      { productId: 'COINS_100', sku: 'coins_100' },
      { productId: 'REMOVE_ADS', sku: 'remove_ads' },
    ]);
    expect(createDevvitCommerceBridgeProducts(catalog, 'android')).toEqual([
      { productId: 'COINS_100', sku: 'coins_100' },
      { productId: 'WEB_ONLY', sku: 'web_only' },
    ]);
  });

  it('reads SKUs the way the catalog does and rejects duplicates', () => {
    expect(createDevvitCommerceBridgeProducts({
      products: [
        { id: 'A', type: 'consumable', platformProductIds: { reddit: ' a ' } },
        { id: 'B', type: 'consumable', platformProductIds: { reddit: ' ' } },
      ],
    })).toEqual([{ productId: 'A', sku: 'a' }]);
    expect(() => createDevvitCommerceBridgeProducts({
      products: [
        { id: 'A', type: 'consumable', platformProductIds: { reddit: 'same' } },
        { id: 'B', type: 'consumable', platformProductIds: { reddit: 'same' } },
      ],
    })).toThrow(/Duplicate Devvit product SKU/u);
  });
});

describe('createDevvitCommerceProducts', () => {
  it('derives the webview products from the same SKUs with placeholder info', () => {
    const products = createDevvitCommerceProducts(catalog);
    expect(products.map((product) => product.sku)).toEqual(['coins_100', 'remove_ads']);
    expect(products[0]?.info).toEqual({
      id: 'COINS_100',
      type: 'consumable',
      title: 'COINS_100',
      description: '',
      price: { formatted: 'Reddit Gold', currencyCode: 'GOLD' },
    });
  });

  it('accepts game-owned copy', () => {
    const products = createDevvitCommerceProducts(catalog, {
      describe: (product, sku) => ({
        title: `${product.id}/${sku}`,
        description: 'd',
        price: { formatted: '100 Gold', currencyCode: 'GOLD' },
      }),
    });
    expect(products[1]?.info.title).toBe('REMOVE_ADS/remove_ads');
  });
});
