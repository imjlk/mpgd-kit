import { describe, expect, it } from 'vitest';

import type { ProductCatalog } from '@mpgd/catalog';

import { createVerse8Agent8CommerceService, type Verse8Agent8Context } from './agent8';

const catalog = {
  version: 'test',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: { verse8: 'coins-100' },
    },
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { verse8: 'remove-ads' },
    },
  ],
} satisfies ProductCatalog;

describe('Verse8 Agent8 commerce service', () => {
  it('applies a platform purchase once and ignores client metadata grant values', async () => {
    const fixture = createContext();
    const service = createVerse8Agent8CommerceService({
      catalog,
      now: () => '2026-07-16T00:00:00.000Z',
    });
    const event = {
      account: '0xplayer',
      purchaseId: 42,
      productId: 'coins-100',
      quantity: 2,
      metadata: { amount: 999_999 },
    };

    await expect(service.handleItemPurchased(event, fixture.context)).resolves.toEqual({
      success: true,
      alreadyProcessed: false,
      purchaseId: '42',
      logicalProductId: 'COINS_100',
      entitlementIds: [],
    });
    await expect(service.handleItemPurchased(event, fixture.context)).resolves.toEqual({
      success: true,
      alreadyProcessed: true,
      purchaseId: '42',
      logicalProductId: 'COINS_100',
      entitlementIds: [],
    });
    const retiredProductService = createVerse8Agent8CommerceService({
      catalog: {
        ...catalog,
        products: catalog.products.filter((product) => product.id !== 'COINS_100'),
      },
    });
    await expect(
      retiredProductService.handleItemPurchased(event, fixture.context),
    ).resolves.toEqual({
      success: true,
      alreadyProcessed: true,
      purchaseId: '42',
      logicalProductId: 'COINS_100',
      entitlementIds: [],
    });

    expect(fixture.updates).toHaveLength(1);
    expect(fixture.states.get('0xplayer')).toMatchObject({
      mpgdVerse8Commerce: {
        balances: { coin: 200, gem: 0 },
        purchasesById: {
          42: {
            purchaseId: '42',
            platformProductId: 'coins-100',
            logicalProductId: 'COINS_100',
            quantity: 2,
          },
        },
      },
    });
    await expect(service.getSnapshot('0xplayer', fixture.context)).resolves.toEqual({
      balances: { coin: 200, gem: 0 },
      entitlements: [],
    });
  });

  it('stores an entitlement and its purchase marker in the same state update', async () => {
    const fixture = createContext();
    const service = createVerse8Agent8CommerceService({
      catalog,
      now: () => '2026-07-16T00:00:00.000Z',
    });

    await service.handleItemPurchased({
      account: '0xplayer',
      purchaseId: 7,
      productId: 'remove-ads',
      quantity: 1,
    }, fixture.context);

    await expect(service.getEntitlements('0xplayer', fixture.context)).resolves.toEqual([{
      id: 'remove_ads',
      source: 'purchase',
      grantedAt: '2026-07-16T00:00:00.000Z',
    }]);
    expect(fixture.updates).toHaveLength(1);
    expect(fixture.updates[0]).toMatchObject({
      mpgdVerse8Commerce: {
        entitlements: [{ id: 'remove_ads' }],
        purchasesById: {
          7: { purchaseId: '7', entitlementIds: ['remove_ads'] },
        },
      },
    });
  });

  it('rejects unknown products, invalid quantities, and purchase ID collisions', async () => {
    const fixture = createContext();
    const service = createVerse8Agent8CommerceService({ catalog });

    await expect(service.handleItemPurchased({
      account: '0xplayer',
      purchaseId: 1,
      productId: 'unknown',
      quantity: 1,
    }, fixture.context)).rejects.toThrow('Unknown Verse8 VXShop product');
    await expect(service.handleItemPurchased({
      account: '0xplayer',
      purchaseId: 1,
      productId: 'coins-100',
      quantity: 0,
    }, fixture.context)).rejects.toThrow('quantity must be a positive safe integer');
    await expect(service.handleItemPurchased({
      account: '0xplayer',
      purchaseId: 2,
      productId: 'remove-ads',
      quantity: 2,
    }, fixture.context)).rejects.toThrow('entitlement purchases must have quantity 1');
    expect(fixture.updates).toHaveLength(0);

    await service.handleItemPurchased({
      account: '0xplayer',
      purchaseId: 1,
      productId: 'coins-100',
      quantity: 1,
    }, fixture.context);
    await expect(service.handleItemPurchased({
      account: '0xplayer',
      purchaseId: 1,
      productId: 'remove-ads',
      quantity: 1,
    }, fixture.context)).rejects.toThrow('purchase ID was reused');
  });

  it('fails closed when stored idempotency state is malformed', async () => {
    const fixture = createContext();
    fixture.states.set('0xplayer', {
      mpgdVerse8Commerce: {
        version: 1,
        balances: { coin: 0, gem: 0 },
        entitlements: [],
        purchasesById: { 42: { purchaseId: 'different' } },
      },
    });
    const service = createVerse8Agent8CommerceService({ catalog });

    await expect(service.handleItemPurchased({
      account: '0xplayer',
      purchaseId: 43,
      productId: 'coins-100',
      quantity: 1,
    }, fixture.context)).rejects.toThrow('Stored Verse8 commerce state is invalid');
    expect(fixture.updates).toHaveLength(0);
  });

  it('serializes concurrent retries and applies one grant', async () => {
    const fixture = createContext();
    const service = createVerse8Agent8CommerceService({ catalog });
    const event = {
      account: '0xplayer',
      purchaseId: 99,
      productId: 'coins-100',
      quantity: 1,
    };

    const results = await Promise.all([
      service.handleItemPurchased(event, fixture.context),
      service.handleItemPurchased(event, fixture.context),
    ]);

    expect(results.map((result) => result.alreadyProcessed)).toEqual([false, true]);
    expect(fixture.updates).toHaveLength(1);
    await expect(service.getSnapshot('0xplayer', fixture.context)).resolves.toEqual({
      balances: { coin: 100, gem: 0 },
      entitlements: [],
    });
  });
});

function createContext(): {
  readonly context: Verse8Agent8Context;
  readonly states: Map<string, Readonly<Record<string, unknown>>>;
  readonly updates: Readonly<Record<string, unknown>>[];
} {
  const states = new Map<string, Readonly<Record<string, unknown>>>();
  const updates: Readonly<Record<string, unknown>>[] = [];
  const lockTails = new Map<string, Promise<void>>();

  return {
    states,
    updates,
    context: {
      async getUserState(account) {
        return states.get(account) ?? {};
      },
      async updateUserState(account, patch) {
        const next = { ...states.get(account), ...patch };
        states.set(account, next);
        updates.push(patch);
        return next;
      },
      async lock(key, callback) {
        const previous = lockTails.get(key) ?? Promise.resolve();
        let release = () => {};
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = previous.then(() => current);
        lockTails.set(key, tail);

        await previous;

        try {
          return await callback();
        } finally {
          release();

          if (lockTails.get(key) === tail) {
            lockTails.delete(key);
          }
        }
      },
    },
  };
}
