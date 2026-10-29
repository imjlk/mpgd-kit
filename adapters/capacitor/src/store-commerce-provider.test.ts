import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformOperationError } from '@mpgd/platform';
import {
  CommerceError,
  commerceEventBufferLimit,
  type CommerceEvent,
  type StorePurchase,
} from '@mpgd/platform/commerce';

import { createFakeStoreSdk, fakePurchase, type FakeStoreSdk } from '../test/store-sdk-fixture.js';
import {
  createStoreCommerceProvider,
  purchaseGateTimeoutMs,
  type CreateStoreCommerceProviderInput,
  type StorePurchaseGateDecision,
} from './store-commerce-provider.js';
import { defaultStoreSdkErrorCodeMap, normalizeStoreSdkError } from './store-sdk.js';

const products: CreateStoreCommerceProviderInput['products'] = [
  { logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' },
  { logicalId: 'remove_ads', storeSku: 'remove.ads', kind: 'durable', offerId: 'intro' },
  { logicalId: 'pass_monthly', storeSku: 'pass.monthly', kind: 'subscription' },
];

const sdkProducts = [
  {
    sku: 'gems.small',
    kind: 'consumable',
    title: 'Gems',
    description: 'Small pack',
    price: { formatted: '$0.99', currencyCode: 'USD', amountMicros: 990_000 },
  },
  {
    sku: 'remove.ads',
    kind: 'durable',
    title: 'No ads',
    description: 'Forever',
    price: { formatted: '$2.99', currencyCode: 'USD' },
    offers: [{ offerId: 'intro', price: { formatted: '$1.99', currencyCode: 'USD' } }],
  },
  {
    sku: 'pass.monthly',
    kind: 'subscription',
    title: 'Pass',
    description: 'Monthly',
    price: { formatted: '$4.99', currencyCode: 'USD' },
  },
  {
    sku: 'unlisted.sku',
    kind: 'consumable',
    title: 'Unlisted',
    description: 'Not sold',
    price: { formatted: '$9.99', currencyCode: 'USD' },
  },
] as const;

function createProvider(
  sdk: FakeStoreSdk,
  overrides: Partial<CreateStoreCommerceProviderInput> = {},
) {
  return createStoreCommerceProvider({
    sdk,
    products,
    evidenceSchema: 'fixture.store.v1',
    authority: { evidence: 'client-token', accountBinding: 'optional' },
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createStoreCommerceProvider', () => {
  it('maps logical ids to store SKUs both ways when fetching products', async () => {
    const sdk = createFakeStoreSdk({ products: sdkProducts });
    const provider = createProvider(sdk);

    const all = await provider.fetchProducts({ type: 'all' });
    expect(all.map((product) => [product.logicalId, product.storeSku, product.kind])).toEqual([
      ['gems_small', 'gems.small', 'consumable'],
      ['remove_ads', 'remove.ads', 'durable'],
      ['pass_monthly', 'pass.monthly', 'subscription'],
    ]);
    expect(all[0]).toMatchObject({ store: 'fixture.store', price: { amountMicros: 990_000 } });
    expect(all[1]?.offers).toEqual([
      { offerId: 'intro', price: { formatted: '$1.99', currencyCode: 'USD' } },
    ]);
    // The SDK answered with an unlisted SKU too; it is not a product the game can buy.
    expect(sdk.fetchCalls[0]?.skus).toEqual(['gems.small', 'remove.ads', 'pass.monthly']);

    expect((await provider.fetchProducts({ type: 'in-app' })).map((p) => p.logicalId))
      .toEqual(['gems_small', 'remove_ads']);
    expect((await provider.fetchProducts({ type: 'subscription' })).map((p) => p.logicalId))
      .toEqual(['pass_monthly']);
    expect((await provider.fetchProducts({ logicalIds: ['remove_ads', 'unknown'] }))
      .map((p) => p.logicalId)).toEqual(['remove_ads']);
    expect(sdk.fetchCalls.at(-1)?.skus).toEqual(['remove.ads']);

    await expect(provider.fetchProducts({ logicalIds: ['unknown'] })).resolves.toEqual([]);
    expect(sdk.fetchCalls).toHaveLength(4);
  });

  it('rejects products the contract or the catalog cannot accept', async () => {
    const mismatch = createFakeStoreSdk({ products: [{ ...sdkProducts[0], kind: 'durable' }] });
    await expect(createProvider(mismatch).fetchProducts({ logicalIds: ['gems_small'] }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const malformed = createFakeStoreSdk({
      products: [{ ...sdkProducts[0], price: { formatted: '$1', currencyCode: '' } }],
    });
    await expect(createProvider(malformed).fetchProducts({ logicalIds: ['gems_small'] }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const failing = createFakeStoreSdk();
    vi.mocked(failing.fetchProducts).mockRejectedValueOnce({
      code: 'PLAY_BILLING_SERVICE_UNAVAILABLE',
    });
    await expect(createProvider(failing).fetchProducts({})).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
      storeCode: 'PLAY_BILLING_SERVICE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('builds purchases with the token, the evidence envelope, and no settlement', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    sdk.queueRequest({
      outcome: 'purchased',
      purchase: fakePurchase({
        transactionId: 'tx-1',
        originalTransactionId: 'tx-0',
        purchasedAt: '2026-10-01T00:00:00.000Z',
        accountBinding: { kind: 'app-account-token', value: 'player-1' },
        raw: { settlement: { ledgerEntryId: 'forged' } },
      }),
    });

    const result = await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(result.outcome).toBe('purchased');
    if (result.outcome !== 'purchased') {
      throw new Error('expected a purchase');
    }
    expect(result.purchase).toEqual({
      store: 'fixture.store',
      transactionId: 'tx-1',
      originalTransactionId: 'tx-0',
      storeSku: 'gems.small',
      logicalId: 'gems_small',
      quantity: 1,
      state: 'purchased',
      purchasedAt: '2026-10-01T00:00:00.000Z',
      token: 'token-tx-1',
      evidence: {
        schema: 'fixture.store.v1',
        payload: {
          token: 'token-tx-1', transactionId: 'tx-1', storeSku: 'gems.small',
          originalTransactionId: 'tx-0',
        },
      },
      accountBinding: { kind: 'app-account-token', value: 'player-1' },
    });
    expect('settlement' in result.purchase).toBe(false);
    expect('raw' in result.purchase).toBe(false);
  });

  it('lets a store provider shape the evidence payload for its verifier', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk, {
      evidenceSchema: 'google-play.product-purchase.v2',
      evidencePayload: (purchase) => ({ purchaseToken: purchase.token }),
    });
    sdk.queueRequest({ outcome: 'purchased', purchase: fakePurchase({ transactionId: 'tx-1' }) });
    const result = await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(result.outcome === 'purchased' ? result.purchase.evidence : undefined).toEqual({
      schema: 'google-play.product-purchase.v2',
      payload: { purchaseToken: 'token-tx-1' },
    });
  });

  it('fails closed before the store UI opens', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);

    await expect(provider.requestPurchase({
      logicalId: 'unknown', idempotencyKey: 'op-1', source: 'shop',
    })).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    await expect(provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop', quantity: 2,
    })).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    await expect(provider.requestPurchase({
      logicalId: 'pass_monthly', idempotencyKey: 'op-3', source: 'shop',
    })).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    expect(sdk.requestCalls).toHaveLength(0);

    const quantity = createProvider(sdk, { capabilities: { purchase: { quantity: true } } });
    await quantity.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-4', source: 'shop', quantity: 2,
    });
    expect(sdk.requestCalls).toEqual([{ sku: 'gems.small', quantity: 2 }]);
  });

  it('forwards the default offer and the account binding', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk, {
      accountBinding: async () => ({ kind: 'obfuscated-account-id', value: 'player-1' }),
      authority: { evidence: 'client-token', accountBinding: 'required' },
    });
    await provider.requestPurchase({
      logicalId: 'remove_ads', idempotencyKey: 'op-1', source: 'shop',
    });
    await provider.requestPurchase({
      logicalId: 'remove_ads', idempotencyKey: 'op-2', source: 'shop', offerId: 'other',
    });
    expect(sdk.requestCalls).toEqual([
      {
        sku: 'remove.ads', offerId: 'intro',
        accountBinding: { kind: 'obfuscated-account-id', value: 'player-1' },
      },
      {
        sku: 'remove.ads', offerId: 'other',
        accountBinding: { kind: 'obfuscated-account-id', value: 'player-1' },
      },
    ]);

    const unbound = createProvider(sdk, {
      accountBinding: async () => undefined,
      authority: { evidence: 'client-token', accountBinding: 'required' },
    });
    // A missing or failed binding is a failed result, not a throw, so the
    // store code survives the bridge.
    await expect(unbound.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-3', source: 'shop',
    })).resolves.toMatchObject({ outcome: 'failed', error: { code: 'ACCOUNT_BINDING_REQUIRED' } });
    const failing = createProvider(sdk, {
      accountBinding: async () => {
        throw new CommerceError('ACCOUNT_BINDING_REQUIRED', { storeCode: 'LOOKUP_FAILED' });
      },
    });
    await expect(failing.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-4', source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ACCOUNT_BINDING_REQUIRED', storeCode: 'LOOKUP_FAILED' },
    });
    // A binding that fails with a code claiming a launched or cancelled sheet
    // opened nothing: it is a binding failure, never launched or cancelled.
    for (const code of ['OUTCOME_UNKNOWN', 'ALREADY_OWNED', 'USER_CANCELLED'] as const) {
      const misleading = createProvider(sdk, {
        accountBinding: async () => {
          throw new CommerceError(code);
        },
      });
      await expect(misleading.requestPurchase({
        logicalId: 'gems_small', idempotencyKey: `op-5-${code}`, source: 'shop',
      })).resolves.toMatchObject({
        outcome: 'failed',
        error: {
          code: 'ACCOUNT_BINDING_REQUIRED', storeCode: 'ACCOUNT_BINDING_LOOKUP_FAILED', retryable: true,
        },
      });
    }
    // Any other thrown lookup is the same reason on every store.
    const generic = createProvider(sdk, {
      accountBinding: async () => {
        throw new Error('session expired');
      },
    });
    await expect(generic.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-6', source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: {
        code: 'ACCOUNT_BINDING_REQUIRED', storeCode: 'ACCOUNT_BINDING_LOOKUP_FAILED', retryable: true,
      },
    });
    expect(sdk.requestCalls).toHaveLength(2);
  });

  it('does not open the store UI while the SDK reports it unavailable', async () => {
    let availability: Awaited<ReturnType<NonNullable<FakeStoreSdk['getAvailability']>>> =
      'configuration-required';
    const sdk = createFakeStoreSdk({ availability: async () => availability });
    const provider = createProvider(sdk);
    const request = { logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' } as const;

    await expect(provider.requestPurchase(request)).rejects.toMatchObject({
      code: 'CONFIGURATION_REQUIRED', retryable: false,
    });
    availability = 'temporarily-unavailable';
    await expect(provider.requestPurchase(request)).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE', retryable: true,
    });
    availability = 'action-required';
    await expect(provider.requestPurchase(request)).rejects.toMatchObject({
      code: 'ACTION_REQUIRED',
    });
    availability = 'unsupported';
    await expect(provider.requestPurchase(request)).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE', retryable: false,
    });
    expect(sdk.requestCalls).toHaveLength(0);
    availability = 'available';
    await expect(provider.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
  });

  it('normalizes SDK purchase failures and keeps the store code', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk, { mapError: { 'custom-cancel': 'USER_CANCELLED' } });
    const request = { logicalId: 'gems_small', idempotencyKey: 'op', source: 'shop' } as const;

    sdk.queueRequest({ throws: { code: 'PLAY_BILLING_NETWORK_ERROR', message: 'offline' } });
    await expect(provider.requestPurchase(request)).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'NETWORK', retryable: true, storeCode: 'PLAY_BILLING_NETWORK_ERROR',
        message: 'offline',
      },
    });

    sdk.queueRequest({ throws: { code: 'custom-cancel' } });
    await expect(provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'cancelled',
      error: { code: 'USER_CANCELLED', retryable: false, storeCode: 'custom-cancel' },
    });

    sdk.queueRequest({
      outcome: 'failed',
      error: { code: 'STORE_UNAVAILABLE', retryable: false, storeCode: 'fixture-down' },
    });
    await expect(provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_UNAVAILABLE', retryable: false, storeCode: 'fixture-down' },
    });

    sdk.queueRequest({ throws: new Error('boom') });
    await expect(provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'UNKNOWN', retryable: false, message: 'boom' },
    });

    sdk.queueRequest({ outcome: 'purchased', purchase: fakePurchase({ transactionId: 'tx', token: '' }) });
    await expect(provider.requestPurchase(request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    sdk.queueRequest({ outcome: 'weird' } as never);
    await expect(provider.requestPurchase(request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('lists unfinished purchases with an undefined logical id for unknown SKUs', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    sdk.upsert(fakePurchase({ transactionId: 'tx-1' }));
    sdk.upsert(fakePurchase({ transactionId: 'tx-2', state: 'pending' }));
    sdk.upsert(fakePurchase({ transactionId: 'tx-3', state: 'revoked' }));
    sdk.upsert(fakePurchase({ transactionId: 'tx-4', sku: 'legacy.sku' }));

    const purchased = await provider.getAvailablePurchases();
    expect(purchased.map((purchase) => [purchase.transactionId, purchase.logicalId])).toEqual([
      ['tx-1', 'gems_small'],
      ['tx-4', undefined],
    ]);
    expect('logicalId' in (purchased[1] as StorePurchase)).toBe(false);
    expect(purchased.every((purchase) => purchase.settlement === undefined)).toBe(true);

    const withPending = await provider.getAvailablePurchases({ includePending: true });
    expect(withPending.map((purchase) => purchase.transactionId)).toEqual(['tx-1', 'tx-2', 'tx-4']);
    expect(vi.mocked(sdk.getAvailablePurchases).mock.calls.at(-1)?.[0]).toEqual({
      includePending: true,
    });

    // An explicit Restore Purchases read reaches the SDK; recovery never asks for it.
    await provider.getAvailablePurchases({ restore: true });
    expect(vi.mocked(sdk.getAvailablePurchases).mock.calls.at(-1)?.[0]).toEqual({
      includePending: false,
      restore: true,
    });
    await provider.getAvailablePurchases({ restore: false });
    expect(vi.mocked(sdk.getAvailablePurchases).mock.calls.at(-1)?.[0]).toEqual({
      includePending: false,
    });

    sdk.upsert({ ...fakePurchase({ transactionId: 'tx-5' }), quantity: 0 });
    await expect(provider.getAvailablePurchases()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const undeclared = createProvider(sdk, {
      capabilities: { lifecycle: { availablePurchases: false } },
    });
    await expect(undeclared.getAvailablePurchases()).resolves.toEqual([]);
  });

  it('finishes only with a ledger entry and forwards the SDK answer', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    sdk.upsert(fakePurchase({ transactionId: 'tx-1' }));

    await expect(provider.finishTransaction?.({
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true,
    })).resolves.toEqual({ finished: true });
    expect(sdk.finishCalls).toEqual([
      { transactionId: 'tx-1', isConsumable: true, ledgerEntryId: 'le-1' },
    ]);
    expect(sdk.purchases).toEqual([]);

    await expect(provider.finishTransaction?.({
      transactionId: 'tx-1', ledgerEntryId: '', isConsumable: true,
    })).rejects.toThrow();
    expect(sdk.finishCalls).toHaveLength(1);

    expect(provider.acceptsFinishRetry).toBe(true);
    sdk.upsert(fakePurchase({ transactionId: 'tx-2' }));
    await expect(provider.finishTransaction?.({
      transactionId: 'tx-2', ledgerEntryId: 'le-2', isConsumable: true, retry: true,
    })).resolves.toEqual({ finished: true });
    expect(sdk.finishCalls.at(-1)).toEqual(
      { transactionId: 'tx-2', isConsumable: true, ledgerEntryId: 'le-2', retry: true },
    );

    sdk.queueFinish({ throws: { code: 'NETWORK' } });
    await expect(provider.finishTransaction?.({
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true,
    })).rejects.toMatchObject({ code: 'NETWORK', retryable: true });

    sdk.queueFinish({ finished: 'yes' } as never);
    await expect(provider.finishTransaction?.({
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    // An SDK that does not read `revoked` is never asked: the provider does
    // not declare it, and a caller that sends it anyway gets a refusal, never
    // an ordinary finish in its place.
    expect(provider.acceptsRevokedFinish).toBeUndefined();
    const calls = sdk.finishCalls.length;
    sdk.upsert(fakePurchase({ transactionId: 'tx-3' }));
    await expect(provider.finishTransaction?.({
      transactionId: 'tx-3', ledgerEntryId: 'le-3', isConsumable: true, revoked: true,
    })).resolves.toEqual({ finished: false });
    expect(sdk.finishCalls).toHaveLength(calls);

    const revokedSdk = createFakeStoreSdk({ revokedFinish: true });
    const revokedProvider = createProvider(revokedSdk);
    expect(revokedProvider.acceptsRevokedFinish).toBe(true);
    revokedSdk.upsert(fakePurchase({ transactionId: 'tx-4' }));
    await expect(revokedProvider.finishTransaction?.({
      transactionId: 'tx-4', ledgerEntryId: 'op-4', isConsumable: true, revoked: true,
    })).resolves.toEqual({ finished: true });
    expect(revokedSdk.finishCalls).toEqual([
      { transactionId: 'tx-4', isConsumable: true, ledgerEntryId: 'op-4', revoked: true },
    ]);

    const serverFinished = createFakeStoreSdk({ finish: false });
    expect(createProvider(serverFinished).finishTransaction).toBeUndefined();
    expect(createProvider(serverFinished).acceptsFinishRetry).toBeUndefined();
    expect(createProvider(createFakeStoreSdk({ finish: false, revokedFinish: true }))
      .acceptsRevokedFinish).toBeUndefined();
    expect(() => createProvider(serverFinished, {
      capabilities: { lifecycle: { finish: 'client' } },
    })).toThrow(/no finishTransaction/);
  });

  it('exposes restore only when the SDK implements it', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    await provider.restorePurchases?.();
    expect(sdk.restoreCalls).toBe(1);
    expect((await provider.getCapabilities()).lifecycle.restore).toBe(true);

    const without = createProvider(createFakeStoreSdk({ restore: false }));
    expect(without.restorePurchases).toBeUndefined();
    expect((await without.getCapabilities()).lifecycle.restore).toBe(false);
  });

  it('buffers events until the first subscriber and maps SKUs to logical ids', () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    sdk.report(fakePurchase({ transactionId: 'tx-1' }));
    sdk.emit({
      type: 'purchaseError', sku: 'gems.small', error: { code: 'PLAY_BILLING_NETWORK_ERROR' },
    });
    sdk.emit({ type: 'purchaseError', error: { code: 'USER_CANCELLED', storeCode: '1' } });
    sdk.emit({
      type: 'purchaseUpdated',
      purchase: fakePurchase({ transactionId: 'tx-2', sku: 'gems.small', token: '' }),
    });

    const first: CommerceEvent[] = [];
    const second: CommerceEvent[] = [];
    const unsubscribeFirst = provider.subscribe((event) => first.push(event));
    provider.subscribe((event) => second.push(event));
    expect(first).toEqual([
      { type: 'purchaseUpdated', purchase: expect.objectContaining({ transactionId: 'tx-1' }) },
      {
        type: 'purchaseError', logicalId: 'gems_small',
        error: expect.objectContaining({
          code: 'NETWORK', storeCode: 'PLAY_BILLING_NETWORK_ERROR', retryable: true,
        }),
      },
      {
        type: 'purchaseError',
        error: expect.objectContaining({ code: 'USER_CANCELLED', storeCode: '1' }),
      },
      {
        type: 'purchaseError', logicalId: 'gems_small',
        error: expect.objectContaining({ code: 'INVALID_RESPONSE' }),
      },
    ]);
    expect(second).toEqual([]);

    sdk.report(fakePurchase({ transactionId: 'tx-3' }));
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(1);

    unsubscribeFirst();
    sdk.report(fakePurchase({ transactionId: 'tx-4' }));
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(2);
  });

  it('keeps the buffer limit and drops the oldest recoverable purchase first', () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    sdk.emit({ type: 'purchaseError', error: { code: 'NETWORK' } });
    for (let index = 0; index < commerceEventBufferLimit; index += 1) {
      sdk.report(fakePurchase({ transactionId: `tx-${index}` }));
    }
    const delivered: CommerceEvent[] = [];
    provider.subscribe((event) => delivered.push(event));
    expect(delivered).toHaveLength(commerceEventBufferLimit);
    expect(delivered[0]?.type).toBe('purchaseError');
    expect(delivered[1]).toMatchObject({ purchase: { transactionId: 'tx-1' } });
  });

  it('buffers again after the last subscriber leaves and stops after dispose', () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    expect(sdk.listenerCount).toBe(2);
    const unsubscribe = provider.subscribe(() => undefined);
    unsubscribe();
    sdk.report(fakePurchase({ transactionId: 'tx-1' }));
    const late: CommerceEvent[] = [];
    provider.subscribe((event) => late.push(event));
    expect(late).toHaveLength(1);

    provider.dispose();
    expect(sdk.listenerCount).toBe(0);
    sdk.report(fakePurchase({ transactionId: 'tx-2' }));
    expect(late).toHaveLength(1);
  });

  it('composes fresh capabilities from the SDK declaration and overrides', async () => {
    const sdk = createFakeStoreSdk({
      capabilities: { offers: true, pending: false, finish: 'client' },
      availability: async () => 'available',
    });
    const provider = createProvider(sdk, {
      capabilities: { purchase: { durable: false }, lifecycle: { events: false } },
      authority: { evidence: 'client-token', accountBinding: 'required' },
    });
    const first = await provider.getCapabilities();
    expect(first).toEqual({
      purchase: { consumable: true, durable: false, subscription: false, quantity: false },
      catalog: { products: true, offers: true, localizedPrice: true },
      lifecycle: {
        availablePurchases: true, pending: false, restore: true, events: false, finish: 'client',
      },
      authority: { evidence: 'client-token', accountBinding: 'required' },
      availability: 'available',
    });
    const second = await provider.getCapabilities();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.purchase).not.toBe(first.purchase);
    expect(second.catalog).not.toBe(first.catalog);
    expect(second.lifecycle).not.toBe(first.lifecycle);
    expect(second.authority).not.toBe(first.authority);
  });

  it('degrades a stalled, failed, invalid, or missing availability read', async () => {
    vi.useFakeTimers();
    const stalled = createProvider(createFakeStoreSdk({
      availability: () => new Promise(() => undefined),
    }));
    const pending = stalled.getCapabilities();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).availability).toBe('temporarily-unavailable');
    vi.useRealTimers();

    const failed = createProvider(createFakeStoreSdk({
      availability: async () => { throw new Error('sdk'); },
    }));
    expect((await failed.getCapabilities()).availability).toBe('temporarily-unavailable');
    const invalid = createProvider(createFakeStoreSdk({
      availability: async () => 'ready' as never,
    }));
    expect((await invalid.getCapabilities()).availability).toBe('temporarily-unavailable');
    const silent = createProvider(createFakeStoreSdk());
    expect((await silent.getCapabilities()).availability).toBe('available');
  });

  it('rejects invalid configuration at creation', () => {
    const sdk = createFakeStoreSdk();
    expect(() => createProvider(sdk, { products: [...products, products[0] as never] }))
      .toThrow(/mapped twice/);
    expect(() => createProvider(sdk, { evidenceSchema: '' })).toThrow(/evidence schema/);
    expect(() => createProvider(sdk, { store: '' })).toThrow(/store id/);
  });
});

describe('purchase gate', () => {
  const request = { logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' } as const;

  it('asks the gate after the store checks and before the binding', async () => {
    const calls: unknown[] = [];
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk, {
      purchaseGate: (gateRequest) => {
        calls.push(['gate', gateRequest]);
        return { allowed: true };
      },
      accountBinding: async () => {
        calls.push(['binding']);
        return { kind: 'obfuscated-account-id', value: 'player-1' };
      },
    });
    await expect(provider.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    expect(calls).toEqual([
      ['gate', {
        store: 'fixture.store', logicalId: 'gems_small', storeSku: 'gems.small',
        kind: 'consumable', source: 'shop',
      }],
      ['binding'],
    ]);
    expect(sdk.requestCalls).toHaveLength(1);

    // An unknown product, an unavailable store, or an unsupported kind
    // answers before the gate is asked.
    await expect(provider.requestPurchase({ ...request, logicalId: 'nope' }))
      .rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    await expect(provider.requestPurchase({ ...request, logicalId: 'pass_monthly' }))
      .rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    const offline = createProvider(createFakeStoreSdk({
      availability: async () => 'temporarily-unavailable',
    }), {
      purchaseGate: () => {
        calls.push(['offline gate']);
        return { allowed: false };
      },
    });
    await expect(offline.requestPurchase(request)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(calls).toHaveLength(2);
  });

  it('answers a refusal as a failed result and never opens the store', async () => {
    const sdk = createFakeStoreSdk();
    const binding = vi.fn(async () => ({ kind: 'obfuscated-account-id', value: 'player-1' } as const));
    const paused = createProvider(sdk, {
      purchaseGate: () => ({ allowed: false }),
      accountBinding: binding,
    });
    await expect(paused.requestPurchase(request)).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'ITEM_UNAVAILABLE',
        retryable: false,
        storeCode: 'PURCHASES_PAUSED',
        message: 'New purchases of gems_small are paused.',
      },
    });
    const named = createProvider(sdk, {
      purchaseGate: async () => ({
        allowed: false, storeCode: 'COIN_SALES_DISABLED', message: 'Closed.', retryable: true,
      }),
    });
    await expect(named.requestPurchase(request)).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'ITEM_UNAVAILABLE', retryable: true, storeCode: 'COIN_SALES_DISABLED', message: 'Closed.',
      },
    });
    expect(binding).not.toHaveBeenCalled();
    expect(sdk.requestCalls).toEqual([]);
  });

  it('fails closed when the gate throws or answers nonsense', async () => {
    const sdk = createFakeStoreSdk();
    const throwing = createProvider(sdk, {
      purchaseGate: async () => {
        throw new Error('server unreachable');
      },
    });
    await expect(throwing.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: 'PURCHASE_GATE_FAILED', retryable: true },
    });
    const commerceFailure = createProvider(sdk, {
      purchaseGate: () => {
        throw new CommerceError('NETWORK', { storeCode: 'SALES_FLAG_OFFLINE' });
      },
    });
    await expect(commerceFailure.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'NETWORK', storeCode: 'SALES_FLAG_OFFLINE', retryable: true },
    });
    // A code claiming a launched or cancelled sheet opened nothing: the gate failed.
    for (const code of ['OUTCOME_UNKNOWN', 'ALREADY_OWNED', 'USER_CANCELLED'] as const) {
      const misleading = createProvider(sdk, {
        purchaseGate: () => {
          throw new CommerceError(code);
        },
      });
      await expect(misleading.requestPurchase(request)).resolves.toMatchObject({
        outcome: 'failed',
        error: { code: 'ITEM_UNAVAILABLE', storeCode: 'PURCHASE_GATE_FAILED', retryable: true },
      });
    }
    // A gate that could not answer is retryable whether it threw or answered nonsense.
    for (const answer of [undefined, null, {}, { allowed: 'yes' }, [true]]) {
      const invalid = createProvider(sdk, {
        purchaseGate: () => answer as never,
      });
      await expect(invalid.requestPurchase(request)).resolves.toMatchObject({
        outcome: 'failed',
        error: { code: 'ITEM_UNAVAILABLE', storeCode: 'PURCHASE_GATE_FAILED', retryable: true },
      });
    }
    expect(sdk.requestCalls).toEqual([]);
  });

  it('refuses a gate that does not answer in time and ignores its late answer', async () => {
    vi.useFakeTimers();
    const sdk = createFakeStoreSdk();
    const settle: Array<(decision: StorePurchaseGateDecision) => void> = [];
    const fail: Array<(error: unknown) => void> = [];
    const provider = createProvider(sdk, {
      purchaseGate: () => new Promise<StorePurchaseGateDecision>((resolve, reject) => {
        settle.push(resolve);
        fail.push(reject);
      }),
    });
    let answer: unknown;
    const pending = provider.requestPurchase(request).then((result) => {
      answer = result;
      return result;
    });
    await vi.advanceTimersByTimeAsync(purchaseGateTimeoutMs - 1);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: 'PURCHASE_GATE_FAILED', retryable: true },
    });
    // A late allow (or a late failure) after the bound changes nothing.
    settle[0]?.({ allowed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.requestCalls).toEqual([]);

    const second = provider.requestPurchase({ ...request, idempotencyKey: 'op-2' });
    await vi.advanceTimersByTimeAsync(purchaseGateTimeoutMs);
    await expect(second).resolves.toMatchObject({
      outcome: 'failed', error: { storeCode: 'PURCHASE_GATE_FAILED' },
    });
    fail[1]?.(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.requestCalls).toEqual([]);
    // An answer inside the bound clears the timer and opens the store.
    const third = provider.requestPurchase({ ...request, idempotencyKey: 'op-3' });
    await vi.advanceTimersByTimeAsync(0);
    settle[2]?.({ allowed: true });
    await expect(third).resolves.toEqual({ outcome: 'launched' });
    expect(sdk.requestCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is never asked by recovery, events, finishing, restore, or catalog reads', async () => {
    const sdk = createFakeStoreSdk({ products: sdkProducts });
    const gate = vi.fn(() => ({ allowed: false } as const));
    const provider = createProvider(sdk, { purchaseGate: gate });
    const events: CommerceEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdk.report(fakePurchase({ transactionId: 'tx-paid' }));
    expect(events).toHaveLength(1);
    expect((await provider.getAvailablePurchases()).map((purchase) => purchase.transactionId))
      .toEqual(['tx-paid']);
    await expect(provider.finishTransaction?.({
      transactionId: 'tx-paid', ledgerEntryId: 'le-1', isConsumable: true,
    })).resolves.toEqual({ finished: true });
    await provider.restorePurchases?.();
    expect((await provider.fetchProducts({})).length).toBeGreaterThan(0);
    expect((await provider.getCapabilities()).availability).toBe('available');
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('recoverable purchase failures', () => {
  const request = { logicalId: 'gems_small', idempotencyKey: 'op', source: 'shop' } as const;

  it('keeps an uncertain or already-owned attempt launched instead of failed', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    for (const code of ['PLAY_BILLING_TIMEOUT', 'PLAY_BILLING_INTERRUPTED',
      'STOREKIT_PURCHASE_UNCERTAIN', 'PLAY_BILLING_ALREADY_OWNED', 'OUTCOME_UNKNOWN',
      'ALREADY_OWNED']) {
      sdk.queueRequest({ throws: { code } });
      await expect(provider.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    }
    sdk.queueRequest({
      outcome: 'failed', error: { code: 'ALREADY_OWNED', retryable: false, storeCode: '7' },
    });
    await expect(provider.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    // The attempt reaches the store once per call; nothing reopens the UI.
    expect(sdk.requestCalls).toHaveLength(7);
    // A cancel reported as `failed` is still a cancel, and other failures stay terminal.
    sdk.queueRequest({ outcome: 'failed', error: { code: 'USER_CANCELLED', storeCode: '1' } });
    await expect(provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'cancelled', error: { storeCode: '1' },
    });
    sdk.queueRequest({ throws: { code: 'PLAY_BILLING_PRODUCT_UNKNOWN' } });
    await expect(provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' },
    });
  });

  it('does not forward purchaseError events with recoverable codes', () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    const events: CommerceEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdk.emit({ type: 'purchaseError', sku: 'gems.small', error: { code: 'PLAY_BILLING_TIMEOUT' } });
    sdk.emit({ type: 'purchaseError', error: { code: 'ALREADY_OWNED' } });
    expect(events).toEqual([]);
    sdk.emit({ type: 'purchaseError', sku: 'gems.small', error: { code: 'PLAY_BILLING_NETWORK_ERROR' } });
    expect(events).toEqual([
      { type: 'purchaseError', logicalId: 'gems_small', error: expect.objectContaining({ code: 'NETWORK' }) },
    ]);
  });

  it('rejects a restore override the SDK cannot serve', async () => {
    const sdk = createFakeStoreSdk({ restore: false });
    expect(() => createProvider(sdk, { capabilities: { lifecycle: { restore: true } } }))
      .toThrow(/no restorePurchases/);
    const hidden = createProvider(createFakeStoreSdk(), {
      capabilities: { lifecycle: { restore: false } },
    });
    expect((await hidden.getCapabilities()).lifecycle.restore).toBe(false);
  });
});

describe('normalizeStoreSdkError', () => {
  it('maps store codes through the default table and keeps them as storeCode', () => {
    for (const [storeCode, code] of Object.entries(defaultStoreSdkErrorCodeMap)) {
      const error = normalizeStoreSdkError({ code: storeCode });
      expect(error).toBeInstanceOf(CommerceError);
      expect(error.toCommerceErrorInfo()).toMatchObject({ code, storeCode });
    }
    expect(normalizeStoreSdkError({ code: 'PLAY_BILLING_DISCONNECTED' }).retryable).toBe(true);
    expect(normalizeStoreSdkError({ code: 'PLAY_BILLING_DISCONNECTED', retryable: false })
      .retryable).toBe(false);
  });

  it('keeps normalized codes, an explicit store code, and falls back to UNKNOWN', () => {
    expect(normalizeStoreSdkError({ code: 'USER_CANCELLED', storeCode: '1' }).toCommerceErrorInfo())
      .toMatchObject({ code: 'USER_CANCELLED', storeCode: '1', retryable: false });
    expect(normalizeStoreSdkError({ code: 'E_SOMETHING', message: 'm' }).toCommerceErrorInfo())
      .toMatchObject({ code: 'UNKNOWN', storeCode: 'E_SOMETHING', retryable: false, message: 'm' });
    expect(normalizeStoreSdkError({ code: 'E_X' }, { E_X: 'NETWORK' }).toCommerceErrorInfo())
      .toMatchObject({ code: 'NETWORK', storeCode: 'E_X', retryable: true });
    const platform = new PlatformOperationError({
      code: 'NATIVE_PROVIDER_INVALID_RESPONSE', retryable: false,
    });
    expect(normalizeStoreSdkError(platform).toCommerceErrorInfo()).toMatchObject({
      code: 'INVALID_RESPONSE', storeCode: 'NATIVE_PROVIDER_INVALID_RESPONSE',
    });
    const passthrough = new CommerceError('ALREADY_OWNED', { storeCode: 'x' });
    expect(normalizeStoreSdkError(passthrough)).toBe(passthrough);
    expect(normalizeStoreSdkError(new Error('plain')).toCommerceErrorInfo()).toMatchObject({
      code: 'UNKNOWN', retryable: false, message: 'plain',
    });
    expect(normalizeStoreSdkError('text').toCommerceErrorInfo()).toMatchObject({
      code: 'UNKNOWN', retryable: false,
    });
  });
});
