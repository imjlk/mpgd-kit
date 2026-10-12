import { describe, expect, it } from 'vitest';

import { defaultStoreSdkErrorCodeMap, normalizeStoreSdkError } from '@mpgd/adapter-capacitor';
import { createGooglePlayTokenPurchaseKey } from '@mpgd/platform/commerce';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
  fakePlayPurchase,
} from '../test/play-billing-plugin-fixture.js';
import {
  createCapacitorPlayBillingStoreSdk,
  isValidPlayPurchaseToken,
  playBillingStoreSdkCapabilities,
  playBillingStoreSdkErrorCodeMap,
  toPlayBillingSdkPurchase,
  type CapacitorPlayBillingStoreSdk,
} from './store-sdk.js';
import type { StoreSdkEvent } from '@mpgd/adapter-capacitor';

const binding = { kind: 'obfuscated-account-id', value: 'player-hash-1' } as const;

const unmapped: unknown[] = [];

function createSdk(
  plugin = createFakePlayBillingPlugin({
    products: [
      fakePlayProduct({ productId: 'gems.small' }),
      fakePlayProduct({
        productId: 'remove.ads',
        offers: [
          { offerToken: 'base', formattedPrice: '$2.99', currencyCode: 'USD' },
          {
            offerToken: 'intro',
            formattedPrice: '$1.99',
            currencyCode: 'USD',
            priceAmountMicros: 1_990_000,
          },
        ],
      }),
    ],
  }),
  isAndroid = () => true,
): { readonly sdk: CapacitorPlayBillingStoreSdk; readonly plugin: typeof plugin } {
  return {
    plugin,
    sdk: createCapacitorPlayBillingStoreSdk({
      plugin,
      isAndroid,
      onUnmappedPurchase: (purchase) => {
        unmapped.push(purchase);
      },
      products: [
        { sku: 'gems.small', kind: 'consumable' },
        { sku: 'remove.ads', kind: 'durable', offerToken: 'intro' },
      ],
    }),
  };
}

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/** Polls until `predicate` holds; the token key derivation is a real async digest. */
const until = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the expected state.');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe('createCapacitorPlayBillingStoreSdk', () => {
  it('declares the google-play profile row', () => {
    const { sdk } = createSdk();
    expect(sdk.store).toBe('google-play');
    expect(sdk.capabilities).toBe(playBillingStoreSdkCapabilities);
    expect(sdk.capabilities).toEqual({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      offers: true,
      pending: true,
      restore: false,
      finish: 'server',
    });
    expect(sdk.finishTransaction).toBeUndefined();
    expect(sdk.restorePurchases).toBeUndefined();
  });

  it('rejects invalid, duplicate, subscription, or too many products', () => {
    const plugin = createFakePlayBillingPlugin();
    expect(() => createCapacitorPlayBillingStoreSdk({ plugin, products: [] })).toThrow(TypeError);
    expect(() => createCapacitorPlayBillingStoreSdk({
      plugin,
      products: [{ sku: 'a', kind: 'consumable' }, { sku: 'a', kind: 'durable' }],
    })).toThrow(/unique/u);
    expect(() => createCapacitorPlayBillingStoreSdk({
      plugin,
      products: [{ sku: 'bad sku', kind: 'consumable' }],
    })).toThrow(TypeError);
    expect(() => createCapacitorPlayBillingStoreSdk({
      plugin,
      products: [{ sku: 'pass', kind: 'subscription' as 'consumable' }],
    })).toThrow(TypeError);
    expect(() => createCapacitorPlayBillingStoreSdk({
      plugin,
      products: Array.from({ length: 101 }, (_, index) => ({
        sku: `p${index}`,
        kind: 'consumable' as const,
      })),
    })).toThrow(/at most 100/u);
  });

  it('fetches products with the selected offer as price and every eligible offer listed', async () => {
    const { sdk, plugin } = createSdk();
    const products = await sdk.fetchProducts({ skus: ['gems.small', 'remove.ads', 'unknown'], type: 'all' });
    expect(plugin.productCalls).toEqual([['gems.small', 'remove.ads']]);
    expect(products).toEqual([
      {
        sku: 'gems.small',
        kind: 'consumable',
        title: 'Product gems.small',
        description: 'Fixture product gems.small',
        price: { formatted: '$0.99', currencyCode: 'USD', amountMicros: 990_000 },
        offers: [{
          offerId: 'offer-gems.small',
          price: { formatted: '$0.99', currencyCode: 'USD', amountMicros: 990_000 },
        }],
      },
      {
        sku: 'remove.ads',
        kind: 'durable',
        title: 'Product remove.ads',
        description: 'Fixture product remove.ads',
        price: { formatted: '$1.99', currencyCode: 'USD', amountMicros: 1_990_000 },
        offers: [
          { offerId: 'base', price: { formatted: '$2.99', currencyCode: 'USD' } },
          { offerId: 'intro', price: { formatted: '$1.99', currencyCode: 'USD', amountMicros: 1_990_000 } },
        ],
      },
    ]);
    expect(await sdk.fetchProducts({ skus: ['gems.small'], type: 'subscription' })).toEqual([]);
    expect(await sdk.fetchProducts({ skus: ['unknown'], type: 'in-app' })).toEqual([]);
    expect(plugin.productCalls).toHaveLength(1);
  });

  it('refuses to price a product whose offer is ambiguous', async () => {
    const plugin = createFakePlayBillingPlugin({
      products: [fakePlayProduct({
        productId: 'gems.small',
        offers: [
          { offerToken: 'a', formattedPrice: '$1', currencyCode: 'USD' },
          { offerToken: 'b', formattedPrice: '$2', currencyCode: 'USD' },
        ],
      })],
    });
    const sdk = createCapacitorPlayBillingStoreSdk({
      plugin,
      isAndroid: () => true,
      products: [{ sku: 'gems.small', kind: 'consumable' }],
    });
    await expect(sdk.fetchProducts({ skus: ['gems.small'], type: 'all' })).rejects.toMatchObject({
      code: 'PLAY_BILLING_OFFER_REQUIRED',
    });
    expect(await sdk.getAvailability()).toBe('configuration-required');
    expect(normalizeStoreSdkError(
      await sdk.fetchProducts({ skus: ['gems.small'], type: 'all' }).catch((error: unknown) => error),
      playBillingStoreSdkErrorCodeMap,
    )).toMatchObject({ code: 'CONFIGURATION_REQUIRED', storeCode: 'PLAY_BILLING_OFFER_REQUIRED' });
  });

  it('passes the obfuscated account id and the offer token to the purchase flow', async () => {
    const { sdk, plugin } = createSdk();
    plugin.queuePurchase({
      status: 'purchased',
      purchase: fakePlayPurchase({
        products: ['remove.ads'],
        purchaseToken: 'token-ads',
        orderId: 'GPA.1',
        obfuscatedAccountId: 'player-hash-1',
      }),
    });
    const result = await sdk.requestPurchase({ sku: 'remove.ads', accountBinding: binding });
    expect(plugin.purchaseCalls).toEqual([{
      productId: 'remove.ads',
      offerToken: 'intro',
      obfuscatedAccountId: 'player-hash-1',
    }]);
    expect(result).toEqual({
      outcome: 'purchased',
      purchase: {
        sku: 'remove.ads',
        transactionId: 'GPA.1',
        state: 'purchased',
        purchasedAt: new Date(1_790_000_000_000).toISOString(),
        token: 'token-ads',
        quantity: 1,
        accountBinding: binding,
      },
    });

    plugin.queuePurchase({ status: 'cancelled' });
    await sdk.requestPurchase({ sku: 'remove.ads', offerId: 'base', accountBinding: binding });
    expect(plugin.purchaseCalls[1]).toMatchObject({ offerToken: 'base' });

    plugin.queuePurchase({ status: 'cancelled' });
    await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding });
    expect(plugin.purchaseCalls[2]).toEqual({
      productId: 'gems.small',
      obfuscatedAccountId: 'player-hash-1',
    });
  });

  it('requires an obfuscated-account-id binding before the store UI opens', async () => {
    const { sdk, plugin } = createSdk();
    for (const accountBinding of [
      undefined,
      { kind: 'host-identity' } as const,
      { kind: 'app-account-token', value: 'x' } as const,
      { kind: 'obfuscated-account-id' } as const,
      { kind: 'obfuscated-account-id', value: 'has space' } as const,
      { kind: 'obfuscated-account-id', value: 'x'.repeat(65) } as const,
    ]) {
      await expect(sdk.requestPurchase({
        sku: 'gems.small',
        ...(accountBinding === undefined ? {} : { accountBinding }),
      })).rejects.toMatchObject({ code: 'PLAY_BILLING_ACCOUNT_REQUIRED' });
    }
    await expect(sdk.requestPurchase({ sku: 'nope', accountBinding: binding }))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_PRODUCT_UNKNOWN' });
    await expect(sdk.requestPurchase({ sku: 'gems.small', quantity: 2, accountBinding: binding }))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_INVALID_REQUEST' });
    expect(plugin.purchaseCalls).toEqual([]);
  });

  it('maps pending to launched, cancelled to cancelled, and rejections to failed with the plugin code', async () => {
    const { sdk, plugin } = createSdk();
    const events: StoreSdkEvent[] = [];
    sdk.addListener('purchaseUpdated', (event) => {
      events.push(event);
    });

    expect(await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding }))
      .toEqual({ outcome: 'launched' });
    await until(() => events.length === 1);
    expect(events).toEqual([{
      type: 'purchaseUpdated',
      purchase: expect.objectContaining({ sku: 'gems.small', state: 'pending' }),
    }]);

    plugin.queuePurchase({ status: 'cancelled' });
    expect(await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding })).toEqual({
      outcome: 'cancelled',
      error: { code: 'USER_CANCELLED', retryable: false, message: 'Purchase cancelled.' },
    });

    for (const [code, expected] of [
      ['PLAY_BILLING_TIMEOUT', 'OUTCOME_UNKNOWN'],
      ['PLAY_BILLING_INTERRUPTED', 'OUTCOME_UNKNOWN'],
      ['PLAY_BILLING_EMPTY_PURCHASE', 'OUTCOME_UNKNOWN'],
      ['PLAY_BILLING_ALREADY_OWNED', 'ALREADY_OWNED'],
      ['PLAY_BILLING_BUSY', 'IN_PROGRESS'],
      ['PLAY_BILLING_SERVICE_UNAVAILABLE', 'STORE_UNAVAILABLE'],
      ['PLAY_BILLING_ACTIVITY_REQUIRED', 'NOT_PREPARED'],
      ['PLAY_BILLING_ERROR', 'UNKNOWN'],
    ] as const) {
      plugin.queuePurchase({ throws: Object.assign(new Error(code), { code }) });
      const result = await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding });
      expect(result).toMatchObject({ outcome: 'failed', error: { code, message: code } });
      if (result.outcome !== 'failed') {
        throw new Error('expected failed');
      }
      expect(normalizeStoreSdkError(result.error, playBillingStoreSdkErrorCodeMap))
        .toMatchObject({ code: expected, storeCode: code });
    }

    plugin.queuePurchase({ throws: new Error('no code') });
    expect(await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding })).toMatchObject({
      outcome: 'failed',
      error: { code: 'PLAY_BILLING_UNAVAILABLE', retryable: true, message: 'no code' },
    });
    plugin.queuePurchase({
      throws: { code: 'STORE_UNAVAILABLE', retryable: true, storeCode: 'fixture', message: 'm' },
    });
    expect(await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding })).toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_UNAVAILABLE', retryable: true, storeCode: 'fixture', message: 'm' },
    });
  });

  it('fails closed on a purchase outcome that does not match the request', async () => {
    const { sdk, plugin } = createSdk();
    plugin.queuePurchase({
      status: 'purchased',
      purchase: fakePlayPurchase({ products: ['remove.ads'], purchaseToken: 'other' }),
    });
    await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding }))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_EVIDENCE_INVALID' });
    plugin.queuePurchase({
      status: 'purchased',
      purchase: fakePlayPurchase({ products: ['gems.small'], purchaseToken: 'p', purchaseState: 'pending' }),
    });
    await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding }))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_EVIDENCE_INVALID' });
    plugin.queuePurchase({ status: 'purchased' });
    await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding }))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_EVIDENCE_INVALID' });
    plugin.queuePurchase({
      status: 'purchased',
      purchase: fakePlayPurchase({ products: ['gems.small'], purchaseToken: ' padded' }),
    });
    await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding }))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_EVIDENCE_INVALID' });
  });

  it('lists only unfinished purchases: purchased and unacknowledged, plus pending on request', async () => {
    const { sdk, plugin } = createSdk();
    plugin.upsert(fakePlayPurchase({ purchaseToken: 'open', orderId: 'GPA.open' }));
    plugin.upsert(fakePlayPurchase({ purchaseToken: 'done', orderId: 'GPA.done', isAcknowledged: true }));
    plugin.upsert(fakePlayPurchase({ purchaseToken: 'wait', purchaseState: 'pending' }));
    plugin.upsert(fakePlayPurchase({
      purchaseToken: 'multi',
      products: ['gems.small', 'remove.ads'],
      orderId: 'GPA.multi',
    }));
    plugin.upsert(fakePlayPurchase({ purchaseToken: 'other', products: ['not.sold'], orderId: 'GPA.o' }));

    unmapped.length = 0;
    const unfinished = await sdk.getAvailablePurchases({});
    // A retired SKU and a multi-line purchase have no logical id for the
    // reconciler; they reach the diagnostics hook instead of the list.
    expect(unfinished.map((purchase) => purchase.token)).toEqual(['open']);
    expect(unmapped.map((purchase) => (purchase as { purchaseToken: string }).purchaseToken))
      .toEqual(['multi', 'other']);
    const withPending = await sdk.getAvailablePurchases({ includePending: true });
    expect(withPending.map((purchase) => [purchase.token, purchase.state])).toEqual([
      ['open', 'purchased'],
      ['wait', 'pending'],
    ]);
    expect(withPending[1]).toEqual({
      sku: 'gems.small',
      transactionId: await createGooglePlayTokenPurchaseKey('wait'),
      state: 'pending',
      purchasedAt: new Date(1_790_000_000_000).toISOString(),
      token: 'wait',
      quantity: 1,
    });
    expect(plugin.getPurchasesCalls).toBe(2);
  });

  it('keeps a purchase available when it carries no acknowledged flag', async () => {
    const { sdk, plugin } = createSdk();
    // A payload without isAcknowledged and quantity.
    plugin.upsert({
      products: ['gems.small'],
      purchaseToken: 'legacy-paid',
      orderId: 'GPA.legacy',
      purchaseTime: 1_000,
      purchaseState: 'purchased',
    } as never);
    plugin.upsert({
      products: ['gems.small'],
      purchaseToken: 'legacy-pending',
      purchaseState: 'pending',
    } as never);
    expect(await sdk.getAvailablePurchases({ includePending: true })).toEqual([
      {
        sku: 'gems.small',
        transactionId: 'GPA.legacy',
        state: 'purchased',
        purchasedAt: '1970-01-01T00:00:01.000Z',
        token: 'legacy-paid',
        quantity: 1,
      },
      {
        sku: 'gems.small',
        transactionId: await createGooglePlayTokenPurchaseKey('legacy-pending'),
        state: 'pending',
        token: 'legacy-pending',
        quantity: 1,
      },
    ]);
    // Only an explicit acknowledgement finishes a purchased entry.
    plugin.upsert({
      products: ['gems.small'], purchaseToken: 'legacy-paid', orderId: 'GPA.legacy',
      purchaseState: 'purchased', isAcknowledged: true,
    } as never);
    expect((await sdk.getAvailablePurchases({})).map((purchase) => purchase.token)).toEqual([]);
  });

  it('emits purchase updates in the order the plugin delivered them', async () => {
    const { sdk, plugin } = createSdk();
    const events: StoreSdkEvent[] = [];
    sdk.addListener('purchaseUpdated', (event) => {
      events.push(event);
    });
    sdk.addListener('purchaseError', (event) => {
      events.push(event);
    });
    await flush();
    // The pending update has no order id, so its conversion awaits the token
    // digest; the purchased update that follows resolves immediately.
    plugin.emit({
      status: 'pending',
      purchase: fakePlayPurchase({ purchaseToken: 'same-token', purchaseState: 'pending' }),
    });
    plugin.emit({
      status: 'purchased',
      purchase: fakePlayPurchase({ purchaseToken: 'same-token', orderId: 'GPA.same' }),
    });
    plugin.emit({ status: 'purchased', purchase: fakePlayPurchase({ purchaseToken: ' bad' }) });
    plugin.emit({ status: 'cancelled', productId: 'gems.small' });
    await until(() => events.length === 4);
    expect(events.map((event) => event.type === 'purchaseUpdated'
      ? [event.purchase.state, event.purchase.transactionId]
      : [event.type, event.error.code])).toEqual([
      ['pending', await createGooglePlayTokenPurchaseKey('same-token')],
      ['purchased', 'GPA.same'],
      ['purchaseError', 'PLAY_BILLING_EVIDENCE_INVALID'],
      ['purchaseError', 'USER_CANCELLED'],
    ]);
  });

  it('reports a late terminal result for a timed-out product as a purchase error', async () => {
    const { sdk, plugin } = createSdk();
    const events: StoreSdkEvent[] = [];
    sdk.addListener('purchaseError', (event) => {
      events.push(event);
    });
    sdk.addListener('purchaseUpdated', (event) => {
      events.push(event);
    });
    plugin.queuePurchase({
      throws: Object.assign(new Error('timed out'), { code: 'PLAY_BILLING_TIMEOUT' }),
    });
    expect(await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding }))
      .toMatchObject({ outcome: 'failed', error: { code: 'PLAY_BILLING_TIMEOUT' } });
    // The Java plugin delivers the result that arrives after its 180 s timeout
    // as a purchaseUpdated event correlated to the timed-out product.
    plugin.emit({ status: 'cancelled', productId: 'gems.small' });
    plugin.emit({ status: 'failed', productId: 'remove.ads', code: 'PLAY_BILLING_TRANSIENT_ERROR' });
    plugin.emit({ status: 'failed', productId: 'gems.small' });
    // Uncorrelated or unknown-product results close nothing.
    plugin.emit({ status: 'cancelled' });
    plugin.emit({ status: 'cancelled', productId: 'retired.sku' });
    plugin.emit({ status: 'pending', productId: 'gems.small' });
    await until(() => events.length === 3);
    await flush();
    expect(events).toEqual([
      {
        type: 'purchaseError',
        sku: 'gems.small',
        error: { code: 'USER_CANCELLED', retryable: false, message: 'Purchase cancelled.' },
      },
      {
        type: 'purchaseError',
        sku: 'remove.ads',
        error: expect.objectContaining({ code: 'PLAY_BILLING_TRANSIENT_ERROR' }),
      },
      {
        type: 'purchaseError',
        sku: 'gems.small',
        error: expect.objectContaining({ code: 'PLAY_BILLING_ERROR' }),
      },
    ]);
  });

  it('derives the transaction id from the order id or the token key', async () => {
    expect(await toPlayBillingSdkPurchase(fakePlayPurchase({
      purchaseToken: 'tok',
      orderId: '  GPA.42 ',
      quantity: 3,
      purchaseTime: 0,
      obfuscatedAccountId: 'p1',
    }))).toEqual({
      sku: 'gems.small',
      transactionId: 'GPA.42',
      state: 'purchased',
      token: 'tok',
      quantity: 3,
      accountBinding: { kind: 'obfuscated-account-id', value: 'p1' },
    });
    const keyed = await toPlayBillingSdkPurchase(fakePlayPurchase({ purchaseToken: 'tok', orderId: ' ' }));
    expect(keyed.transactionId).toBe(await createGooglePlayTokenPurchaseKey('tok'));
    expect(keyed.transactionId).toMatch(/^play-token-sha256:[0-9a-f]{64}$/u);
    // The retired 0.1 names (`productIds`, `state`, `purchaseTimeMillis`) are not read.
    await expect(toPlayBillingSdkPurchase({
      productIds: ['gems.small'],
      purchaseToken: 'legacy',
      state: 'purchased',
      purchaseTimeMillis: 1_000,
    } as never)).rejects.toMatchObject({ code: 'PLAY_BILLING_EVIDENCE_INVALID' });
    expect(await toPlayBillingSdkPurchase({
      products: ['gems.small'],
      purchaseToken: 'current',
      purchaseState: 'purchased',
      purchaseTime: 1_000,
      productIds: ['other.sku'],
      purchaseTimeMillis: 5_000,
    } as never)).toMatchObject({ sku: 'gems.small', purchasedAt: '1970-01-01T00:00:01.000Z' });
    await expect(toPlayBillingSdkPurchase(fakePlayPurchase({ purchaseToken: 'bad\u0001' })))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_EVIDENCE_INVALID' });
    await expect(toPlayBillingSdkPurchase(fakePlayPurchase({ purchaseToken: 't', products: [] })))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_EVIDENCE_INVALID' });
    expect(isValidPlayPurchaseToken('ok-token')).toBe(true);
    expect(isValidPlayPurchaseToken('x'.repeat(4097))).toBe(false);
  });

  it('attaches one plugin listener for all SDK listeners and forwards updates and integrity errors', async () => {
    const { sdk, plugin } = createSdk();
    const events: StoreSdkEvent[] = [];
    const push = (event: StoreSdkEvent): void => {
      events.push(event);
    };
    expect(plugin.listenerCount).toBe(0);
    const detachUpdated = sdk.addListener('purchaseUpdated', push);
    const detachError = sdk.addListener('purchaseError', push);
    await flush();
    expect(plugin.listenerCount).toBe(1);

    plugin.report(fakePlayPurchase({ purchaseToken: 'late', orderId: 'GPA.late' }));
    plugin.emit({ status: 'cancelled' });
    plugin.emit({ status: 'purchased', purchase: fakePlayPurchase({ purchaseToken: ' bad' }) });
    await until(() => events.length === 2);
    expect(events).toEqual([
      { type: 'purchaseUpdated', purchase: expect.objectContaining({ transactionId: 'GPA.late' }) },
      {
        type: 'purchaseError',
        sku: 'gems.small',
        error: expect.objectContaining({ code: 'PLAY_BILLING_EVIDENCE_INVALID' }),
      },
    ]);

    detachUpdated();
    await flush();
    expect(plugin.listenerCount).toBe(1);
    detachError();
    detachError();
    await flush();
    expect(plugin.listenerCount).toBe(0);
    plugin.report(fakePlayPurchase({ purchaseToken: 'after', orderId: 'GPA.after' }));
    await flush();
    expect(events).toHaveLength(2);
  });

  it('reports availability from the Android check, configuration, and service state', async () => {
    const offAndroid = createSdk(undefined, () => false);
    expect(await offAndroid.sdk.getAvailability()).toBe('unsupported');
    await expect(offAndroid.sdk.fetchProducts({ skus: ['gems.small'], type: 'all' }))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_ANDROID_REQUIRED' });
    await expect(offAndroid.sdk.getAvailablePurchases({}))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_ANDROID_REQUIRED' });

    const { sdk, plugin } = createSdk();
    expect(await sdk.getAvailability()).toBe('available');
    plugin.failure = () => Object.assign(new Error('x'), { code: 'PLAY_BILLING_CONFIGURATION_ERROR' });
    expect(await sdk.getAvailability()).toBe('configuration-required');
    plugin.failure = () => Object.assign(new Error('x'), { code: 'PLAY_BILLING_NETWORK_ERROR' });
    expect(await sdk.getAvailability()).toBe('temporarily-unavailable');
    await expect(sdk.getAvailablePurchases({}))
      .rejects.toMatchObject({ code: 'PLAY_BILLING_NETWORK_ERROR' });
    // A shell built without the native plugin answers Capacitor's UNIMPLEMENTED.
    plugin.failure = () => Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' });
    expect(await sdk.getAvailability()).toBe('configuration-required');
    plugin.failure = undefined;

    const unsold = createCapacitorPlayBillingStoreSdk({
      plugin,
      isAndroid: () => true,
      products: [{ sku: 'not.listed', kind: 'consumable' }],
    });
    expect(await unsold.getAvailability()).toBe('configuration-required');
  });

  it('extends the default error map with every plugin code', () => {
    for (const [code, mapped] of Object.entries(defaultStoreSdkErrorCodeMap)) {
      expect(playBillingStoreSdkErrorCodeMap[code]).toBe(mapped);
    }
    expect(playBillingStoreSdkErrorCodeMap).toMatchObject({
      PLAY_BILLING_BUSY: 'IN_PROGRESS',
      PLAY_BILLING_OFFER_REQUIRED: 'CONFIGURATION_REQUIRED',
      PLAY_BILLING_INVALID_PRODUCTS: 'CONFIGURATION_REQUIRED',
      PLAY_BILLING_INVALID_PRODUCT: 'CONFIGURATION_REQUIRED',
      PLAY_BILLING_INVALID_REQUEST: 'CONFIGURATION_REQUIRED',
      PLAY_BILLING_ACTIVITY_REQUIRED: 'NOT_PREPARED',
      PLAY_BILLING_ANDROID_REQUIRED: 'STORE_UNAVAILABLE',
      PLAY_BILLING_ERROR: 'UNKNOWN',
    });
  });
});
