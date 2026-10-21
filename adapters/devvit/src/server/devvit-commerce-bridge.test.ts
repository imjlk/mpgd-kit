import { describe, expect, it, vi } from 'vitest';

import type { PaymentsClient } from '@devvit/web/server';
import { bridgeCommerceV2Methods, type BridgeRequest, type BridgeResponse } from '@mpgd/bridge';
import { commerceProtocol, commerceProtocolVersion } from '@mpgd/platform/commerce';

import {
  createDevvitCommerceCapabilities,
  devvitOrderEvidenceSchema,
  maximumDevvitAvailableOrders,
} from '../commerce-contract.js';
import {
  createDevvitCommerceV2BridgeHandler,
  devvitCommerceCheckoutClientOnlyBridgeErrorCode,
  devvitCommerceV2InvalidPayloadBridgeErrorCode,
  devvitCommerceV2MethodUnsupportedBridgeErrorCode,
  devvitOrderScanIncompleteBridgeErrorCode,
  devvitPaymentsUnavailableBridgeErrorCode,
  maximumDevvitOrderScanPages,
  type DevvitPaymentsOrderLike,
  type DevvitPaymentsProductLike,
  type DevvitServerPaymentsLike,
} from './commerce-bridge.js';

// The structural plugin surface must accept the real `payments` client of
// `@devvit/payments/server` (re-exported by `@devvit/web/server`).
const paymentsClientFits: DevvitServerPaymentsLike = null as unknown as PaymentsClient;
void paymentsClientFits;

const products = [
  { productId: 'COINS_100', sku: 'coins_100' },
  { productId: 'EMBER_THEME', sku: 'ember_theme' },
] as const;

function order(input: Partial<DevvitPaymentsOrderLike> & { readonly id: string }): DevvitPaymentsOrderLike {
  return {
    status: 3,
    createdAt: '2026-10-12T00:00:00Z',
    updatedAt: '2026-10-12T00:00:05Z',
    products: [{ sku: 'coins_100' }],
    environment: 2,
    ...input,
  };
}

function request(method: BridgeRequest['method'], payload: unknown): BridgeRequest {
  return {
    id: 'req',
    method,
    payload,
    meta: {
      target: 'reddit',
      appVersion: '1.0.0',
      buildId: 'build',
      sentAt: '2026-10-12T00:00:00.000Z',
    },
  };
}

function createFixture(input: {
  readonly pages?: readonly (readonly DevvitPaymentsOrderLike[])[];
  readonly catalog?: readonly DevvitPaymentsProductLike[];
  readonly configured?: readonly { readonly productId: string; readonly sku: string }[];
  readonly failing?: boolean;
  readonly warn?: (message: string) => void;
} = {}) {
  const pages = input.pages ?? [[]];
  const getOrders = vi.fn(async (filters: { readonly limit: number; readonly cursor?: string }) => {
    if (input.failing) {
      throw new Error('payments down');
    }
    const index = filters.cursor === undefined ? 0 : Number(filters.cursor);
    const page = pages[index] ?? [];
    const hasNextPage = index + 1 < pages.length;
    return {
      orders: page,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : '' },
    };
  });
  const getProducts = vi.fn(async () => {
    if (input.failing) {
      throw new Error('payments down');
    }
    return { products: input.catalog ?? [] };
  });
  const handler = createDevvitCommerceV2BridgeHandler({
    payments: { getOrders, getProducts },
    products: input.configured ?? products,
    warn: input.warn ?? (() => {}),
  });
  return { handler, getOrders, getProducts };
}

function data(response: BridgeResponse): unknown {
  if (!response.ok) {
    throw new Error(`Unexpected bridge error ${response.error.code}: ${response.error.message}`);
  }
  return response.data;
}

function error(response: BridgeResponse): { readonly code: string; readonly retryable: boolean } {
  if (response.ok) {
    throw new Error('Expected a bridge error.');
  }
  return { code: response.error.code, retryable: response.error.retryable };
}

describe('createDevvitCommerceV2BridgeHandler', () => {
  it('answers the devvit profile, configuration-required without products', async () => {
    const { handler } = createFixture();
    expect(data(await handler.request(
      request('commerce.v2.getCapabilities', { protocol: commerceProtocol }),
    ))).toEqual({
      protocolVersion: commerceProtocolVersion,
      store: 'devvit',
      capabilities: createDevvitCommerceCapabilities('available'),
    });
    const empty = createFixture({ configured: [] });
    expect(data(await empty.handler.request(
      request('commerce.v2.getCapabilities', { protocol: commerceProtocol }),
    ))).toMatchObject({ capabilities: { availability: 'configuration-required' } });
    expect(error(await handler.request(request('commerce.v2.getCapabilities', {}))).code).toBe(
      devvitCommerceV2InvalidPayloadBridgeErrorCode,
    );
  });

  it('lists configured products from the payments plugin priced in Reddit Gold', async () => {
    const { handler, getProducts } = createFixture({
      catalog: [
        {
          sku: 'coins_100',
          name: '100 Coins',
          description: 'Adds 100 coins.',
          price: { amount: 5, currency: 200 },
          accountingType: 3,
        },
        {
          sku: 'ember_theme',
          name: 'Ember theme',
          description: 'A durable theme.',
          price: { amount: 25, currency: 'GOLD' },
          accountingType: 'DURABLE',
        },
        {
          sku: 'weekly_boost',
          name: 'Weekly boost',
          description: 'Valid for seven days.',
          price: { amount: 10, currency: 200 },
          accountingType: 5,
        },
        {
          sku: 'foreign_sku',
          name: 'Not ours',
          description: 'Configured elsewhere.',
          accountingType: 3,
        },
      ],
    });
    expect(data(await handler.request(request('commerce.v2.fetchProducts', {})))).toEqual({
      products: [
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
          description: 'A durable theme.',
          price: { formatted: '25 Gold', currencyCode: 'GOLD' },
        },
      ],
    });
    expect(getProducts).toHaveBeenLastCalledWith({ skus: ['coins_100', 'ember_theme'] });
    expect(data(await handler.request(
      request('commerce.v2.fetchProducts', { logicalIds: ['EMBER_THEME'] }),
    ))).toMatchObject({ products: [{ logicalId: 'EMBER_THEME' }] });
    expect(data(await handler.request(
      request('commerce.v2.fetchProducts', { type: 'subscription' }),
    ))).toEqual({ products: [] });
    expect(getProducts).toHaveBeenCalledTimes(2);
  });

  it('lists the paid and delivered orders of configured SKUs as purchased with order evidence', async () => {
    const { handler, getOrders } = createFixture({
      pages: [
        [
          order({ id: 'order-paid' }),
          order({ id: 'order-paid-named', status: 'PAID', products: [{ sku: 'ember_theme' }], environment: 'SANDBOX' }),
          order({ id: 'order-delivered', status: 4 }),
          order({ id: 'order-new', status: 1 }),
          order({ id: 'order-reverted', status: 'REVERTED' }),
          order({ id: 'order-two-products', products: [{ sku: 'coins_100' }, { sku: 'ember_theme' }] }),
          order({ id: 'order-foreign', products: [{ sku: 'foreign_sku' }] }),
          order({ id: 'order-no-time', createdAt: null, updatedAt: null }),
        ],
        [order({ id: 'order-page-2', updatedAt: 'not a date', createdAt: '2026-10-11T00:00:00Z' })],
      ],
    });
    const response = data(await handler.request(request('commerce.v2.getAvailablePurchases', {}))) as {
      readonly purchases: readonly Record<string, unknown>[];
    };
    expect(response.purchases).toEqual([
      {
        store: 'devvit',
        transactionId: 'order-paid',
        storeSku: 'coins_100',
        logicalId: 'COINS_100',
        quantity: 1,
        state: 'purchased',
        purchasedAt: '2026-10-12T00:00:05.000Z',
        token: 'order-paid',
        evidence: {
          schema: devvitOrderEvidenceSchema,
          payload: {
            orderId: 'order-paid',
            sku: 'coins_100',
            source: 'order-list',
            environment: 'production',
            status: 'PAID',
          },
        },
        accountBinding: { kind: 'host-identity' },
      },
      expect.objectContaining({
        transactionId: 'order-paid-named',
        logicalId: 'EMBER_THEME',
        evidence: {
          schema: devvitOrderEvidenceSchema,
          payload: expect.objectContaining({ environment: 'sandbox', status: 'PAID' }),
        },
      }),
      // Delivered orders are listed too, marked as such: the fulfillment handler settled them.
      expect.objectContaining({
        transactionId: 'order-delivered',
        evidence: { schema: devvitOrderEvidenceSchema, payload: expect.objectContaining({ status: 'DELIVERED' }) },
      }),
      expect.objectContaining({ transactionId: 'order-no-time' }),
      expect.objectContaining({ transactionId: 'order-page-2' }),
    ]);
    expect(response.purchases[3]).not.toHaveProperty('purchasedAt');
    // The unparseable `updatedAt` is not a time; the order is listed without one.
    expect(response.purchases[4]).not.toHaveProperty('purchasedAt');
    expect(getOrders).toHaveBeenCalledTimes(2);
    expect(getOrders).toHaveBeenNthCalledWith(1, { limit: maximumDevvitAvailableOrders });
    expect(getOrders).toHaveBeenNthCalledWith(2, { limit: maximumDevvitAvailableOrders, cursor: '1' });
  });

  it('pages through canceled orders until the cursor ends, including a paid order behind them', async () => {
    const warnings: string[] = [];
    const { handler, getOrders } = createFixture({
      pages: [
        [order({ id: 'order-paid' }), order({ id: 'order-canceled', status: 5 })],
        [order({ id: 'order-old-canceled', status: 5 }), order({ id: 'order-old-reverted', status: 6 })],
        [order({ id: 'order-older-new', status: 1 })],
        [order({ id: 'order-ancient-paid' })],
      ],
      warn: (message) => warnings.push(message),
    });
    const response = data(await handler.request(request('commerce.v2.getAvailablePurchases', {}))) as {
      readonly purchases: readonly { readonly transactionId: string }[];
    };
    // Two pages of canceled or new orders used to stop the scan. The paid order behind them is listed.
    expect(response.purchases.map((purchase) => purchase.transactionId)).toEqual([
      'order-paid',
      'order-ancient-paid',
    ]);
    expect(getOrders).toHaveBeenCalledTimes(4);
    expect(warnings).toEqual([]);

    // One page of non-paid orders is not a reason to stop: the next page is still read.
    const single = createFixture({
      pages: [
        [order({ id: 'order-canceled', status: 5 })],
        [order({ id: 'order-ours' })],
      ],
    });
    const ours = data(await single.handler.request(request('commerce.v2.getAvailablePurchases', {}))) as {
      readonly purchases: readonly { readonly transactionId: string }[];
    };
    expect(ours.purchases.map((purchase) => purchase.transactionId)).toEqual(['order-ours']);
    expect(single.getOrders).toHaveBeenCalledTimes(2);

    // A paid order behind more than two full pages of canceled orders is still listed.
    const buried = createFixture({
      pages: [
        Array.from({ length: maximumDevvitAvailableOrders }, (_, index) =>
          order({ id: `canceled-a-${String(index)}`, status: 5 })),
        Array.from({ length: maximumDevvitAvailableOrders }, (_, index) =>
          order({ id: `canceled-b-${String(index)}`, status: 1 })),
        [order({ id: 'order-still-paid' })],
      ],
    });
    const stillPaid = data(await buried.handler.request(request('commerce.v2.getAvailablePurchases', {}))) as {
      readonly purchases: readonly { readonly transactionId: string }[];
    };
    expect(stillPaid.purchases.map((purchase) => purchase.transactionId)).toEqual(['order-still-paid']);
    expect(buried.getOrders).toHaveBeenCalledTimes(3);
  });

  it('fails a scan that hits the page cap with pages left instead of treating the tail as delivered', async () => {
    const pages = Array.from({ length: maximumDevvitOrderScanPages + 1 }, (_, index) => [
      order({ id: `order-canceled-${String(index)}`, status: 5 }),
    ]);
    pages[pages.length - 1] = [order({ id: 'order-beyond-cap' })];
    const { handler, getOrders } = createFixture({ pages });
    expect(error(await handler.request(request('commerce.v2.getAvailablePurchases', {})))).toEqual({
      code: devvitOrderScanIncompleteBridgeErrorCode,
      retryable: true,
    });
    expect(getOrders).toHaveBeenCalledTimes(maximumDevvitOrderScanPages);
    // The unread paid order is not returned as an empty success.
    expect(getOrders).toHaveBeenNthCalledWith(
      maximumDevvitOrderScanPages,
      { limit: maximumDevvitAvailableOrders, cursor: String(maximumDevvitOrderScanPages - 1) },
    );
  });

  it('bounds the listed orders and stops paging at the bound', async () => {
    const page = Array.from({ length: maximumDevvitAvailableOrders }, (_, index) =>
      order({ id: `order-${String(index)}` }));
    const { handler, getOrders } = createFixture({ pages: [page, page, page] });
    const response = data(await handler.request(request('commerce.v2.getAvailablePurchases', {}))) as {
      readonly purchases: readonly unknown[];
    };
    expect(response.purchases).toHaveLength(maximumDevvitAvailableOrders);
    expect(getOrders).toHaveBeenCalledTimes(1);
  });

  it('refuses the checkout and the finish on the server, and answers restore as not restored', async () => {
    const { handler } = createFixture();
    expect(error(await handler.request(request('commerce.v2.requestPurchase', {
      logicalId: 'COINS_100',
      idempotencyKey: 'op-1',
      source: 'shop',
    })))).toEqual({ code: devvitCommerceCheckoutClientOnlyBridgeErrorCode, retryable: false });
    expect(error(await handler.request(request('commerce.v2.finishTransaction', {
      transactionId: 'order-1',
      ledgerEntryId: 'le-1',
      isConsumable: true,
    })))).toEqual({ code: devvitCommerceV2MethodUnsupportedBridgeErrorCode, retryable: false });
    expect(data(await handler.request(
      request('commerce.v2.restorePurchases', { protocol: commerceProtocol }),
    ))).toEqual({ restored: false });
    expect(error(await handler.request(request('storage.load', { key: 'x' }))).code).toBe(
      'UNSUPPORTED_METHOD',
    );
    for (const method of bridgeCommerceV2Methods) {
      expect(error(await handler.request(request(method, 'not a payload'))).code).toBe(
        devvitCommerceV2InvalidPayloadBridgeErrorCode,
      );
    }
  });

  it('reports a failing payments plugin as retryable', async () => {
    const { handler } = createFixture({ failing: true });
    expect(error(await handler.request(request('commerce.v2.getAvailablePurchases', {})))).toEqual({
      code: devvitPaymentsUnavailableBridgeErrorCode,
      retryable: true,
    });
    expect(error(await handler.request(request('commerce.v2.fetchProducts', {})))).toEqual({
      code: devvitPaymentsUnavailableBridgeErrorCode,
      retryable: true,
    });
  });

  it('rejects duplicate or blank product configuration', () => {
    expect(() => createDevvitCommerceV2BridgeHandler({
      payments: { getOrders: async () => ({ orders: [] }), getProducts: async () => ({ products: [] }) },
      products: [{ productId: 'A', sku: 'a' }, { productId: 'B', sku: 'a' }],
    })).toThrow(/Duplicate Devvit product SKU/u);
    expect(() => createDevvitCommerceV2BridgeHandler({
      payments: { getOrders: async () => ({ orders: [] }), getProducts: async () => ({ products: [] }) },
      products: [{ productId: 'A', sku: ' ' }],
    })).toThrow(TypeError);
  });
});
