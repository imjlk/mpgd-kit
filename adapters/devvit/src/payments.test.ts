import { describe, expect, it } from 'vitest';

import type { ProductInfo } from '@mpgd/platform';

import { normalizeDevvitCommerceProducts } from './payments';

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

describe('Devvit commerce products', () => {
  it('freezes copies of the configured products', () => {
    const info = { ...product };
    const products = normalizeDevvitCommerceProducts([{ info, sku: 'ttokdoku_final_nine_ember' }]);

    expect(products).toEqual([{ info: product, sku: 'ttokdoku_final_nine_ember' }]);
    expect(Object.isFrozen(products)).toBe(true);
    expect(Object.isFrozen(products[0])).toBe(true);
    expect(Object.isFrozen(products[0]?.info)).toBe(true);
    expect(products[0]?.info).not.toBe(info);
  });

  it('rejects duplicate logical products and SKUs', () => {
    expect(() => normalizeDevvitCommerceProducts([
      { info: product, sku: 'first' },
      { info: product, sku: 'second' },
    ])).toThrow('Duplicate Devvit logical product ID');
    expect(() => normalizeDevvitCommerceProducts([
      { info: product, sku: 'same' },
      { info: { ...product, id: 'OTHER_PRODUCT' }, sku: 'same' },
    ])).toThrow('Duplicate Devvit product SKU');
  });

  it('rejects blank and padded SKUs', () => {
    expect(() => normalizeDevvitCommerceProducts([{ info: product, sku: '' }]))
      .toThrow('non-empty identifier');
    expect(() => normalizeDevvitCommerceProducts([{ info: product, sku: ' padded ' }]))
      .toThrow('non-empty identifier');
  });

  it('exports no v1 commerce adapter any more', async () => {
    const payments = await import('./payments');
    const adapter = await import('./index');

    for (const name of ['createDevvitCommerceAdapter', 'withDevvitCommerceAdapter']) {
      expect(payments).not.toHaveProperty(name);
      expect(adapter).not.toHaveProperty(name);
    }
  });
});
