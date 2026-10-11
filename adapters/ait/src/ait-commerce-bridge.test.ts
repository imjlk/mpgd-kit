import { describe, expect, it } from 'vitest';

import { bridgeCommerceV2Methods, type BridgeEvent, type BridgeRequest } from '@mpgd/bridge';
import { deriveLegacyCommerceCapabilities, type CommerceEvent } from '@mpgd/platform/commerce';

import {
  createFakeAitHostDependencies,
  createFakeAitIapHost,
  flushAitIap,
} from '../test/ait-iap-fixture.js';
import { createAitBridgeCommerceProvider } from './commerce-bridge.js';
import { createAitHostBridge } from './host.js';
import { createAitPlatformGateway, type GamePlatformBridge } from './index.js';

const products = [{ productId: 'gems_small', sku: 'gems.small' }] as const;

function setup(options: { readonly configured?: boolean } = {}) {
  const host = createFakeAitIapHost({
    products: [{ sku: 'gems.small', type: 'CONSUMABLE', displayName: 'Small gems' }],
  });
  const bridge = createAitHostBridge({
    ...(options.configured === false
      ? {}
      : {
          iapProducts: products,
          prepareIap: async () => true,
          verifyIapProductGrant: async () => true,
          readIapEntitlements: async () => [],
        }),
    onPendingOrdersChanged: (listener) => host.onPendingOrdersChanged(listener),
    dependencies: createFakeAitHostDependencies(host),
  });
  const gateway = createAitPlatformGateway({ appVersion: '1.0.0', buildId: 'build-ait', bridge });
  return { host, bridge, gateway };
}

function request(method: BridgeRequest['method'], payload: unknown, id = `${method}:test`): BridgeRequest {
  return {
    id,
    method,
    payload,
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'test',
      sentAt: '2026-10-12T00:00:00.000Z',
    },
  };
}

describe('Apps in Toss commerce v2 bridge', () => {
  it('serves the capability block with the boolean flags derived from it', async () => {
    const { gateway } = setup();
    const capabilities = await gateway.getCapabilities();
    if (capabilities.commerce === undefined) {
      throw new Error('The host must answer with the commerce capability block.');
    }
    expect(capabilities.commerce).toMatchObject({
      lifecycle: { finish: 'host' },
      authority: { evidence: 'host-callback', accountBinding: 'host' },
      availability: 'available',
    });
    const legacy = deriveLegacyCommerceCapabilities(capabilities.commerce);
    expect(capabilities.nativeIap).toBe(legacy.nativeIap);
    expect(capabilities.subscriptionIap).toBe(legacy.subscriptionIap);
    expect(capabilities.nativeIap).toBe(true);
    expect((await gateway.getCapabilities()).commerce).not.toBe(capabilities.commerce);

    const unconfigured = setup({ configured: false });
    const degraded = await unconfigured.gateway.getCapabilities();
    expect(degraded.nativeIap).toBe(false);
    expect(degraded.commerce?.availability).toBe('configuration-required');
  });

  it('round-trips the six commerce.v2 methods through the host bridge and the gateway', async () => {
    const { host, gateway } = setup();
    const provider = gateway.commerceV2;
    if (provider === undefined) {
      throw new Error('The gateway must expose commerceV2 over a host that serves it.');
    }
    expect(provider.store).toBe('apps-in-toss');
    expect((await provider.getCapabilities()).lifecycle.finish).toBe('host');
    await expect(provider.fetchProducts({})).resolves.toMatchObject([
      { logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' },
    ]);

    host.queueCheckout({ kind: 'grant', orderId: 'order-1' });
    await expect(provider.requestPurchase({
      logicalId: 'gems_small',
      idempotencyKey: 'op-1',
      source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'purchased',
      purchase: { transactionId: 'order-1', token: 'order-1', state: 'purchased' },
    });
    // Finished by the host after the confirmed grant callback: listed until
    // the reconciler finishes it, then gone.
    await expect(provider.getAvailablePurchases({ includePending: true })).resolves.toMatchObject([
      { transactionId: 'order-1', state: 'purchased' },
    ]);
    await expect(provider.finishTransaction?.({
      transactionId: 'order-1',
      ledgerEntryId: 'le-1',
      isConsumable: true,
    })).resolves.toEqual({ finished: true });
    expect(host.completeCalls).toEqual([]);
    await expect(provider.getAvailablePurchases({ includePending: true })).resolves.toEqual([]);
    await expect(provider.restorePurchases?.()).resolves.toBeUndefined();
  });

  it('pushes purchaseUpdated events to the game in the bridge envelope', async () => {
    const { host, bridge, gateway } = setup();
    const envelopes: BridgeEvent[] = [];
    const unsubscribe = bridge.commerceV2?.subscribe((event) => {
      envelopes.push(event);
    });
    const events: CommerceEvent[] = [];
    gateway.commerceV2?.subscribe((event) => {
      events.push(event);
    });
    host.addPendingOrder({ orderId: 'order-2', sku: 'gems.small', paymentCompletedDate: '' });
    await flushAitIap();
    expect(envelopes).toEqual([
      {
        protocol: 'mpgd.commerce.v2',
        sequence: 0,
        event: {
          type: 'purchaseUpdated',
          purchase: expect.objectContaining({ transactionId: 'order-2', state: 'purchased' }),
        },
      },
    ]);
    expect(events).toEqual([envelopes[0]?.event]);
    unsubscribe?.();
  });

  it('reports a malformed envelope as a purchase error and ignores foreign protocols', () => {
    const listeners: ((envelope: unknown) => void)[] = [];
    const provider = createAitBridgeCommerceProvider({
      store: 'apps-in-toss',
      request: async () => {
        throw new Error('unused');
      },
      subscribe: (listener) => {
        listeners.push(listener as (envelope: unknown) => void);
        return () => {};
      },
    });
    const events: CommerceEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });
    const deliver = (envelope: unknown): void => {
      for (const listener of listeners) {
        listener(envelope);
      }
    };
    deliver({ protocol: 'mpgd.ads.v1', sequence: 0, event: { type: 'shown' } });
    expect(events).toEqual([]);
    deliver({ sequence: 0, event: { type: 'purchaseUpdated' } });
    deliver({ protocol: 7, sequence: 1, event: { type: 'purchaseUpdated' } });
    deliver(null);
    expect(events.map((event) => event.type)).toEqual([
      'purchaseError',
      'purchaseError',
      'purchaseError',
    ]);
    expect(events[0]).toMatchObject({ error: { code: 'INVALID_RESPONSE' } });
  });

  it('rejects an invalid payload and keeps a purchase failure as data', async () => {
    const { host, bridge } = setup();
    const invalid = await bridge.request(request('commerce.v2.requestPurchase', { logicalId: 'gems_small' }));
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'COMMERCE_V2_INVALID_PAYLOAD', retryable: false },
    });
    host.queueCheckout({ kind: 'cancel' });
    const cancelled = await bridge.request(request('commerce.v2.requestPurchase', {
      logicalId: 'gems_small',
      idempotencyKey: 'op-3',
      source: 'shop',
    }));
    expect(cancelled).toMatchObject({
      ok: true,
      data: { outcome: 'cancelled', error: { code: 'USER_CANCELLED' } },
    });
    const capabilities = await bridge.request(request('commerce.v2.getCapabilities', {
      protocol: 'mpgd.commerce.v2',
    }));
    expect(capabilities).toMatchObject({
      ok: true,
      data: { protocolVersion: '2.0.0-draft.1', store: 'apps-in-toss' },
    });
  });

  it('keeps the adapter-reserved storage keys closed to the game while serving v2', async () => {
    const { bridge } = setup();
    for (const key of [
      'mpgd:ait:iap-ack-in-flight:v1',
      'mpgd:ait:iap-purchase-attempt:v1:gems_small:op-1',
      'mpgd:ait:iap-order-attempt:v1:order-1',
    ]) {
      const response = await bridge.request(request('storage.save', { key, value: [] }));
      expect(response).toMatchObject({ ok: false, error: { code: 'AIT_BRIDGE_REQUEST_FAILED' } });
    }
  });

  it('offers no commerceV2 over a bridge without the event channel and answers its methods fail-closed', async () => {
    const bridge: GamePlatformBridge = {
      async request(input) {
        return {
          id: input.id,
          ok: false,
          error: { code: 'UNSUPPORTED_METHOD', message: input.method, retryable: false },
        };
      },
    };
    const gateway = createAitPlatformGateway({ appVersion: '1.0.0', buildId: 'build-ait', bridge });
    expect(gateway.commerceV2).toBeUndefined();
    expect(bridgeCommerceV2Methods).toHaveLength(6);
  });
});
