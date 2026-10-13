import { describe, expect, it, vi } from 'vitest';

import type { PlatformGateway, ProductInfo } from '@mpgd/platform';
import { CommerceError, isCommerceCapabilities, type CommerceEvent } from '@mpgd/platform/commerce';

import { createBrowserPlatformGateway } from './index';
import {
  createMicrosoftStoreCommerceCapabilities,
  createMicrosoftStoreCommerceProvider,
  microsoftStoreDigitalGoodsEvidenceSchema,
  withMicrosoftStoreCommerceProvider,
  type MicrosoftStoreCommerceAvailability,
  type MicrosoftStoreDigitalGoodsPurchase,
  type MicrosoftStorePurchaseAuthority,
  type MicrosoftStorePurchaseAuthorityResult,
  type MicrosoftStoreRecoveryAuthorityResult,
} from './microsoft-store';

const product = Object.freeze({
  id: 'HINT_PACK_20',
  type: 'consumable',
  title: '20 hints',
  description: 'Adds 20 hints.',
  price: Object.freeze({ formatted: '$0.99', currencyCode: 'USD' }),
}) satisfies ProductInfo;
const sku = 'ttokdoku_hint_pack_20';
const evidence = Object.freeze({
  schema: microsoftStoreDigitalGoodsEvidenceSchema,
  payload: Object.freeze({ itemId: sku, purchaseToken: sku }),
});

function memoryStorage(seed: readonly (readonly [string, string])[] = []) {
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

interface FixtureOptions {
  readonly availability?: MicrosoftStoreCommerceAvailability;
  readonly listed?: MicrosoftStoreDigitalGoodsPurchase[];
  readonly claim?: (input: { readonly idempotencyKey?: string }) =>
    Promise<MicrosoftStoreRecoveryAuthorityResult>;
  readonly has?: (input: { readonly idempotencyKey?: string }) =>
    Promise<MicrosoftStoreRecoveryAuthorityResult>;
  readonly grant?: () => Promise<MicrosoftStorePurchaseAuthorityResult>;
  readonly show?: () => Promise<{ readonly details: unknown; complete?(): Promise<void> }>;
  readonly getDetails?: () => Promise<readonly {
    readonly itemId: string;
    readonly title: string;
    readonly description?: string;
    readonly price: { readonly currency: string; readonly value?: string };
  }[]>;
  readonly storage?: ReturnType<typeof memoryStorage>;
  readonly scope?: () => string;
}

function createFixture(options: FixtureOptions = {}) {
  const listed = options.listed ?? [];
  const complete = vi.fn(async () => {});
  const show = vi.fn(options.show ?? (async () => ({ details: { purchaseToken: sku }, complete })));
  const createPaymentRequest = vi.fn(() => ({ show }));
  const grantOwnership = async (input: { readonly idempotencyKey?: string }) => ({
    status: 'granted' as const,
    idempotencyKey: input.idempotencyKey ?? 'durable-recovery-id',
  });
  const claimRecoveryOwnership = vi.fn(options.claim ?? grantOwnership);
  const hasRecoveryOwnership = vi.fn(options.has ?? grantOwnership);
  const verifyAndGrant = vi.fn(options.grant ?? (async () => ({
    status: 'completed' as const,
    transactionId: 'ledger-1',
    alreadyProcessed: false,
  })));
  const getDetails = vi.fn(options.getDetails ?? (async () => [{
    itemId: sku,
    title: 'Hint Pack: 20',
    description: 'Store description',
    price: { currency: 'USD', value: '0.99' },
  }]));
  const listPurchases = vi.fn(async () => listed);
  const authority: MicrosoftStorePurchaseAuthority = {
    async getAvailability() {
      return options.availability ?? 'available';
    },
    claimRecoveryOwnership,
    hasRecoveryOwnership,
    verifyAndGrant,
  };
  const storage = options.storage ?? memoryStorage();
  const provider = createMicrosoftStoreCommerceProvider({
    getRecoveryScope: options.scope ?? (() => 'player-1'),
    products: [{ info: product, inAppOfferToken: sku }],
    authority,
    async getDigitalGoodsService() {
      return { getDetails, listPurchases };
    },
    createPaymentRequest,
    recoveryIdStorage: storage.storage,
    locale: 'en-US',
  });
  return {
    provider,
    listed,
    complete,
    show,
    createPaymentRequest,
    claimRecoveryOwnership,
    hasRecoveryOwnership,
    verifyAndGrant,
    getDetails,
    listPurchases,
    storage,
  };
}

const purchaseInput = Object.freeze({
  logicalId: product.id,
  idempotencyKey: 'checkout-1',
  source: 'shop',
} as const);

const expectedPurchase = Object.freeze({
  store: 'microsoft-store',
  transactionId: sku,
  storeSku: sku,
  logicalId: product.id,
  quantity: 1,
  state: 'purchased',
  token: sku,
  evidence,
  accountBinding: { kind: 'obfuscated-account-id', value: 'player-1' },
});

describe('createMicrosoftStoreCommerceCapabilities', () => {
  it('is a pure declaration: a fresh object per call that matches the provider block', async () => {
    const first = createMicrosoftStoreCommerceCapabilities('available');
    const second = createMicrosoftStoreCommerceCapabilities('available');
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.purchase).not.toBe(first.purchase);
    expect(second.lifecycle).not.toBe(first.lifecycle);
    expect(isCommerceCapabilities(first)).toBe(true);
    expect(createMicrosoftStoreCommerceCapabilities('unsupported').availability).toBe('unsupported');
    (first.purchase as { consumable: boolean }).consumable = false;
    expect(createMicrosoftStoreCommerceCapabilities('available').purchase.consumable).toBe(true);
    await expect(createFixture().provider.getCapabilities()).resolves.toEqual(
      createMicrosoftStoreCommerceCapabilities('available'),
    );
  });
});

describe('createMicrosoftStoreCommerceProvider', () => {
  it('declares the RFC microsoft-store profile with a fresh block on every read', async () => {
    const { provider } = createFixture();
    const first = await provider.getCapabilities();
    const second = await provider.getCapabilities();
    expect(first).toEqual({
      purchase: { consumable: true, durable: false, subscription: false, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: true },
      lifecycle: {
        availablePurchases: true,
        pending: false,
        restore: true,
        events: true,
        finish: 'server',
      },
      authority: { evidence: 'adapter-settled', accountBinding: 'required' },
      availability: 'available',
    });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.purchase).not.toBe(first.purchase);
    expect(provider.store).toBe('microsoft-store');
    expect(provider.finishTransaction).toBeUndefined();
  });

  it('reports the authority and Digital Goods availability states', async () => {
    await expect(
      createFixture({ availability: 'configuration-required' }).provider.getCapabilities(),
    ).resolves.toMatchObject({ availability: 'configuration-required' });
    const provider = createMicrosoftStoreCommerceProvider({
      getRecoveryScope: () => 'player-1',
      products: [{ info: product, inAppOfferToken: sku }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async claimRecoveryOwnership() {
          return { status: 'denied' };
        },
        async hasRecoveryOwnership() {
          return { status: 'denied' };
        },
        async verifyAndGrant() {
          return { status: 'failed' };
        },
      },
      async getDigitalGoodsService() {
        throw new Error('Digital Goods is unavailable.');
      },
    });
    await expect(provider.getCapabilities()).resolves.toMatchObject({ availability: 'unsupported' });
    await expect(provider.fetchProducts({})).resolves.toEqual([]);
  });

  it('fetches localized Store products as StoreProduct with amountMicros', async () => {
    const { provider, getDetails } = createFixture();
    await expect(provider.fetchProducts({ type: 'all' })).resolves.toEqual([{
      logicalId: product.id,
      store: 'microsoft-store',
      storeSku: sku,
      kind: 'consumable',
      title: 'Hint Pack: 20',
      description: 'Store description',
      price: { formatted: '$0.99', currencyCode: 'USD', amountMicros: 990_000 },
    }]);
    expect(getDetails).toHaveBeenCalledWith([sku]);
    await expect(provider.fetchProducts({ type: 'subscription' })).resolves.toEqual([]);
    await expect(provider.fetchProducts({ logicalIds: ['OTHER'] })).resolves.toEqual([]);
  });

  it('returns no products while the store is not configured', async () => {
    const { provider, getDetails } = createFixture({ availability: 'configuration-required' });
    await expect(provider.fetchProducts({})).resolves.toEqual([]);
    expect(getDetails).not.toHaveBeenCalled();
  });

  it('normalizes a Digital Goods catalog failure into STORE_UNAVAILABLE', async () => {
    const { provider } = createFixture({
      async getDetails() {
        throw new Error('getDetails failed');
      },
    });
    const error = await provider.fetchProducts({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommerceError);
    expect((error as CommerceError).toCommerceErrorInfo()).toMatchObject({
      code: 'STORE_UNAVAILABLE',
      retryable: true,
      storeCode: 'MICROSOFT_STORE_DIGITAL_GOODS_UNAVAILABLE',
    });
  });

  it('returns purchased with the authority settlement after Payment Request and the ownership claim', async () => {
    const order: string[] = [];
    const fixture = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      async claim(input) {
        order.push('claim');
        return { status: 'granted', idempotencyKey: input.idempotencyKey ?? 'unexpected' };
      },
      async grant() {
        order.push('grant');
        return { status: 'completed', transactionId: 'ledger-1', alreadyProcessed: true };
      },
    });
    await fixture.provider.fetchProducts({});
    const result = fixture.provider.requestPurchase(purchaseInput);
    expect(fixture.createPaymentRequest).toHaveBeenCalledOnce();
    await expect(result).resolves.toEqual({
      outcome: 'purchased',
      purchase: { ...expectedPurchase, settlement: { ledgerEntryId: 'ledger-1' } },
    });
    expect(order).toEqual(['claim', 'grant']);
    expect(fixture.verifyAndGrant).toHaveBeenCalledWith({
      productId: product.id,
      inAppOfferToken: sku,
      purchaseToken: sku,
      idempotencyKey: 'checkout-1',
      source: 'shop',
      evidence,
    });
    expect(fixture.complete).toHaveBeenCalledWith('success');
    expect(fixture.storage.values.size).toBe(0);
    // The settled identity stays listed with its ledger pointer until the server consumes it.
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([
      { ...expectedPurchase, settlement: { ledgerEntryId: 'ledger-1' } },
    ]);
  });

  it('prepares the catalog itself when requestPurchase runs before fetchProducts', async () => {
    const fixture = createFixture({ listed: [{ itemId: sku, purchaseToken: sku }] });
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toMatchObject({
      outcome: 'purchased',
    });
    expect(fixture.getDetails).toHaveBeenCalledOnce();
    expect(fixture.createPaymentRequest).toHaveBeenCalledOnce();
  });

  it('rejects unknown products and quantities before any store UI opens', async () => {
    const fixture = createFixture();
    await expect(
      fixture.provider.requestPurchase({ ...purchaseInput, logicalId: 'UNKNOWN' }),
    ).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE', storeCode: 'MICROSOFT_STORE_PRODUCT_UNKNOWN' });
    await expect(
      fixture.provider.requestPurchase({ ...purchaseInput, quantity: 2 }),
    ).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    expect(fixture.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('answers a dismissed Payment Request with cancelled', async () => {
    const fixture = createFixture({
      async show() {
        throw Object.assign(new Error('dismissed'), { name: 'AbortError' });
      },
    });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toEqual({
      outcome: 'cancelled',
      error: {
        code: 'USER_CANCELLED',
        retryable: false,
        storeCode: 'MICROSOFT_STORE_USER_CANCELLED',
        message: 'The Microsoft Store purchase was cancelled.',
      },
    });
    expect(fixture.verifyAndGrant).not.toHaveBeenCalled();
  });

  it('maps a native bridge payment failure onto the RFC error class', async () => {
    const fixture = createFixture({
      async show() {
        throw Object.assign(new Error('offline'), { code: 'NATIVE_PURCHASE_NETWORK_ERROR' });
      },
    });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'NETWORK',
        retryable: true,
        storeCode: 'NATIVE_PURCHASE_NETWORK_ERROR',
        message: 'offline',
      },
    });
  });

  it('stays launched while the authority answer is pending and keeps the recovery record', async () => {
    const fixture = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      async grant() {
        return { status: 'pending' };
      },
    });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toEqual({
      outcome: 'launched',
    });
    expect(fixture.storage.values.size).toBe(1);
    // Never settled: the listed purchase carries no ledger pointer.
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([expectedPurchase]);
    expect(fixture.complete).toHaveBeenCalledWith('unknown');
  });

  it('stays launched when the Store has not listed the purchase yet', async () => {
    const fixture = createFixture({ listed: [] });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toEqual({
      outcome: 'launched',
    });
    expect(fixture.verifyAndGrant).not.toHaveBeenCalled();
    // The scoped recovery record is listed as a purchased, unsettled purchase.
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([expectedPurchase]);
  });

  it('fails with ACCOUNT_BINDING_REQUIRED when the Store identity belongs to another player', async () => {
    const fixture = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      async claim() {
        return { status: 'denied' };
      },
    });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'ACCOUNT_BINDING_REQUIRED',
        retryable: false,
        storeCode: 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED',
        message: 'Microsoft Store purchase is reserved for another authenticated player.',
      },
    });
    expect(fixture.verifyAndGrant).not.toHaveBeenCalled();
  });

  it('fails when the authority rejects the grant and never reports a settlement', async () => {
    const fixture = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      async grant() {
        return { status: 'failed' };
      },
    });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'UNKNOWN',
        retryable: false,
        storeCode: 'MICROSOFT_STORE_GRANT_REJECTED',
        message: 'Microsoft Store purchase authority rejected the grant.',
      },
    });
    expect(fixture.complete).toHaveBeenCalledWith('fail');
    // The rejected purchase stays listed by the Store, unsettled and no longer claimed here.
    const { accountBinding: _claimed, ...unclaimed } = expectedPurchase;
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([unclaimed]);
  });

  it('lists Store purchases and scoped recovery records once each, settled ones with their ledger pointer', async () => {
    const storage = memoryStorage();
    const first = createFixture({ listed: [], storage });
    await first.provider.fetchProducts({});
    await first.provider.requestPurchase(purchaseInput);
    expect(storage.values.size).toBe(1);

    const second = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }, { itemId: 'unknown_sku', purchaseToken: 'x' }],
      storage,
    });
    await expect(second.provider.getAvailablePurchases({ includePending: true })).resolves.toEqual([
      expectedPurchase,
    ]);
    expect(second.verifyAndGrant).not.toHaveBeenCalled();
  });

  it('replays recovery on restorePurchases and emits the settlement to a later subscriber', async () => {
    const storage = memoryStorage();
    const first = createFixture({
      listed: [],
      storage,
      async claim() {
        throw new Error('authority offline');
      },
    });
    await first.provider.fetchProducts({});
    await expect(first.provider.requestPurchase(purchaseInput)).resolves.toEqual({
      outcome: 'launched',
    });

    const second = createFixture({ listed: [{ itemId: sku, purchaseToken: sku }], storage });
    await second.provider.restorePurchases?.();
    expect(second.hasRecoveryOwnership).toHaveBeenCalledOnce();
    expect(second.verifyAndGrant).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'checkout-1',
      source: 'recovery',
    }));
    const events: CommerceEvent[] = [];
    const unsubscribe = second.provider.subscribe((event) => {
      events.push(event);
    });
    expect(events).toEqual([{
      type: 'purchaseUpdated',
      purchase: { ...expectedPurchase, settlement: { ledgerEntryId: 'ledger-1' } },
    }]);
    expect(storage.values.size).toBe(0);
    await expect(second.provider.getAvailablePurchases()).resolves.toEqual([
      { ...expectedPurchase, settlement: { ledgerEntryId: 'ledger-1' } },
    ]);
    unsubscribe();
  });

  it('emits purchaseError when recovery is denied for the authenticated player', async () => {
    const storage = memoryStorage();
    const first = createFixture({ listed: [], storage });
    await first.provider.fetchProducts({});
    await first.provider.requestPurchase(purchaseInput);

    const second = createFixture({
      listed: [],
      storage,
      async has() {
        return { status: 'denied' };
      },
    });
    const events: CommerceEvent[] = [];
    second.provider.subscribe((event) => {
      events.push(event);
    });
    await second.provider.restorePurchases?.();
    expect(events).toEqual([{
      type: 'purchaseError',
      logicalId: product.id,
      error: {
        code: 'ACCOUNT_BINDING_REQUIRED',
        retryable: false,
        storeCode: 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED',
        message: 'Microsoft Store purchase is reserved for another authenticated player.',
      },
    }]);
    expect(storage.values.size).toBe(0);
    expect(second.verifyAndGrant).not.toHaveBeenCalled();
  });

  it('does not attach an earlier settlement to a later purchase of the same add-on', async () => {
    let grant: MicrosoftStorePurchaseAuthorityResult = {
      status: 'completed',
      transactionId: 'ledger-1',
    };
    const fixture = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      async grant() {
        return grant;
      },
    });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toMatchObject({
      outcome: 'purchased',
      purchase: { settlement: { ledgerEntryId: 'ledger-1' } },
    });
    // The finalizer consumed the first purchase; the Store lists the add-on again after a rebuy.
    fixture.listed.splice(0, fixture.listed.length);
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([]);
    fixture.listed.push({ itemId: sku, purchaseToken: sku });
    grant = { status: 'pending' };
    await expect(fixture.provider.requestPurchase({
      ...purchaseInput,
      idempotencyKey: 'checkout-2',
    })).resolves.toEqual({ outcome: 'launched' });
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([expectedPurchase]);
  });

  it('forgets a settlement once a new checkout of the add-on starts', async () => {
    let grant: MicrosoftStorePurchaseAuthorityResult = {
      status: 'completed',
      transactionId: 'ledger-1',
    };
    const fixture = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      async grant() {
        return grant;
      },
    });
    await fixture.provider.fetchProducts({});
    await fixture.provider.requestPurchase(purchaseInput);
    grant = { status: 'pending' };
    await fixture.provider.requestPurchase({ ...purchaseInput, idempotencyKey: 'checkout-2' });
    const [listed] = await fixture.provider.getAvailablePurchases();
    expect(listed?.settlement).toBeUndefined();
  });

  it('lists a globally listed purchase nobody claimed without an account binding', async () => {
    const fixture = createFixture({ listed: [{ itemId: sku, purchaseToken: sku }] });
    const { accountBinding: _claimed, ...unclaimed } = expectedPurchase;
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([unclaimed]);
  });

  it('keeps OUTCOME_UNKNOWN and ALREADY_OWNED payment failures open and maps a cancel code', async () => {
    for (const code of ['OUTCOME_UNKNOWN', 'ALREADY_OWNED'] as const) {
      const fixture = createFixture({
        async show() {
          throw Object.assign(new Error(code), { code, retryable: false });
        },
      });
      await fixture.provider.fetchProducts({});
      await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toEqual({
        outcome: 'launched',
      });
    }
    const cancelled = createFixture({
      async show() {
        throw Object.assign(new Error('cancel'), { code: 'USER_CANCELLED', retryable: false });
      },
    });
    await cancelled.provider.fetchProducts({});
    await expect(cancelled.provider.requestPurchase(purchaseInput)).resolves.toMatchObject({
      outcome: 'cancelled',
      error: { code: 'USER_CANCELLED' },
    });
  });

  it('rejects requestPurchase with the availability class when the store is not configured', async () => {
    const fixture = createFixture({ availability: 'configuration-required' });
    await expect(fixture.provider.requestPurchase(purchaseInput)).rejects.toMatchObject({
      code: 'CONFIGURATION_REQUIRED',
    });
    expect(fixture.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('degrades a throwing availability probe to temporarily-unavailable', async () => {
    const provider = createMicrosoftStoreCommerceProvider({
      getRecoveryScope: () => 'player-1',
      products: [{ info: product, inAppOfferToken: sku }],
      authority: {
        async getAvailability() {
          throw new Error('probe failed');
        },
        async claimRecoveryOwnership() {
          return { status: 'denied' };
        },
        async hasRecoveryOwnership() {
          return { status: 'denied' };
        },
        async verifyAndGrant() {
          return { status: 'failed' };
        },
      },
    });
    await expect(provider.getCapabilities()).resolves.toMatchObject({
      availability: 'temporarily-unavailable',
    });
  });

  it('does not carry a settlement across an authenticated player switch', async () => {
    let scope = 'player-a';
    const fixture = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      scope: () => scope,
    });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toMatchObject({
      outcome: 'purchased',
      purchase: {
        settlement: { ledgerEntryId: 'ledger-1' },
        accountBinding: { kind: 'obfuscated-account-id', value: 'player-a' },
      },
    });
    // Player B signs in on the same Windows profile and refreshes the catalog;
    // the Store still lists A's unconsumed purchase and A's record is gone.
    scope = 'player-b';
    await fixture.provider.fetchProducts({});
    const { accountBinding: _claimed, ...unclaimed } = expectedPurchase;
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([unclaimed]);
    expect(fixture.verifyAndGrant).toHaveBeenCalledOnce();
  });

  it('replays a recovery record on restorePurchases after the first authority claim failed', async () => {
    const storage = memoryStorage();
    const first = createFixture({
      listed: [],
      storage,
      async claim() {
        throw new Error('authority offline');
      },
    });
    await first.provider.fetchProducts({});
    await first.provider.requestPurchase(purchaseInput);

    const grant = vi.fn(async () => ({ status: 'completed' as const, transactionId: 'ledger-1' }));
    const provider = createMicrosoftStoreCommerceProvider({
      getRecoveryScope: () => 'player-1',
      products: [{ info: product, inAppOfferToken: sku }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async claimRecoveryOwnership(input) {
          return { status: 'granted', idempotencyKey: input.idempotencyKey ?? 'durable' };
        },
        async hasRecoveryOwnership(input) {
          return { status: 'granted', idempotencyKey: input.idempotencyKey ?? 'durable' };
        },
        verifyAndGrant: grant,
      },
      async getDigitalGoodsService() {
        return {
          async getDetails() {
            return [];
          },
          async listPurchases() {
            return [{ itemId: sku, purchaseToken: sku }];
          },
        };
      },
      recoveryIdStorage: storage.storage,
    });
    const events: CommerceEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });
    await expect(provider.restorePurchases?.()).resolves.toBeUndefined();
    expect(grant).toHaveBeenCalledOnce();
    expect(events).toEqual([{
      type: 'purchaseUpdated',
      purchase: { ...expectedPurchase, settlement: { ledgerEntryId: 'ledger-1' } },
    }]);
  });

  it('normalizes a throwing availability probe on every operation', async () => {
    const provider = createMicrosoftStoreCommerceProvider({
      getRecoveryScope: () => 'player-1',
      products: [{ info: product, inAppOfferToken: sku }],
      authority: {
        async getAvailability() {
          throw new Error('probe failed');
        },
        async claimRecoveryOwnership() {
          return { status: 'denied' };
        },
        async hasRecoveryOwnership() {
          return { status: 'denied' };
        },
        async verifyAndGrant() {
          return { status: 'failed' };
        },
      },
      createPaymentRequest: () => {
        throw new Error('Payment Request must not open.');
      },
    });
    const expected = {
      code: 'STORE_UNAVAILABLE',
      retryable: true,
      storeCode: 'MICROSOFT_STORE_AUTHORITY_UNAVAILABLE',
    };
    await expect(provider.fetchProducts({})).rejects.toMatchObject(expected);
    await expect(provider.getAvailablePurchases()).rejects.toMatchObject(expected);
    await expect(provider.restorePurchases?.()).rejects.toMatchObject(expected);
    await expect(provider.requestPurchase(purchaseInput)).rejects.toMatchObject(expected);
    await expect(provider.getCapabilities()).resolves.toMatchObject({
      availability: 'temporarily-unavailable',
    });
  });

  it('keeps a settlement for the same player across a catalog refresh', async () => {
    const fixture = createFixture({ listed: [{ itemId: sku, purchaseToken: sku }] });
    await fixture.provider.fetchProducts({});
    await fixture.provider.requestPurchase(purchaseInput);
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([
      { ...expectedPurchase, settlement: { ledgerEntryId: 'ledger-1' } },
    ]);
    await expect(fixture.provider.getAvailablePurchases()).resolves.toEqual([
      { ...expectedPurchase, settlement: { ledgerEntryId: 'ledger-1' } },
    ]);
  });

  it('binds a settlement made by restorePurchases to the restoring player', async () => {
    const storage = memoryStorage();
    let scope = 'player-a';
    const first = createFixture({
      listed: [],
      storage,
      scope: () => scope,
      async claim() {
        throw new Error('authority offline');
      },
    });
    await first.provider.fetchProducts({});
    await first.provider.requestPurchase(purchaseInput);

    const second = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      storage,
      scope: () => scope,
    });
    await second.provider.restorePurchases?.();
    scope = 'player-b';
    const { accountBinding: _claimed, ...unclaimed } = expectedPurchase;
    await expect(second.provider.getAvailablePurchases()).resolves.toEqual([unclaimed]);
  });

  it('does not deliver a buffered settlement to a subscriber of another player', async () => {
    const storage = memoryStorage();
    let scope = 'player-a';
    const first = createFixture({
      listed: [],
      storage,
      scope: () => scope,
      async claim() {
        throw new Error('authority offline');
      },
    });
    await first.provider.fetchProducts({});
    await first.provider.requestPurchase(purchaseInput);

    const second = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      storage,
      scope: () => scope,
    });
    await second.provider.restorePurchases?.();
    scope = 'player-b';
    const events: CommerceEvent[] = [];
    second.provider.subscribe((event) => {
      events.push(event);
    });
    expect(events).toEqual([]);
  });

  it('never settles a purchase from the Store callback alone', async () => {
    const fixture = createFixture({
      listed: [{ itemId: sku, purchaseToken: sku }],
      async grant() {
        throw new Error('authority offline');
      },
    });
    await fixture.provider.fetchProducts({});
    await expect(fixture.provider.requestPurchase(purchaseInput)).resolves.toEqual({
      outcome: 'launched',
    });
    const listed = await fixture.provider.getAvailablePurchases();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.settlement).toBeUndefined();
  });
});

describe('withMicrosoftStoreCommerceProvider', () => {
  function createBase(): PlatformGateway {
    return {
      ...createBrowserPlatformGateway({ storage: { getItem: () => null, setItem() {} } }),
      target: 'microsoft-store',
    };
  }

  it('exposes the provider as commerce with the capability block and no boolean flags', async () => {
    const fixture = createFixture({ listed: [{ itemId: sku, purchaseToken: sku }] });
    const gateway = withMicrosoftStoreCommerceProvider(createBase(), fixture.provider);
    expect(gateway.commerce).toBe(fixture.provider);
    const capabilities = await gateway.getCapabilities();
    expect(capabilities).toMatchObject({
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
      remoteLeaderboard: false,
      commerce: {
        authority: { evidence: 'adapter-settled', accountBinding: 'required' },
        availability: 'available',
      },
    });
    expect(capabilities).not.toHaveProperty('nativeIap');
    expect(capabilities).not.toHaveProperty('subscriptionIap');
    expect(capabilities.commerce).toEqual(createMicrosoftStoreCommerceCapabilities('available'));
    expect((await gateway.getCapabilities()).commerce).not.toBe(capabilities.commerce);
    await expect(gateway.ads.showRewarded({ placementId: 'x', idempotencyKey: 'ad-1' })).resolves.toMatchObject({
      status: 'unavailable',
    });

    const provider = gateway.commerce;
    if (provider === undefined) {
      throw new Error('The gateway must expose the installed commerce provider.');
    }
    await expect(provider.fetchProducts({})).resolves.toMatchObject([{
      logicalId: product.id,
      store: 'microsoft-store',
      storeSku: sku,
      kind: 'consumable',
      title: 'Hint Pack: 20',
      description: 'Store description',
      price: { formatted: '$0.99', currencyCode: 'USD' },
    }]);
    // The settlement pointer is the reconciler's lead into the ledger, never a grant.
    await expect(provider.requestPurchase(purchaseInput)).resolves.toMatchObject({
      outcome: 'purchased',
      purchase: { transactionId: sku, settlement: { ledgerEntryId: 'ledger-1' } },
    });
  });

  it('reports an unconfigured store with the block availability', async () => {
    const fixture = createFixture({ availability: 'configuration-required' });
    const gateway = withMicrosoftStoreCommerceProvider(createBase(), fixture.provider, {
      remoteLeaderboard: true,
    });
    const capabilities = await gateway.getCapabilities();
    expect(capabilities).toMatchObject({
      remoteLeaderboard: true,
      commerce: { availability: 'configuration-required' },
    });
    expect(capabilities).not.toHaveProperty('nativeIap');
  });

  it('refuses gateways of another target or after target availability is applied', () => {
    const fixture = createFixture();
    expect(() => withMicrosoftStoreCommerceProvider(
      createBrowserPlatformGateway(),
      fixture.provider,
    )).toThrow(/microsoft-store gateway/u);
    expect(() => withMicrosoftStoreCommerceProvider(
      { ...createBase(), getTargetRuntime: () => undefined } as PlatformGateway,
      fixture.provider,
    )).toThrow(/before target availability/u);
  });
});
