import { describe, expect, it, vi } from 'vitest';

import {
  CommerceError,
  commerceErrorCodes,
  type CommerceEvent,
  type StorePurchase,
} from '@mpgd/platform/commerce';

import { createFakeAitIapHost, flushAitIap, type FakeAitIapHost } from '../test/ait-iap-fixture.js';
import {
  aitCommerceStoreId,
  aitIapCommerceErrorCodeMap,
  createAitCommerceProvider,
  createAitCommerceProviderFromController,
  type AitCommerceProvider,
  type CreateAitCommerceProviderInput,
} from './commerce-provider.js';
import { aitIapDiagnosticCodes } from './iap-diagnostics.js';
import { createAitIapController, type AitIapProductGrantVerificationInput } from './iap.js';

const products = [
  { productId: 'gems_small', sku: 'gems.small' },
  { productId: 'remove_ads', sku: 'remove.ads' },
] as const;

const catalog = [
  { sku: 'gems.small', type: 'CONSUMABLE', displayName: 'Small gems', displayAmount: 'KRW 1,100' },
  {
    sku: 'remove.ads',
    type: 'NON_CONSUMABLE',
    displayName: 'Remove ads',
    displayAmount: 'KRW 5,500',
  },
  { sku: 'vip.monthly', type: 'SUBSCRIPTION', displayName: 'VIP' },
] as const;

const ackBarrierKey = 'mpgd:ait:iap-ack-in-flight:v1';

type Verifier = ReturnType<
  typeof vi.fn<(input: AitIapProductGrantVerificationInput) => Promise<boolean>>
>;

function setup(
  overrides: Partial<CreateAitCommerceProviderInput> = {},
  hostInput: Parameters<typeof createFakeAitIapHost>[0] = { products: catalog },
): {
  readonly host: FakeAitIapHost;
  readonly provider: AitCommerceProvider;
  readonly verifier: Verifier;
  readonly events: CommerceEvent[];
  readonly listen: () => () => void;
} {
  const host = createFakeAitIapHost(hostInput);
  const verifier: Verifier = vi.fn(async () => false);
  const provider = createAitCommerceProvider({
    dependencies: host.dependencies,
    iapProducts: [...products, { productId: 'vip', sku: 'vip.monthly' }],
    prepareIap: async () => true,
    verifyIapProductGrant: verifier,
    readIapEntitlements: async () => [],
    onPendingOrdersChanged: (listener) => host.onPendingOrdersChanged(listener),
    ...overrides,
  });
  const events: CommerceEvent[] = [];
  return {
    host,
    provider,
    verifier,
    events,
    listen: () =>
      provider.subscribe((event) => {
        events.push(event);
      }),
  };
}

function purchased(events: readonly CommerceEvent[]): readonly StorePurchase[] {
  return events.flatMap((event) => (event.type === 'purchaseUpdated' ? [event.purchase] : []));
}

function finish(provider: AitCommerceProvider, orderId: string, ledgerEntryId = `le-${orderId}`) {
  return provider.finishTransaction({ transactionId: orderId, ledgerEntryId, isConsumable: true });
}

describe('Apps in Toss commerce v2 provider', () => {
  it('declares the apps-in-toss host-finish profile and a fresh block per read', async () => {
    const { provider } = setup();
    const first = await provider.getCapabilities();
    expect(first).toEqual({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: true },
      lifecycle: {
        availablePurchases: true,
        pending: true,
        restore: true,
        events: true,
        finish: 'host',
      },
      authority: { evidence: 'host-callback', accountBinding: 'host' },
      availability: 'available',
    });
    expect(await provider.getCapabilities()).not.toBe(first);
    expect(provider.store).toBe(aitCommerceStoreId);
  });

  it('reports configuration-required without the server hooks and unsupported without the native methods', async () => {
    const unconfigured = setup({ verifyIapProductGrant: undefined });
    expect((await unconfigured.provider.getCapabilities()).availability).toBe(
      'configuration-required',
    );
    await expect(unconfigured.provider.fetchProducts({})).resolves.toEqual([]);
    await expect(
      unconfigured.provider.getAvailablePurchases({ includePending: true }),
    ).resolves.toEqual([]);
    await expect(unconfigured.provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-1',
      source: 'shop',
    })).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'CONFIGURATION_REQUIRED',
        retryable: false,
        storeCode: aitIapDiagnosticCodes.unavailable,
        message: expect.stringContaining(aitIapDiagnosticCodes.unavailable),
      },
    });
    expect(unconfigured.host.checkoutCalls).toHaveLength(0);
    await expect(finish(unconfigured.provider, 'order-0')).resolves.toEqual({ finished: false });

    const { host, provider } = setup();
    host.supported = false;
    expect((await provider.getCapabilities()).availability).toBe('unsupported');
  });

  it('lists one-time products from the native catalog and hides subscriptions', async () => {
    const { provider } = setup();
    await expect(provider.fetchProducts({})).resolves.toEqual([
      {
        logicalId: 'gems_small',
        store: 'apps-in-toss',
        storeSku: 'gems.small',
        kind: 'consumable',
        title: 'Small gems',
        description: 'Fixture product gems.small',
        price: { formatted: 'KRW 1,100', currencyCode: 'KRW' },
      },
      {
        logicalId: 'remove_ads',
        store: 'apps-in-toss',
        storeSku: 'remove.ads',
        kind: 'durable',
        title: 'Remove ads',
        description: 'Fixture product remove.ads',
        price: { formatted: 'KRW 5,500', currencyCode: 'KRW' },
      },
    ]);
    await expect(provider.fetchProducts({ logicalIds: ['remove_ads'] })).resolves.toMatchObject([
      { logicalId: 'remove_ads' },
    ]);
    await expect(provider.fetchProducts({ type: 'subscription' })).resolves.toEqual([]);
  });

  it('maps a catalog failure to a commerce error that keeps the AIT code', async () => {
    const { host, provider } = setup();
    host.catalogError = { code: 'NATIVE_DOWN', message: 'down' };
    await expect(provider.fetchProducts({})).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
      storeCode: aitIapDiagnosticCodes.catalogUnavailable,
      retryable: true,
    });
  });

  it('answers purchased only after the server confirmed the grant in the host callback', async () => {
    const { host, provider, verifier, events, listen } = setup();
    listen();
    verifier.mockResolvedValue(true);
    host.queueCheckout({ kind: 'grant', orderId: 'order-1' });

    const result = await provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-1',
      source: 'shop',
    });
    expect(result).toEqual({
      outcome: 'purchased',
      purchase: {
        store: 'apps-in-toss',
        transactionId: 'order-1',
        storeSku: 'gems.small',
        logicalId: 'gems_small',
        quantity: 1,
        state: 'purchased',
        token: 'order-1',
        evidence: {
          schema: 'apps-in-toss.iap.callback.v1',
          payload: { orderId: 'order-1', sku: 'gems.small', source: 'process-product-grant' },
        },
        accountBinding: { kind: 'host-identity' },
      },
    });
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1',
      platformSku: 'gems.small',
      idempotencyKey: 'apps-in-toss:purchase:order-1',
      clientIdempotencyKey: 'op-1',
      source: 'process-product-grant',
    }));
    // The SDK completed the order after the grant callback: it stays available
    // until the reconciler finishes it, and the finish needs no native call.
    expect(host.completeCalls).toHaveLength(0);
    await expect(provider.getAvailablePurchases({})).resolves.toMatchObject([
      { transactionId: 'order-1', state: 'purchased' },
    ]);
    await expect(finish(provider, 'order-1', 'le-1')).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toHaveLength(0);
    await expect(provider.getAvailablePurchases({})).resolves.toEqual([]);
    expect(events).toEqual([]);
  });

  it('never produces a purchased result when the server refuses the grant', async () => {
    const { host, provider, verifier, listen, events } = setup();
    listen();
    verifier.mockResolvedValue(false);
    host.queueCheckout({ kind: 'grant', orderId: 'order-2' });

    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-2',
      source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });
    // The paid order waits in the provider's list; the reconciler verifies it
    // from there, and the launched result reads the list at once.
    expect(host.completeCalls).toHaveLength(0);
    await flushAitIap();
    expect(purchased(events)).toMatchObject([
      {
        transactionId: 'order-2',
        state: 'purchased',
        token: 'order-2',
        evidence: {
          schema: 'apps-in-toss.iap.callback.v1',
          payload: { orderId: 'order-2', sku: 'gems.small', source: 'pending-order-restore' },
        },
      },
    ]);
    await expect(provider.getAvailablePurchases({ includePending: true })).resolves.toMatchObject([
      { transactionId: 'order-2', state: 'purchased' },
    ]);
  });

  it('keeps a checkout the host could not settle open and lists its order as pending until the host lists it', async () => {
    const { host, provider, verifier, listen, events } = setup();
    listen();
    // The grant callback refuses and the direct re-verify refuses too. The
    // fake SDK lists a paid order at once; the re-verify takes it off the list
    // again to model the lag right after checkout.
    verifier.mockImplementation(async () => {
      host.pendingOrders.splice(0, host.pendingOrders.length);
      return false;
    });
    host.queueCheckout({ kind: 'grant', orderId: 'order-3' });
    await expect(provider.requestPurchase({
      logicalId: 'remove_ads',
      idempotencyKey: 'op-3',
      source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });
    expect(verifier).toHaveBeenCalledTimes(2);
    await flushAitIap();
    expect(purchased(events)).toEqual([]);
    await expect(provider.getAvailablePurchases({ includePending: true })).resolves.toMatchObject([
      { transactionId: 'order-3', state: 'pending', storeSku: 'remove.ads' },
    ]);
    await expect(provider.getAvailablePurchases({})).resolves.toEqual([]);

    host.addPendingOrder({
      orderId: 'order-3',
      sku: 'remove.ads',
      paymentCompletedDate: '2026-10-02T03:04:05Z',
    });
    await flushAitIap();
    expect(purchased(events)).toMatchObject([
      { transactionId: 'order-3', state: 'purchased', purchasedAt: '2026-10-02T03:04:05.000Z' },
    ]);
    await expect(provider.getAvailablePurchases({ includePending: true })).resolves.toMatchObject([
      { transactionId: 'order-3', state: 'purchased' },
    ]);
  });

  it('maps a cancellation, a failure before an order, and a busy IAP lock', async () => {
    const { host, provider } = setup();
    host.queueCheckout({ kind: 'cancel' });
    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-4',
      source: 'shop',
    })).resolves.toEqual({
      outcome: 'cancelled',
      error: { code: 'USER_CANCELLED', retryable: false, message: expect.any(String) },
    });

    // An error before any order is observed is not terminal for the host
    // (its marker stays), so the attempt stays launched.
    host.queueCheckout({ kind: 'error', error: { code: 'NATIVE_CHECKOUT_FAILED' } });
    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-5',
      source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });

    host.queueCheckout({ kind: 'hang' });
    const hanging = provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-6',
      source: 'shop',
    });
    await flushAitIap();
    await expect(provider.requestPurchase({
      logicalId: 'remove_ads',
      idempotencyKey: 'op-7',
      source: 'shop',
    })).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'IN_PROGRESS',
        retryable: true,
        storeCode: aitIapDiagnosticCodes.checkoutInProgress,
        message: expect.any(String),
      },
    });
    await expect(finish(provider, 'order-x')).resolves.toEqual({ finished: false });
    await expect(provider.restorePurchases()).rejects.toMatchObject({
      code: 'IN_PROGRESS',
      storeCode: aitIapDiagnosticCodes.checkoutInProgress,
    });
    void hanging;
  });

  it('rejects an unconfigured product and a quantity above one before any checkout', async () => {
    const { host, provider } = setup();
    await expect(provider.requestPurchase({
      logicalId: 'unknown',
      idempotencyKey: 'op-8',
      source: 'shop',
    })).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'ITEM_UNAVAILABLE',
        retryable: false,
        storeCode: aitIapDiagnosticCodes.productNotConfigured,
        message: expect.any(String),
      },
    });
    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-9',
      source: 'shop',
      quantity: 2,
    })).rejects.toBeInstanceOf(CommerceError);
    expect(host.checkoutCalls).toHaveLength(0);
  });

  it('finishes a listed order with completeProductGrant only with a ledger entry id and a confirmed grant', async () => {
    const { host, provider, verifier } = setup();
    host.addPendingOrder({ orderId: 'order-10', sku: 'gems.small', paymentCompletedDate: '' });
    await expect(finish(provider, 'order-10', '')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(verifier).not.toHaveBeenCalled();
    expect(host.completeCalls).toEqual([]);

    // A ledger entry id claimed over the bridge is not enough: the host asks
    // its own server hook first.
    verifier.mockResolvedValue(false);
    await expect(finish(provider, 'order-10', 'le-10')).resolves.toEqual({ finished: false });
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-10',
      idempotencyKey: 'apps-in-toss:purchase:order-10',
      source: 'pending-order-restore',
    }));
    expect(host.completeCalls).toEqual([]);
    expect(host.pendingOrders).toHaveLength(1);

    verifier.mockResolvedValue(true);
    await expect(finish(provider, 'order-10', 'le-10')).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toEqual([{ orderId: 'order-10', result: 'true' }]);
    expect(host.pendingOrders).toEqual([]);
    expect(host.values.get(ackBarrierKey)).toBe('[]');
  });

  it('never acknowledges an order the provider lists under another product', async () => {
    const { host, provider, verifier } = setup();
    verifier.mockResolvedValue(true);
    host.addPendingOrder({ orderId: 'order-11', sku: 'other.sku', paymentCompletedDate: '' });
    await expect(finish(provider, 'order-11')).resolves.toEqual({ finished: false });
    expect(verifier).not.toHaveBeenCalled();
    expect(host.completeCalls).toEqual([]);
    expect(host.pendingOrders).toHaveLength(1);
  });

  it('keeps finishing when the acknowledgement fails and retries through the same barrier', async () => {
    const { host, provider, verifier } = setup();
    verifier.mockResolvedValue(true);
    host.addPendingOrder({ orderId: 'order-12', sku: 'gems.small', paymentCompletedDate: '' });
    host.queueComplete({ throws: { code: 'NETWORK', message: 'offline' } });
    await expect(finish(provider, 'order-12')).resolves.toEqual({ finished: false });
    expect(JSON.parse(host.values.get(ackBarrierKey) ?? '[]')).toMatchObject([
      { orderId: 'order-12', sku: 'gems.small', phase: 'started' },
    ]);
    host.queueComplete({ returns: false });
    await expect(finish(provider, 'order-12')).resolves.toEqual({ finished: false });
    await expect(finish(provider, 'order-12')).resolves.toEqual({ finished: true });
    expect(host.completeCalls.map((call) => call.result)).toEqual(['threw:NETWORK', 'false', 'true']);
    expect(host.values.get(ackBarrierKey)).toBe('[]');
  });

  it('lists a granted order whose acknowledgement was not confirmed and settles its barrier only with a confirmed grant', async () => {
    const { host, provider, verifier } = setup();
    // An earlier session dispatched completeProductGrant() for order-13 and
    // timed out; the barrier survived, the provider no longer lists the order.
    host.values.set(ackBarrierKey, JSON.stringify([
      { orderId: 'order-13', sku: 'gems.small', idempotencyKey: 'op-13', phase: 'started' },
    ]));
    await expect(provider.getAvailablePurchases({})).resolves.toMatchObject([
      { transactionId: 'order-13', state: 'purchased', storeSku: 'gems.small' },
    ]);
    verifier.mockResolvedValue(false);
    await expect(finish(provider, 'order-13')).resolves.toEqual({ finished: false });
    expect(JSON.parse(host.values.get(ackBarrierKey) ?? '[]')).toHaveLength(1);

    verifier.mockResolvedValue(true);
    await expect(finish(provider, 'order-13')).resolves.toEqual({ finished: true });
    expect(verifier).toHaveBeenLastCalledWith(expect.objectContaining({
      orderId: 'order-13',
      clientIdempotencyKey: 'op-13',
      source: 'pending-order-restore',
    }));
    expect(host.completeCalls).toEqual([]);
    expect(host.values.get(ackBarrierKey)).toBe('[]');
    await expect(provider.getAvailablePurchases({})).resolves.toEqual([]);

    // An order the host knows nothing about has nothing to settle.
    await expect(finish(provider, 'order-unknown')).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toEqual([]);
  });

  it('fails closed when the pending-order list is unreadable', async () => {
    const { host, provider } = setup();
    host.pendingOrdersError = { code: 'NATIVE_DOWN' };
    await expect(provider.getAvailablePurchases({})).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
      storeCode: aitIapDiagnosticCodes.pendingOrderCheckFailed,
    });
    await expect(finish(provider, 'order-14')).resolves.toEqual({ finished: false });
    expect(host.completeCalls).toEqual([]);
  });

  it('restores through the recovery pass and reports settled and still-pending orders as events', async () => {
    const { host, provider, verifier, events, listen } = setup();
    listen();
    verifier.mockImplementation(async (input) => input.orderId === 'order-15');
    host.pendingOrders.push(
      { orderId: 'order-15', sku: 'gems.small', paymentCompletedDate: '2026-10-03T00:00:00Z' },
      { orderId: 'order-16', sku: 'remove.ads', paymentCompletedDate: '' },
    );
    await provider.restorePurchases();
    expect(verifier).toHaveBeenCalledTimes(2);
    expect(verifier.mock.calls.map(([input]) => input.source)).toEqual([
      'pending-order-restore',
      'pending-order-restore',
    ]);
    expect(host.completeCalls).toEqual([{ orderId: 'order-15', result: 'true' }]);
    expect(purchased(events)).toMatchObject([
      { transactionId: 'order-15', state: 'purchased', logicalId: 'gems_small' },
      { transactionId: 'order-16', state: 'purchased', logicalId: 'remove_ads' },
    ]);
    // Settled by the host: listed until finished, and the finish needs no native call.
    await expect(provider.getAvailablePurchases({})).resolves.toMatchObject([
      { transactionId: 'order-16' },
      { transactionId: 'order-15' },
    ]);
    await expect(finish(provider, 'order-15')).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toHaveLength(1);
    await expect(provider.getAvailablePurchases({})).resolves.toMatchObject([
      { transactionId: 'order-16' },
    ]);
    // A later signal reports nothing new.
    host.signalPendingOrdersChanged();
    await flushAitIap();
    expect(purchased(events)).toHaveLength(2);
  });

  it('fails restore closed when preparation or the pending-order read fails', async () => {
    const prepareFails = setup({ prepareIap: async () => false });
    await expect(prepareFails.provider.restorePurchases()).rejects.toMatchObject({
      code: 'NOT_PREPARED',
      storeCode: aitIapDiagnosticCodes.preparationFailed,
    });
    const { host, provider } = setup();
    host.pendingOrdersError = { code: 'NATIVE_DOWN' };
    await expect(provider.restorePurchases()).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
      storeCode: aitIapDiagnosticCodes.pendingOrderCheckFailed,
    });
  });

  it('observes the pending-order signal only while a listener exists', async () => {
    const { host, provider, events, listen } = setup();
    // No listener yet: the signal is not observed, and the order is found by
    // the reconciler's own read instead.
    host.addPendingOrder({ orderId: 'order-17', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    await expect(provider.getAvailablePurchases({})).resolves.toMatchObject([
      { transactionId: 'order-17' },
    ]);
    const unsubscribe = listen();
    expect(events).toEqual([]);
    host.addPendingOrder({ orderId: 'order-18', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    // The read that follows the signal reports every listed order once.
    expect(purchased(events).map((purchase) => purchase.transactionId)).toEqual([
      'order-18',
      'order-17',
    ]);
    host.signalPendingOrdersChanged();
    host.signalPendingOrdersChanged();
    await flushAitIap();
    expect(purchased(events)).toHaveLength(2);

    unsubscribe();
    host.addPendingOrder({ orderId: 'order-19', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    expect(purchased(events)).toHaveLength(2);
    // Resubscribing drains nothing (nothing was buffered) and observes again.
    listen();
    host.signalPendingOrdersChanged();
    await flushAitIap();
    expect(purchased(events).map((purchase) => purchase.transactionId)).toEqual([
      'order-18',
      'order-17',
      'order-19',
    ]);
    provider.dispose();
    host.addPendingOrder({ orderId: 'order-20', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    expect(purchased(events)).toHaveLength(3);
  });

  it('buffers events the recovery pass emits before the first listener', async () => {
    const { host, provider, verifier, events, listen } = setup();
    verifier.mockResolvedValue(true);
    host.pendingOrders.push({ orderId: 'order-21', sku: 'gems.small', paymentCompletedDate: '' });
    await provider.restorePurchases();
    expect(events).toEqual([]);
    listen();
    expect(purchased(events)).toMatchObject([{ transactionId: 'order-21', state: 'purchased' }]);
    const second: CommerceEvent[] = [];
    provider.subscribe((event) => {
      second.push(event);
    });
    expect(second).toEqual([]);
  });

  it('reports an order the host hands over with its signal once, even when the list lags', async () => {
    const { host, provider, events, listen } = setup();
    listen();
    // The host knows the paid order before the provider lists it.
    host.signalPendingOrdersChanged({
      orders: [{ orderId: 'order-22', sku: 'gems.small', paymentCompletedDate: '' }],
    });
    await flushAitIap();
    expect(purchased(events)).toMatchObject([{ transactionId: 'order-22' }]);
    // The read that followed found nothing, which must not forget the order.
    host.signalPendingOrdersChanged();
    await flushAitIap();
    host.addPendingOrder({ orderId: 'order-22', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    expect(purchased(events)).toHaveLength(1);
    // Unconfigured SKUs and malformed ids in the signal are ignored.
    host.signalPendingOrdersChanged({
      orders: [
        { orderId: 'order-23', sku: 'other.sku', paymentCompletedDate: '' },
        { orderId: 'bad\u0000id', sku: 'gems.small', paymentCompletedDate: '' },
      ],
    });
    await flushAitIap();
    expect(purchased(events)).toHaveLength(1);
  });

  it('keeps delivering to the other listeners when one throws', async () => {
    const { host, provider, events, listen } = setup();
    provider.subscribe(() => {
      throw new Error('listener failed');
    });
    listen();
    host.addPendingOrder({ orderId: 'order-24', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    expect(purchased(events)).toMatchObject([{ transactionId: 'order-24' }]);
  });

  it('reports the orders a pre-checkout recovery pass settled before answering launched', async () => {
    const { host, provider, verifier, events, listen } = setup();
    listen();
    verifier.mockResolvedValue(true);
    host.pendingOrders.push({ orderId: 'order-25', sku: 'gems.small', paymentCompletedDate: '' });
    // The same-product paid order is granted and acknowledged before any new
    // checkout, and no checkout opens for this attempt.
    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-25',
      source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });
    expect(host.checkoutCalls).toHaveLength(0);
    expect(host.completeCalls).toEqual([{ orderId: 'order-25', result: 'true' }]);
    expect(purchased(events)).toMatchObject([{ transactionId: 'order-25', state: 'purchased' }]);
    await expect(finish(provider, 'order-25')).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toHaveLength(1);
  });

  it('checks the provider list for a purchase completed through the recovery path', async () => {
    const { host, provider, verifier } = setup();
    // The grant callback refuses, the direct re-verify after
    // PRODUCT_NOT_GRANTED_BY_PARTNER confirms, and the acknowledgement fails:
    // the completed marker is written before the acknowledgement.
    verifier.mockResolvedValueOnce(false).mockResolvedValue(true);
    host.queueCheckout({ kind: 'grant', orderId: 'order-26' });
    host.queueComplete({ throws: { code: 'NETWORK', message: 'offline' } });
    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-26',
      source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });
    expect(host.pendingOrders).toHaveLength(1);
    // A replay of the client key answers the completed marker as purchased,
    // but the host must still acknowledge the listed order on finish.
    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-26',
      source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'purchased',
      purchase: {
        transactionId: 'order-26',
        evidence: { payload: { source: 'pending-order-restore' } },
      },
    });
    await expect(finish(provider, 'order-26')).resolves.toEqual({ finished: true });
    expect(host.completeCalls.map((call) => call.result)).toEqual(['threw:NETWORK', 'true']);
    expect(host.pendingOrders).toEqual([]);
  });

  it('rejects a completed purchase that is not an order for the requested product', async () => {
    const host = createFakeAitIapHost({ products: catalog });
    const controller = createAitIapController({
      dependencies: host.dependencies,
      iapProducts: [...products],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      readIapEntitlements: async () => [],
    });
    // A host flow that completes another configured product's order.
    const provider = createAitCommerceProviderFromController(
      {
        ...controller,
        purchase: async () => ({
          status: 'completed',
          transactionId: 'order-27',
          entitlementIds: ['remove_ads'],
        }),
      },
      { onPendingOrdersChanged: (listener) => host.onPendingOrdersChanged(listener) },
    );
    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-27',
      source: 'shop',
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(provider.getAvailablePurchases({})).resolves.toEqual([]);
  });

  it('neither reports nor lists an order it finished while the host still lists it', async () => {
    const { host, provider, verifier, events, listen } = setup();
    listen();
    verifier.mockResolvedValue(true);
    host.addPendingOrder({ orderId: 'order-28', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    expect(purchased(events)).toHaveLength(1);
    await expect(finish(provider, 'order-28')).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toHaveLength(1);

    // Eventual consistency: the host lists the acknowledged order a little longer.
    host.pendingOrders.push({ orderId: 'order-28', sku: 'gems.small', paymentCompletedDate: '' });
    host.signalPendingOrdersChanged();
    await flushAitIap();
    expect(purchased(events)).toHaveLength(1);
    await expect(provider.getAvailablePurchases({ includePending: true })).resolves.toEqual([]);
    await expect(finish(provider, 'order-28')).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toHaveLength(1);

    // Once the host stops listing it, the id is forgotten; a genuinely new
    // listing under that id is a new order to the provider.
    host.pendingOrders.splice(0, host.pendingOrders.length);
    host.signalPendingOrdersChanged();
    await flushAitIap();
    host.addPendingOrder({ orderId: 'order-28', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    expect(purchased(events)).toHaveLength(2);
  });

  it('keeps a signalled order unfinished until the host lists it, then acknowledges it', async () => {
    const { host, provider, verifier, events, listen } = setup();
    listen();
    verifier.mockResolvedValue(true);
    // The host hands over the paid order before it lists it; the reconciler
    // verifies and finishes at once. Nothing durable says the host finished
    // it, so the finish waits instead of ending the record unacknowledged.
    host.signalPendingOrdersChanged({
      orders: [{ orderId: 'order-29', sku: 'gems.small', paymentCompletedDate: '' }],
    });
    await flushAitIap();
    expect(purchased(events)).toHaveLength(1);
    await expect(finish(provider, 'order-29')).resolves.toEqual({ finished: false });
    expect(host.completeCalls).toEqual([]);
    // The list catches up: the retried finish acknowledges, once.
    host.addPendingOrder({ orderId: 'order-29', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    expect(purchased(events)).toHaveLength(1);
    await expect(provider.getAvailablePurchases({})).resolves.toMatchObject([
      { transactionId: 'order-29' },
    ]);
    await expect(finish(provider, 'order-29')).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toEqual([{ orderId: 'order-29', result: 'true' }]);
    await expect(provider.getAvailablePurchases({})).resolves.toEqual([]);
  });

  it('lists nothing for a finished order whose attempt key is replayed', async () => {
    const { host, provider, verifier, listen } = setup();
    listen();
    verifier.mockResolvedValue(true);
    host.queueCheckout({ kind: 'grant', orderId: 'order-30' });
    const request = { logicalId: 'gems_small', idempotencyKey: 'op-30', source: 'shop' } as const;
    await expect(provider.requestPurchase(request)).resolves.toMatchObject({ outcome: 'purchased' });
    await expect(finish(provider, 'order-30')).resolves.toEqual({ finished: true });
    // The host still lists nothing for it, and this provider acknowledged nothing
    // (the SDK completed it); a replay of the key answers the completed marker.
    await expect(provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'purchased',
      purchase: { transactionId: 'order-30' },
    });
    await expect(finish(provider, 'order-30')).resolves.toEqual({ finished: true });
    await expect(provider.getAvailablePurchases({ includePending: true })).resolves.toEqual([]);
    expect(host.completeCalls).toEqual([]);
  });

  it('maps every AIT diagnostic code onto a v2 error code', () => {
    for (const code of Object.values(aitIapDiagnosticCodes)) {
      expect(commerceErrorCodes, code).toContain(aitIapCommerceErrorCodeMap[code]);
    }
  });
});
