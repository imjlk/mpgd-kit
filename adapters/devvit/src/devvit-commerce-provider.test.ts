import { describe, expect, it, vi } from 'vitest';

import type { ProductInfo } from '@mpgd/platform';
import { CommerceError, type CommerceEvent } from '@mpgd/platform/commerce';

import {
  assertDevvitOrderEvidence,
  createDevvitCommerceCapabilities,
  devvitOrderEvidenceSchema,
  maximumDevvitAvailableOrders,
  type DevvitPaidOrder,
} from './commerce-contract.js';
import {
  createDevvitCommerceProvider,
  devvitCommerceStoreCodes,
  type DevvitOrdersChangeListener,
  type DevvitOrderSource,
} from './commerce-provider.js';
import type { DevvitCheckoutResult, DevvitCommerceProduct } from './payments.js';

const coins: DevvitCommerceProduct = {
  info: {
    id: 'COINS_100',
    type: 'consumable',
    title: '100 Coins',
    description: 'Adds 100 coins.',
    price: { formatted: '5 Gold', currencyCode: 'GOLD' },
  } satisfies ProductInfo,
  sku: 'coins_100',
};
const theme: DevvitCommerceProduct = {
  info: {
    id: 'EMBER_THEME',
    type: 'non_consumable',
    title: 'Ember theme',
    description: 'A durable cosmetic theme.',
    price: { formatted: '25 Gold', currencyCode: 'GOLD' },
  } satisfies ProductInfo,
  sku: 'ember_theme',
};
const request = {
  logicalId: 'COINS_100',
  idempotencyKey: 'op-1',
  source: 'shop',
} as const;

function createFixture(input: {
  readonly orders?: readonly DevvitPaidOrder[];
  readonly checkout?: DevvitCheckoutResult | Error;
  readonly products?: readonly DevvitCommerceProduct[];
  readonly source?: Partial<DevvitOrderSource>;
} = {}) {
  const orders = [...(input.orders ?? [])];
  const purchase = vi.fn(async (): Promise<DevvitCheckoutResult> => {
    if (input.checkout instanceof Error) {
      throw input.checkout;
    }
    return input.checkout ?? { status: 'pending' };
  });
  const listPaidOrders = vi.fn(async () => [...orders]);
  const listeners = new Set<DevvitOrdersChangeListener>();
  const onCheckoutError = vi.fn();
  const provider = createDevvitCommerceProvider({
    products: input.products ?? [coins, theme],
    client: { purchase },
    orders: { listPaidOrders, ...input.source },
    onOrdersChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onCheckoutError,
  });
  return {
    provider,
    orders,
    purchase,
    listPaidOrders,
    listeners,
    onCheckoutError,
    signal: (change?: { readonly orders?: readonly DevvitPaidOrder[] }) => {
      for (const listener of listeners) {
        listener(change);
      }
    },
  };
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

describe('createDevvitCommerceProvider', () => {
  it('declares the devvit profile with the availability the order source reports', async () => {
    const { provider } = createFixture({
      source: { getAvailability: async () => 'configuration-required' },
    });
    expect(provider.store).toBe('devvit');
    await expect(provider.getCapabilities()).resolves.toEqual(
      createDevvitCommerceCapabilities('configuration-required'),
    );
    expect(createDevvitCommerceCapabilities('available')).toMatchObject({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      lifecycle: { availablePurchases: true, pending: true, restore: true, events: true, finish: 'none' },
      authority: { evidence: 'server-push', accountBinding: 'host' },
    });
    await expect(createFixture().provider.getCapabilities()).resolves.toMatchObject({
      availability: 'available',
    });
    await expect(createFixture({ products: [] }).provider.getCapabilities()).resolves.toMatchObject({
      availability: 'configuration-required',
    });
    const failing = createFixture({
      source: {
        getAvailability: async () => {
          throw new Error('bridge down');
        },
      },
    });
    await expect(failing.provider.getCapabilities()).resolves.toMatchObject({
      availability: 'temporarily-unavailable',
    });
  });

  it('lists the configured one-time products', async () => {
    const { provider } = createFixture();
    await expect(provider.fetchProducts({})).resolves.toEqual([
      {
        logicalId: 'COINS_100',
        store: 'devvit',
        storeSku: 'coins_100',
        kind: 'consumable',
        title: '100 Coins',
        description: 'Adds 100 coins.',
        price: { formatted: '5 Gold', currencyCode: 'GOLD' },
      },
      {
        logicalId: 'EMBER_THEME',
        store: 'devvit',
        storeSku: 'ember_theme',
        kind: 'durable',
        title: 'Ember theme',
        description: 'A durable cosmetic theme.',
        price: { formatted: '25 Gold', currencyCode: 'GOLD' },
      },
    ]);
    await expect(provider.fetchProducts({ logicalIds: ['EMBER_THEME'] })).resolves.toHaveLength(1);
    await expect(provider.fetchProducts({ type: 'subscription' })).resolves.toEqual([]);
  });

  it('answers purchased with the created order id as transaction id, token, and evidence', async () => {
    const fixture = createFixture({ checkout: { status: 'completed', orderId: 'order-1' } });
    const result = await fixture.provider.requestPurchase(request);
    expect(fixture.purchase).toHaveBeenCalledWith('coins_100');
    expect(result).toEqual({
      outcome: 'purchased',
      purchase: {
        store: 'devvit',
        transactionId: 'order-1',
        storeSku: 'coins_100',
        logicalId: 'COINS_100',
        quantity: 1,
        state: 'purchased',
        token: 'order-1',
        evidence: {
          schema: devvitOrderEvidenceSchema,
          payload: { orderId: 'order-1', sku: 'coins_100', source: 'checkout' },
        },
        accountBinding: { kind: 'host-identity' },
      },
    });
    if (result.outcome === 'purchased') {
      expect(assertDevvitOrderEvidence(result.purchase.evidence)).toEqual({
        orderId: 'order-1',
        sku: 'coins_100',
        source: 'checkout',
      });
      expect(result.purchase.settlement).toBeUndefined();
    }
  });

  it('keeps an attempt open when the checkout carries no order id or is still pending', async () => {
    await expect(
      createFixture({ checkout: { status: 'completed' } }).provider.requestPurchase(request),
    ).resolves.toEqual({ outcome: 'launched' });
    const pending = createFixture({ checkout: { status: 'pending' } });
    await expect(pending.provider.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    await flush();
    // The order, if any, is in the server's list; it is re-read without waiting for a signal.
    expect(pending.listPaidOrders).toHaveBeenCalledTimes(1);
  });

  it('maps cancelled and failed checkouts and keeps the platform code as storeCode', async () => {
    await expect(
      createFixture({ checkout: { status: 'cancelled' } }).provider.requestPurchase(request),
    ).resolves.toMatchObject({
      outcome: 'cancelled',
      error: {
        code: 'USER_CANCELLED',
        retryable: false,
        storeCode: devvitCommerceStoreCodes.checkoutCancelled,
      },
    });
    await expect(
      createFixture({
        checkout: { status: 'failed', error: { code: '7', message: 'Gold balance too low.' } },
      }).provider.requestPurchase(request),
    ).resolves.toEqual({
      outcome: 'failed',
      error: { code: 'UNKNOWN', retryable: false, storeCode: '7', message: 'Gold balance too low.' },
    });
    await expect(
      createFixture({
        checkout: {
          status: 'failed',
          error: { code: 'STORE_UNAVAILABLE', storeCode: 'reddit-down', retryable: true },
        },
      }).provider.requestPurchase(request),
    ).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_UNAVAILABLE', retryable: true, storeCode: 'reddit-down' },
    });
    await expect(
      createFixture({ checkout: { status: 'failed' } }).provider.requestPurchase(request),
    ).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'UNKNOWN', storeCode: devvitCommerceStoreCodes.checkoutFailed },
    });
  });

  it('keeps OUTCOME_UNKNOWN and ALREADY_OWNED classes open as launched', async () => {
    for (const code of ['OUTCOME_UNKNOWN', 'ALREADY_OWNED']) {
      await expect(
        createFixture({ checkout: { status: 'failed', error: { code } } }).provider
          .requestPurchase(request),
      ).resolves.toEqual({ outcome: 'launched' });
    }
  });

  it('keeps an attempt open when the checkout call rejects, since the order may exist', async () => {
    const fixture = createFixture({ checkout: new Error('no response') });
    await expect(fixture.provider.requestPurchase(request)).resolves.toEqual({
      outcome: 'launched',
    });
    expect(fixture.onCheckoutError).toHaveBeenCalledTimes(1);
    await flush();
    expect(fixture.listPaidOrders).toHaveBeenCalledTimes(1);
  });

  it('treats a failed checkout classified as a cancellation as cancelled', async () => {
    await expect(
      createFixture({
        checkout: { status: 'failed', error: { code: 'USER_CANCELLED', storeCode: '0' } },
      }).provider.requestPurchase(request),
    ).resolves.toMatchObject({
      outcome: 'cancelled',
      error: { code: 'USER_CANCELLED', storeCode: '0', retryable: false },
    });
    await expect(
      createFixture({
        checkout: { status: 'cancelled', error: { code: 'USER_CANCELLED' } },
      }).provider.requestPurchase(request),
    ).resolves.toMatchObject({
      outcome: 'cancelled',
      error: { code: 'USER_CANCELLED', storeCode: devvitCommerceStoreCodes.checkoutCancelled },
    });
    await expect(
      createFixture({
        checkout: { status: 'unknown' as never },
      }).provider.requestPurchase(request),
    ).resolves.toMatchObject({ outcome: 'failed', error: { code: 'INVALID_RESPONSE' } });
  });

  it('never opens a checkout for a subscription-typed product', async () => {
    const fixture = createFixture({
      products: [{
        info: { ...coins.info, id: 'VIP', type: 'subscription' },
        sku: 'vip',
      }],
    });
    await expect(fixture.provider.requestPurchase({ ...request, logicalId: 'VIP' })).rejects
      .toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    expect(fixture.purchase).not.toHaveBeenCalled();
    await expect(fixture.provider.fetchProducts({})).resolves.toEqual([]);
  });

  it('refuses unconfigured products and quantities before the checkout opens', async () => {
    const fixture = createFixture();
    await expect(
      fixture.provider.requestPurchase({ ...request, logicalId: 'UNKNOWN' }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: devvitCommerceStoreCodes.productNotConfigured },
    });
    await expect(fixture.provider.requestPurchase({ ...request, quantity: 2 })).rejects.toThrow(
      CommerceError,
    );
    expect(fixture.purchase).not.toHaveBeenCalled();
  });

  it('lists paid orders for configured SKUs as purchased, bounded', async () => {
    const orders: DevvitPaidOrder[] = [
      { orderId: 'order-1', sku: 'coins_100', paidAt: '2026-10-12T00:00:00.000Z', environment: 'sandbox' },
      { orderId: 'order-2', sku: 'other_game_sku' },
      { orderId: ' bad ', sku: 'coins_100' },
      { orderId: 'order-3', sku: 'ember_theme' },
    ];
    const { provider } = createFixture({ orders });
    await expect(provider.getAvailablePurchases({ includePending: true })).resolves.toEqual([
      {
        store: 'devvit',
        transactionId: 'order-1',
        storeSku: 'coins_100',
        logicalId: 'COINS_100',
        quantity: 1,
        state: 'purchased',
        purchasedAt: '2026-10-12T00:00:00.000Z',
        token: 'order-1',
        evidence: {
          schema: devvitOrderEvidenceSchema,
          payload: {
            orderId: 'order-1',
            sku: 'coins_100',
            source: 'order-list',
            environment: 'sandbox',
          },
        },
        accountBinding: { kind: 'host-identity' },
      },
      expect.objectContaining({ transactionId: 'order-3', logicalId: 'EMBER_THEME' }),
    ]);
    const many = createFixture({
      orders: Array.from({ length: maximumDevvitAvailableOrders + 1 }, (_, index) => ({
        orderId: `order-${String(index)}`,
        sku: 'coins_100',
      })),
    });
    await expect(many.provider.getAvailablePurchases()).resolves.toHaveLength(
      maximumDevvitAvailableOrders,
    );
  });

  it('reports an unreadable order list as a retryable store failure', async () => {
    const { provider } = createFixture({
      source: {
        listPaidOrders: async () => {
          throw new Error('bridge down');
        },
      },
    });
    await expect(provider.getAvailablePurchases()).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
      retryable: true,
      storeCode: devvitCommerceStoreCodes.ordersUnavailable,
    });
    const commerceFailure = createFixture({
      source: {
        listPaidOrders: async () => {
          throw new CommerceError('CONFIGURATION_REQUIRED', { storeCode: 'COMMERCE_V2_UNAVAILABLE' });
        },
      },
    });
    await expect(commerceFailure.provider.getAvailablePurchases()).rejects.toMatchObject({
      code: 'CONFIGURATION_REQUIRED',
      storeCode: 'COMMERCE_V2_UNAVAILABLE',
    });
  });

  it('emits each paid order once on restore and on the order signal, buffered before the first listener', async () => {
    const fixture = createFixture({ orders: [{ orderId: 'order-1', sku: 'coins_100' }] });
    await fixture.provider.restorePurchases();
    await fixture.provider.restorePurchases();
    const events: CommerceEvent[] = [];
    const unsubscribe = fixture.provider.subscribe((event) => events.push(event));
    expect(events).toEqual([
      { type: 'purchaseUpdated', purchase: expect.objectContaining({ transactionId: 'order-1' }) },
    ]);
    expect(fixture.listeners.size).toBe(1);

    fixture.orders.push({ orderId: 'order-2', sku: 'ember_theme' });
    fixture.signal();
    await flush();
    expect(events.map((event) => event.type === 'purchaseUpdated' && event.purchase.transactionId))
      .toEqual(['order-1', 'order-2']);

    // A delivered order leaves the list; a re-listed one is reported again.
    fixture.orders.splice(0, 1);
    fixture.signal();
    await flush();
    fixture.orders.unshift({ orderId: 'order-1', sku: 'coins_100' });
    fixture.signal();
    await flush();
    expect(events).toHaveLength(3);

    // An order the signal carries is reported before the list read confirms it.
    fixture.signal({ orders: [{ orderId: 'order-9', sku: 'ember_theme' }, { orderId: 'x', sku: 'nope' }] });
    expect(events).toHaveLength(4);
    expect(events[3]).toMatchObject({ purchase: { transactionId: 'order-9', logicalId: 'EMBER_THEME' } });

    unsubscribe();
    expect(fixture.listeners.size).toBe(0);
  });

  it('answers purchased for a checkout order and does not report it again from the list', async () => {
    const fixture = createFixture({ checkout: { status: 'completed', orderId: 'order-1' } });
    const events: CommerceEvent[] = [];
    fixture.provider.subscribe((event) => events.push(event));
    await fixture.provider.requestPurchase(request);
    fixture.orders.push({ orderId: 'order-1', sku: 'coins_100' });
    await fixture.provider.restorePurchases();
    expect(events).toEqual([]);
    await expect(fixture.provider.getAvailablePurchases()).resolves.toHaveLength(1);
  });

  it('runs under a caller-supplied store id', async () => {
    const provider = createDevvitCommerceProvider({
      store: 'fixture.server-push',
      products: [coins],
      client: { purchase: async () => ({ status: 'completed', orderId: 'order-1' }) },
      orders: { listPaidOrders: async () => [] },
    });
    expect(provider.store).toBe('fixture.server-push');
    await expect(provider.requestPurchase(request)).resolves.toMatchObject({
      purchase: { store: 'fixture.server-push' },
    });
    expect(() => createDevvitCommerceProvider({
      store: '',
      products: [coins],
      client: { purchase: async () => ({ status: 'pending' }) },
      orders: { listPaidOrders: async () => [] },
    })).toThrow(TypeError);
  });

  it('validates devvit.order.v1 evidence the way a server registry entry must', () => {
    expect(() => assertDevvitOrderEvidence({ schema: 'other', payload: {} })).toThrow(TypeError);
    expect(() => assertDevvitOrderEvidence({
      schema: devvitOrderEvidenceSchema,
      payload: { orderId: 'order-1', sku: 'coins_100', source: 'webhook' },
    })).toThrow(TypeError);
    expect(() => assertDevvitOrderEvidence({
      schema: devvitOrderEvidenceSchema,
      payload: { orderId: '', sku: 'coins_100', source: 'checkout' },
    })).toThrow(TypeError);
    expect(() => assertDevvitOrderEvidence({
      schema: devvitOrderEvidenceSchema,
      payload: { orderId: 'order-1', sku: 'coins_100', source: 'checkout', environment: 'staging' },
    })).toThrow(TypeError);
    expect(assertDevvitOrderEvidence({
      schema: devvitOrderEvidenceSchema,
      payload: { orderId: 'order-1', sku: 'coins_100', source: 'order-list', environment: 'production' },
    })).toEqual({ orderId: 'order-1', sku: 'coins_100', source: 'order-list', environment: 'production' });
  });
});
