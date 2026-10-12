import { describe, expect, it } from 'vitest';

import { extractAitIapProductConfig } from './iap-config';

describe('extractAitIapProductConfig', () => {
  it('maps one-time products that name an Apps in Toss SKU', () => {
    expect(extractAitIapProductConfig({
      version: '1',
      products: [
        {
          id: 'COINS_100',
          type: 'consumable',
          grant: { type: 'currency', currency: 'coin', amount: 100 },
          platformProductIds: { android: 'coins_100', ait: 'coins_100' },
        },
        {
          id: 'REMOVE_ADS',
          type: 'non_consumable',
          grant: { type: 'entitlement', entitlement: 'remove_ads' },
          platformProductIds: { ait: 'remove_ads' },
        },
        {
          id: 'WEB_ONLY',
          type: 'consumable',
          grant: { type: 'currency', currency: 'coin', amount: 1 },
          platformProductIds: { android: 'web_only' },
        },
        {
          id: 'MEMBERSHIP',
          type: 'subscription',
          grant: { type: 'entitlement', entitlement: 'member' },
          platformProductIds: { ait: 'membership' },
        },
      ],
    })).toEqual([
      { productId: 'COINS_100', sku: 'coins_100' },
      { productId: 'REMOVE_ADS', sku: 'remove_ads' },
    ]);
  });

  it('reads SKUs the way the catalog does: trimmed, blank as unsold', () => {
    expect(extractAitIapProductConfig({
      products: [
        { id: 'A', type: 'consumable', platformProductIds: { ait: ' a ' } },
        { id: 'B', type: 'consumable', platformProductIds: { ait: '  ' } },
        { id: 'C', type: 'consumable', platformProductIds: { ait: '' } },
      ],
    })).toEqual([{ productId: 'A', sku: 'a' }]);
    expect(() => extractAitIapProductConfig({
      products: [
        { id: 'A', type: 'consumable', platformProductIds: { ait: 'same' } },
        { id: 'B', type: 'consumable', platformProductIds: { ait: ' same' } },
      ],
    })).toThrow(/Duplicate AIT SKU "same"/u);
  });

  it('rejects invalid catalogs and SKUs', () => {
    expect(() => extractAitIapProductConfig(null, { sourceLabel: 'x.json' }))
      .toThrow(/catalog is invalid: x\.json/u);
    expect(() => extractAitIapProductConfig({ products: [{ type: 'consumable' }] }))
      .toThrow(/entry at index 0 is invalid/u);
    expect(() => extractAitIapProductConfig({
      products: [
        { id: 'A', type: 'consumable', platformProductIds: { ait: 'same' } },
        { id: 'B', type: 'consumable', platformProductIds: { ait: 'same' } },
      ],
    })).toThrow(/Duplicate AIT SKU/u);
    expect(() => extractAitIapProductConfig({
      products: [
        { id: 'A', type: 'consumable', platformProductIds: { ait: 'a' } },
        { id: 'A', type: 'consumable', platformProductIds: { ait: 'b' } },
      ],
    })).toThrow(/Duplicate AIT product ID/u);
  });
});
