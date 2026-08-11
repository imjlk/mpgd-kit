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
const getRecoveryScope = () => 'player-1';
const grantRecoveryOwnership = (input: { readonly idempotencyKey?: string }) => ({
  status: 'granted' as const,
  idempotencyKey: input.idempotencyKey ?? 'durable-recovery-id',
});
const allowRecoveryOwnership = Object.freeze({
  async claimRecoveryOwnership(input: { readonly idempotencyKey?: string }) {
    return grantRecoveryOwnership(input);
  },
  async hasRecoveryOwnership(input: { readonly idempotencyKey?: string }) {
    return grantRecoveryOwnership(input);
  },
});

function memoryRecoveryStorage(seed: readonly (readonly [string, string])[] = []) {
  const values = new Map(seed);
  return {
    values,
    storage: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
      removeItem(key: string) {
        values.delete(key);
      },
    },
  };
}

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
    const claimRecoveryOwnership = vi.fn(async (input: { readonly idempotencyKey?: string }) => (
      grantRecoveryOwnership(input)
    ));
    const createPaymentRequest = vi.fn(() => ({
      async show() {
        return { details: { purchaseToken: 'ttokdoku_hint_pack_20' }, complete };
      },
    }));
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        claimRecoveryOwnership,
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
    expect(claimRecoveryOwnership).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'HINT_PACK_20',
      inAppOfferToken: 'ttokdoku_hint_pack_20',
      purchaseToken: 'ttokdoku_hint_pack_20',
    }));
    expect(events).toEqual(['authority', 'complete:success']);
  });

  it('fails closed when authoritative fulfillment is not configured', async () => {
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
    const recovery = memoryRecoveryStorage();
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        async hasRecoveryOwnership(input: { readonly idempotencyKey?: string }) {
          return grantRecoveryOwnership(input);
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
      recoveryIdStorage: recovery.storage,
    });

    await expect(adapter.restore?.()).resolves.toEqual({
      restoredEntitlements: [entitlement],
    });
    expect(verifyAndGrant).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'durable-recovery-id',
      source: 'recovery',
    }));
  });

  it('reuses an exact pending identity after restart and an offer-token mapping change', async () => {
    const exactCheckoutIdempotencyKey = '  checkout-pending-consume  ';
    const legacyInAppOfferToken = 'ttokdoku_hint_pack_20_legacy';
    const currentInAppOfferToken = 'ttokdoku_hint_pack_20';
    const storedRecoveryIds = new Map<string, string>();
    const recoveryIdStorage = {
      getItem(key: string) {
        return storedRecoveryIds.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storedRecoveryIds.set(key, value);
      },
      removeItem(key: string) {
        storedRecoveryIds.delete(key);
      },
    };
    const storePurchase = {
      itemId: legacyInAppOfferToken,
      purchaseToken: legacyInAppOfferToken,
    } as const;
    const firstAuthority = vi.fn(async () => ({
      status: 'pending' as const,
      transactionId: 'ledger-pending-consume',
    }));
    const createService = () => ({
      async getDetails() {
        return [{
          itemId: legacyInAppOfferToken,
          title: '20 hints',
          price: { currency: 'USD', value: '0.99' },
        }];
      },
      async listPurchases() {
        return [storePurchase];
      },
    });
    const firstAdapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: legacyInAppOfferToken }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        verifyAndGrant: firstAuthority,
        async getEntitlements() {
          return [];
        },
      },
      async getDigitalGoodsService() {
        return createService();
      },
      createPaymentRequest() {
        return {
          async show() {
            return { details: { purchaseToken: legacyInAppOfferToken } };
          },
        };
      },
      recoveryIdStorage,
    });

    await firstAdapter.getProducts();
    await expect(firstAdapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: exactCheckoutIdempotencyKey,
    })).resolves.toMatchObject({ status: 'pending' });
    expect(firstAuthority).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: exactCheckoutIdempotencyKey,
    }));
    expect([...storedRecoveryIds.entries()]).toEqual([
      [
        'mpgd:microsoft-store:pending-grant:v3:player-1:HINT_PACK_20',
        JSON.stringify([{
          version: 1,
          idempotencyKey: exactCheckoutIdempotencyKey,
          inAppOfferToken: legacyInAppOfferToken,
          purchaseToken: legacyInAppOfferToken,
        }]),
      ],
    ]);

    const createRecoveryId = vi.fn(() => 'new-recovery-id');
    const resumedAuthority = vi.fn(async () => ({
      status: 'completed' as const,
      transactionId: 'ledger-pending-consume',
      alreadyProcessed: true,
    }));
    const restartedAdapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: currentInAppOfferToken }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        async hasRecoveryOwnership(input: { readonly idempotencyKey?: string }) {
          return grantRecoveryOwnership(input);
        },
        verifyAndGrant: resumedAuthority,
        async getEntitlements() {
          return [entitlement];
        },
      },
      async getDigitalGoodsService() {
        return {
          ...createService(),
          async listPurchases() {
            return [];
          },
        };
      },
      createRecoveryId,
      recoveryIdStorage,
    });

    await expect(restartedAdapter.restore?.()).resolves.toEqual({
      restoredEntitlements: [entitlement],
    });
    expect(resumedAuthority).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: exactCheckoutIdempotencyKey,
      inAppOfferToken: legacyInAppOfferToken,
      source: 'recovery',
      evidence: {
        schema: microsoftStoreDigitalGoodsEvidenceSchema,
        payload: {
          itemId: legacyInAppOfferToken,
          purchaseToken: legacyInAppOfferToken,
        },
      },
    }));
    expect(createRecoveryId).not.toHaveBeenCalled();
    expect(storedRecoveryIds.size).toBe(0);
  });

  it('retains recovery during an authority outage and removes it after a durable denial', async () => {
    const storageKey = 'mpgd:microsoft-store:pending-grant:v3:player-1:HINT_PACK_20';
    const recovery = memoryRecoveryStorage([[storageKey, JSON.stringify([{
      version: 1,
      idempotencyKey: 'pending-generation',
      inAppOfferToken: 'ttokdoku_hint_pack_20',
      purchaseToken: 'ttokdoku_hint_pack_20',
    }])]]);
    const verifyAndGrant = vi.fn();
    const createAdapter = (status: 'denied' | 'unavailable') => (
      createMicrosoftStoreCommerceAdapter({
        getRecoveryScope,
        products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
        authority: {
          ...allowRecoveryOwnership,
          async getAvailability() {
            return 'available';
          },
          async hasRecoveryOwnership() {
            return { status } as const;
          },
          verifyAndGrant,
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
        recoveryIdStorage: recovery.storage,
      })
    );

    await createAdapter('unavailable').restore?.();
    expect(recovery.values.has(storageKey)).toBe(true);
    expect(verifyAndGrant).not.toHaveBeenCalled();

    await createAdapter('denied').restore?.();
    expect(recovery.values.has(storageKey)).toBe(false);
    expect(verifyAndGrant).not.toHaveBeenCalled();
  });

  it('replaces a stale completed recovery key before granting a fresh consumable purchase', async () => {
    const storeIdentity = 'ttokdoku_hint_pack_20';
    const storageKey = 'mpgd:microsoft-store:pending-grant:v3:player-1:HINT_PACK_20';
    const values = new Map([[storageKey, JSON.stringify([{
      version: 1,
      idempotencyKey: 'completed-generation',
      inAppOfferToken: storeIdentity,
      purchaseToken: storeIdentity,
    }])]]);
    const verifyAndGrant = vi.fn(async () => ({
      status: 'completed' as const,
      transactionId: 'fresh-ledger-entry',
    }));
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: storeIdentity }],
      authority: {
        ...allowRecoveryOwnership,
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
              itemId: storeIdentity,
              title: '20 hints',
              price: { currency: 'USD', value: '0.99' },
            }];
          },
          async listPurchases() {
            return [{ itemId: storeIdentity, purchaseToken: storeIdentity }];
          },
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            return { details: { purchaseToken: storeIdentity } };
          },
        };
      },
      recoveryIdStorage: {
        getItem(key) {
          return values.get(key) ?? null;
        },
        setItem(key, value) {
          values.set(key, value);
        },
        removeItem() {
          throw new Error('simulated stale browser storage');
        },
      },
    });

    await adapter.getProducts();
    await adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'fresh-generation',
    });
    expect(verifyAndGrant).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'fresh-generation',
    }));
    expect(values.get(storageKey)).toBe(JSON.stringify([{
      version: 1,
      idempotencyKey: 'fresh-generation',
      inAppOfferToken: storeIdentity,
      purchaseToken: storeIdentity,
    }]));
  });

  it('scopes pre-grant recovery by player and preserves the purchased Store identity', async () => {
    const legacyInAppOfferToken = 'ttokdoku_hint_pack_20_legacy';
    const currentInAppOfferToken = 'ttokdoku_hint_pack_20';
    const exactCheckoutIdempotencyKey = '  checkout-before-propagation  ';
    const storedRecoveries = new Map<string, string>();
    const recoveryIdStorage = {
      getItem(key: string) {
        return storedRecoveries.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storedRecoveries.set(key, value);
      },
      removeItem(key: string) {
        storedRecoveries.delete(key);
      },
    };
    const firstAuthority = vi.fn();
    const firstAdapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => 'player-a',
      products: [{ info: product, inAppOfferToken: legacyInAppOfferToken }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        verifyAndGrant: firstAuthority,
        async getEntitlements() {
          return [];
        },
      },
      async getDigitalGoodsService() {
        return {
          async getDetails() {
            return [{
              itemId: legacyInAppOfferToken,
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
            return { details: { purchaseToken: legacyInAppOfferToken } };
          },
        };
      },
      recoveryIdStorage,
    });

    await firstAdapter.getProducts();
    await expect(firstAdapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: exactCheckoutIdempotencyKey,
    })).resolves.toMatchObject({ status: 'pending' });
    expect(firstAuthority).not.toHaveBeenCalled();
    expect([...storedRecoveries.entries()]).toEqual([
      [
        'mpgd:microsoft-store:pending-grant:v3:player-a:HINT_PACK_20',
        JSON.stringify([{
          version: 1,
          idempotencyKey: exactCheckoutIdempotencyKey,
          inAppOfferToken: legacyInAppOfferToken,
          purchaseToken: legacyInAppOfferToken,
        }]),
      ],
    ]);

    const otherPlayerAuthority = vi.fn();
    const otherPlayerAdapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => 'player-b',
      products: [{
        info: product,
        inAppOfferToken: currentInAppOfferToken,
        historicalInAppOfferTokens: [legacyInAppOfferToken],
      }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        async hasRecoveryOwnership() {
          return { status: 'denied' } as const;
        },
        verifyAndGrant: otherPlayerAuthority,
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
            return [{
              itemId: legacyInAppOfferToken,
              purchaseToken: legacyInAppOfferToken,
            }];
          },
        };
      },
      recoveryIdStorage,
    });

    await expect(otherPlayerAdapter.restore?.()).resolves.toEqual({ restoredEntitlements: [] });
    expect(otherPlayerAuthority).not.toHaveBeenCalled();
    expect(storedRecoveries.size).toBe(1);

    const resumedAuthority = vi.fn(async () => ({
      status: 'completed' as const,
      transactionId: 'ledger-after-propagation',
    }));
    const restartedAdapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => 'player-a',
      products: [{ info: product, inAppOfferToken: currentInAppOfferToken }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        async hasRecoveryOwnership(input: { readonly idempotencyKey?: string }) {
          return grantRecoveryOwnership(input);
        },
        verifyAndGrant: resumedAuthority,
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
            return [];
          },
        };
      },
      recoveryIdStorage,
    });

    await expect(restartedAdapter.restore?.()).resolves.toEqual({
      restoredEntitlements: [entitlement],
    });
    expect(resumedAuthority).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: exactCheckoutIdempotencyKey,
      inAppOfferToken: legacyInAppOfferToken,
      purchaseToken: legacyInAppOfferToken,
      source: 'recovery',
      evidence: {
        schema: microsoftStoreDigitalGoodsEvidenceSchema,
        payload: {
          itemId: legacyInAppOfferToken,
          purchaseToken: legacyInAppOfferToken,
        },
      },
    }));
    expect(storedRecoveries.size).toBe(0);
  });

  it('restores multiple pending Store identities for one logical product', async () => {
    const storageKey = 'mpgd:microsoft-store:pending-grant:v3:player-a:HINT_PACK_20';
    const storedRecoveries = new Map([[storageKey, JSON.stringify([
      {
        version: 1,
        idempotencyKey: 'legacy-checkout',
        inAppOfferToken: 'ttokdoku_hint_pack_20_legacy',
        purchaseToken: 'ttokdoku_hint_pack_20_legacy',
      },
      {
        version: 1,
        idempotencyKey: 'current-checkout',
        inAppOfferToken: 'ttokdoku_hint_pack_20',
        purchaseToken: 'ttokdoku_hint_pack_20',
      },
    ])]]);
    const verifyAndGrant = vi.fn(async (input: { readonly purchaseToken: string }) => ({
      status: 'completed' as const,
      transactionId: `ledger-${input.purchaseToken}`,
    }));
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => 'player-a',
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        async hasRecoveryOwnership(input: { readonly idempotencyKey?: string }) {
          return grantRecoveryOwnership(input);
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
            return [];
          },
        };
      },
      recoveryIdStorage: {
        getItem(key) {
          return storedRecoveries.get(key) ?? null;
        },
        setItem(key, value) {
          storedRecoveries.set(key, value);
        },
        removeItem(key) {
          storedRecoveries.delete(key);
        },
      },
    });

    await expect(adapter.restore?.()).resolves.toEqual({ restoredEntitlements: [entitlement] });
    expect(verifyAndGrant).toHaveBeenCalledTimes(2);
    expect(verifyAndGrant.mock.calls.map(([input]) => input.purchaseToken).sort()).toEqual([
      'ttokdoku_hint_pack_20',
      'ttokdoku_hint_pack_20_legacy',
    ]);
    expect(storedRecoveries.size).toBe(0);
  });

  it('restores a listed historical Store identity from its authority owner binding', async () => {
    const verifyAndGrant = vi.fn(async () => ({
      status: 'completed' as const,
      transactionId: 'ledger-historical-listing',
    }));
    const recovery = memoryRecoveryStorage();
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => 'player-a',
      products: [{
        info: product,
        inAppOfferToken: 'ttokdoku_hint_pack_20',
        historicalInAppOfferTokens: ['ttokdoku_hint_pack_20_legacy'],
      }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        async hasRecoveryOwnership(input: { readonly idempotencyKey?: string }) {
          return grantRecoveryOwnership(input);
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
              itemId: 'ttokdoku_hint_pack_20_legacy',
              purchaseToken: 'ttokdoku_hint_pack_20_legacy',
            }];
          },
        };
      },
      createRecoveryId: () => 'historical-listing-recovery',
      recoveryIdStorage: recovery.storage,
    });

    await expect(adapter.restore?.()).resolves.toEqual({ restoredEntitlements: [entitlement] });
    expect(verifyAndGrant).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'HINT_PACK_20',
      inAppOfferToken: 'ttokdoku_hint_pack_20_legacy',
      purchaseToken: 'ttokdoku_hint_pack_20_legacy',
      idempotencyKey: 'durable-recovery-id',
      source: 'recovery',
    }));
  });

  it('does not let another player claim an unowned listed Store purchase', async () => {
    const verifyAndGrant = vi.fn();
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => 'player-b',
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        async hasRecoveryOwnership() {
          return { status: 'denied' } as const;
        },
        verifyAndGrant,
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
            return [{
              itemId: 'ttokdoku_hint_pack_20',
              purchaseToken: 'ttokdoku_hint_pack_20',
            }];
          },
        };
      },
      recoveryIdStorage: memoryRecoveryStorage().storage,
    });

    await expect(adapter.restore?.()).resolves.toEqual({ restoredEntitlements: [] });
    expect(verifyAndGrant).not.toHaveBeenCalled();
  });

  it('ignores forged browser recovery records without an authority owner binding', async () => {
    const storeIdentity = 'ttokdoku_hint_pack_20';
    const storage = memoryRecoveryStorage([
      [
        'mpgd:microsoft-store:pending-owner:v1:ttokdoku_hint_pack_20:ttokdoku_hint_pack_20',
        JSON.stringify({ version: 1, recoveryScope: 'player-b' }),
      ],
      [
        'mpgd:microsoft-store:pending-grant:v3:player-b:HINT_PACK_20',
        JSON.stringify([{
          version: 1,
          idempotencyKey: 'forged-recovery',
          inAppOfferToken: storeIdentity,
          purchaseToken: storeIdentity,
        }]),
      ],
    ]);
    const verifyAndGrant = vi.fn();
    const hasRecoveryOwnership = vi.fn(async () => ({ status: 'denied' } as const));
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => 'player-b',
      products: [{ info: product, inAppOfferToken: storeIdentity }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        hasRecoveryOwnership,
        verifyAndGrant,
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
            return [{ itemId: storeIdentity, purchaseToken: storeIdentity }];
          },
        };
      },
      recoveryIdStorage: storage.storage,
    });

    await expect(adapter.restore?.()).resolves.toEqual({ restoredEntitlements: [] });
    expect(hasRecoveryOwnership).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'HINT_PACK_20',
      purchaseToken: storeIdentity,
    }));
    expect(verifyAndGrant).not.toHaveBeenCalled();
  });

  it('returns pending without re-reserving a checkout owned by another player', async () => {
    const storeIdentity = 'ttokdoku_hint_pack_20';
    const recovery = memoryRecoveryStorage();
    const complete = vi.fn(async () => {});
    const onError = vi.fn();
    const claimRecoveryOwnership = vi.fn(async () => ({ status: 'denied' } as const));
    const verifyAndGrant = vi.fn();
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: storeIdentity }],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        claimRecoveryOwnership,
        verifyAndGrant,
        async getEntitlements() {
          return [];
        },
      },
      async getDigitalGoodsService() {
        return {
          async getDetails() {
            return [{
              itemId: storeIdentity,
              title: '20 hints',
              price: { currency: 'USD', value: '0.99' },
            }];
          },
          async listPurchases() {
            return [{ itemId: storeIdentity, purchaseToken: storeIdentity }];
          },
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            return { details: { purchaseToken: storeIdentity }, complete };
          },
        };
      },
      recoveryIdStorage: recovery.storage,
      onError,
    });

    await adapter.getProducts();
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'conflicting-checkout',
    })).resolves.toMatchObject({ status: 'pending' });
    expect(claimRecoveryOwnership).toHaveBeenCalledOnce();
    expect(verifyAndGrant).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith('unknown');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Microsoft Store purchase is reserved for another authenticated player.',
    }));
    expect(recovery.values.size).toBe(0);
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
    const recovery = memoryRecoveryStorage();
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [
        { info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' },
        { info: secondProduct, inAppOfferToken: 'ttokdoku_hint_pack_120' },
      ],
      authority: {
        ...allowRecoveryOwnership,
        async getAvailability() {
          return 'available';
        },
        async hasRecoveryOwnership(input: { readonly idempotencyKey?: string }) {
          return grantRecoveryOwnership(input);
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
      recoveryIdStorage: recovery.storage,
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
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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

  it('fails before opening checkout when the authenticated player scope changes', async () => {
    let recoveryScope = 'player-a';
    const createPaymentRequest = vi.fn();
    const onError = vi.fn();
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => recoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
            return [];
          },
        };
      },
      createPaymentRequest,
      onError,
    });

    await adapter.getProducts();
    recoveryScope = 'player-b';
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-after-account-change',
    })).resolves.toEqual({ status: 'failed', entitlementIds: [] });
    expect(createPaymentRequest).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Microsoft Store player scope changed after catalog preparation.',
    }));
  });

  it('preserves the original player recovery when the scope changes during checkout', async () => {
    let recoveryScope = 'player-a';
    const complete = vi.fn(async () => {});
    const verifyAndGrant = vi.fn();
    const listPurchases = vi.fn(async () => {
      throw new Error('must not query ownership for a changed player');
    });
    const storedRecoveries = new Map<string, string>();
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => recoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
          listPurchases,
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            recoveryScope = 'player-b';
            return { details: { purchaseToken: 'ttokdoku_hint_pack_20' }, complete };
          },
        };
      },
      recoveryIdStorage: {
        getItem(key) {
          return storedRecoveries.get(key) ?? null;
        },
        setItem(key, value) {
          storedRecoveries.set(key, value);
        },
        removeItem(key) {
          storedRecoveries.delete(key);
        },
      },
    });

    await adapter.getProducts();
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-during-account-change',
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
    expect(verifyAndGrant).not.toHaveBeenCalled();
    expect(listPurchases).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith('unknown');
    expect([...storedRecoveries.keys()]).toEqual([]);
  });

  it('does not fulfill when the player scope changes during the ownership lookup', async () => {
    let recoveryScope = 'player-a';
    const complete = vi.fn(async () => {});
    const verifyAndGrant = vi.fn();
    const recovery = memoryRecoveryStorage();
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope: () => recoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
            recoveryScope = 'player-b';
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
      recoveryIdStorage: recovery.storage,
    });

    await adapter.getProducts();
    await expect(adapter.purchase({
      productId: product.id,
      source: 'shop',
      idempotencyKey: 'checkout-ownership-account-change',
    })).resolves.toMatchObject({ status: 'pending' });
    expect(verifyAndGrant).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith('unknown');
    expect([...recovery.values.keys()]).toEqual([]);
  });

  it('reports reconciliation pending without completing a paid response twice', async () => {
    const complete = vi.fn(async () => {});
    const adapter = createMicrosoftStoreCommerceAdapter({
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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
      getRecoveryScope,
      products: [{ info: product, inAppOfferToken: 'ttokdoku_hint_pack_20' }],
      authority: {
        ...allowRecoveryOwnership,
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

    const commerceOnlyGateway = withMicrosoftStoreCommerceAdapter(
      createGateway('microsoft-store'),
      adapter,
    );
    await expect(commerceOnlyGateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: true,
      nativeLeaderboard: false,
      remoteLeaderboard: false,
    });
    const gateway = withMicrosoftStoreCommerceAdapter(
      createGateway('microsoft-store'),
      adapter,
      { remoteLeaderboard: true },
    );
    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: true,
      nativeLeaderboard: false,
      remoteLeaderboard: true,
    });
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
        remoteLeaderboard: false,
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
