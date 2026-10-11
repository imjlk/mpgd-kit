import { describe, expect, it, vi } from 'vitest';

import type { CommerceEvent } from '@mpgd/platform/commerce';

import { createFakeAitIapHost, flushAitIap } from '../test/ait-iap-fixture.js';
import { createAitCommerceProvider } from './commerce-provider.js';

// The contract assert cannot be made to fail with validated host input, so
// this file alone mocks it for one order id to prove that a rejected order is
// skipped the same way on a listing read and on a signalled refresh.
vi.mock('@mpgd/platform/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mpgd/platform/commerce')>();
  return {
    ...actual,
    assertStorePurchase: (input: unknown) => {
      if (
        typeof input === 'object'
        && input !== null
        && (input as { readonly transactionId?: unknown }).transactionId === 'order-invalid'
      ) {
        throw new TypeError('fixture: order-invalid fails the StorePurchase contract');
      }
      return actual.assertStorePurchase(input);
    },
  };
});

describe('Apps in Toss commerce v2 provider with an order the contract rejects', () => {
  it('skips the rejected order on a listing read and on a refresh, keeping the others', async () => {
    const host = createFakeAitIapHost({
      products: [{ sku: 'gems.small', type: 'CONSUMABLE' }],
    });
    const provider = createAitCommerceProvider({
      dependencies: host.dependencies,
      iapProducts: [{ productId: 'gems_small', sku: 'gems.small' }],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => false,
      readIapEntitlements: async () => [],
      onPendingOrdersChanged: (listener) => host.onPendingOrdersChanged(listener),
    });
    host.pendingOrders.push(
      { orderId: 'order-invalid', sku: 'gems.small', paymentCompletedDate: '' },
      { orderId: 'order-ok', sku: 'gems.small', paymentCompletedDate: '' },
    );
    await expect(provider.getAvailablePurchases({})).resolves.toMatchObject([
      { transactionId: 'order-ok' },
    ]);

    const events: CommerceEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });
    host.signalPendingOrdersChanged();
    await flushAitIap();
    expect(events.map((event) => (event.type === 'purchaseUpdated' ? event.purchase.transactionId : event.type)))
      .toEqual(['order-ok']);
  });
});
