import { describe, expect, it } from 'vitest';

import type { BridgeEvent, BridgeMethod, BridgeRequest } from '@mpgd/bridge';
import { createCapacitorPlatformGateway, type NativeBridge } from '@mpgd/adapter-capacitor';
import { createUnsupportedCapabilities } from '@mpgd/platform';
import {
  commerceProtocol,
  commerceProtocolVersion,
  createGooglePlayTokenPurchaseKey,
  type CommerceEvent,
  type StorePurchase,
} from '@mpgd/platform/commerce';
import {
  createCommerceConformanceBackend,
  createCommerceConformanceClock,
  createCommerceConformanceJournal,
  createCommerceConformanceRuntime,
} from '@mpgd/platform/commerce-conformance';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
  fakePlayPurchase,
  type FakePlayBillingPlugin,
} from '../test/play-billing-plugin-fixture.js';
import {
  createCapacitorPlayBillingCommerceProvider,
  createCapacitorPlayBillingServiceProvider,
  createPlayBillingEvidencePayload,
  googlePlayProductPurchaseEvidenceSchema,
  playBillingCommerceAuthority,
  playBillingCommerceServiceProviderId,
  type CreateCapacitorPlayBillingCommerceProviderInput,
} from './commerce-provider.js';
import { createCapacitorPlayBillingProvider } from './provider.js';

const accountBinding = { kind: 'obfuscated-account-id', value: 'player-hash-1' } as const;
const products: CreateCapacitorPlayBillingCommerceProviderInput['products'] = [
  { logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' },
  { logicalId: 'remove_ads', storeSku: 'remove.ads', kind: 'durable', offerId: 'intro' },
];

function createPlugin(): FakePlayBillingPlugin {
  return createFakePlayBillingPlugin({
    products: [
      fakePlayProduct({ productId: 'gems.small' }),
      fakePlayProduct({
        productId: 'remove.ads',
        offers: [
          { offerToken: 'base', formattedPrice: '$2.99', currencyCode: 'USD' },
          { offerToken: 'intro', formattedPrice: '$1.99', currencyCode: 'USD' },
        ],
      }),
    ],
  });
}

function createProvider(
  plugin = createPlugin(),
  overrides: Partial<CreateCapacitorPlayBillingCommerceProviderInput> = {},
) {
  return {
    plugin,
    provider: createCapacitorPlayBillingCommerceProvider({
      plugin,
      isAndroid: () => true,
      products,
      accountBinding: () => accountBinding,
      ...overrides,
    }),
  };
}

function baseBridge(): NativeBridge {
  return {
    async request(input) {
      if (input.method === 'runtime.getCapabilities') {
        return { id: input.id, ok: true, data: createUnsupportedCapabilities() };
      }
      throw new Error(`Base bridge must not receive ${input.method}.`);
    },
  };
}

function request(method: BridgeMethod, payload: unknown = {}): BridgeRequest {
  return {
    id: `${method}:${Math.random()}`,
    method,
    payload,
    meta: { target: 'android', appVersion: '1', buildId: 'test', sentAt: new Date().toISOString() },
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

describe('createCapacitorPlayBillingCommerceProvider', () => {
  it('composes the google-play store, evidence schema, authority, and capabilities', async () => {
    const { provider } = createProvider();
    expect(provider.store).toBe('google-play');
    expect(provider.finishTransaction).toBeUndefined();
    expect(provider.restorePurchases).toBeUndefined();
    expect(await provider.getCapabilities()).toEqual({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      catalog: { products: true, offers: true, localizedPrice: true },
      lifecycle: {
        availablePurchases: true,
        pending: true,
        restore: false,
        events: true,
        finish: 'server',
      },
      authority: { evidence: 'client-token', accountBinding: 'required' },
      availability: 'available',
    });
    expect(playBillingCommerceAuthority).toEqual({ evidence: 'client-token', accountBinding: 'required' });
    expect(googlePlayProductPurchaseEvidenceSchema).toBe('google-play.product-purchase.v2');
    expect(createPlayBillingEvidencePayload({ token: 'abc' })).toEqual({ purchaseToken: 'abc' });
    expect(() => createCapacitorPlayBillingCommerceProvider({
      plugin: createPlugin(),
      products: [{ logicalId: 'pass', storeSku: 'pass', kind: 'subscription' as 'consumable' }],
      accountBinding: () => accountBinding,
    })).toThrow(/one-time products only/u);
  });

  it('emits exactly the evidence the v1 provider emits for the same purchase', async () => {
    const purchase = fakePlayPurchase({
      products: ['gems.small'],
      purchaseToken: 'private-play-token',
      orderId: 'GPA.1111-2222',
      obfuscatedAccountId: 'player-hash-1',
    });
    const v2Plugin = createPlugin();
    v2Plugin.queuePurchase({ status: 'purchased', purchase });
    const { provider } = createProvider(v2Plugin);
    const v2 = await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(v2.outcome).toBe('purchased');
    if (v2.outcome !== 'purchased') {
      throw new Error('expected purchased');
    }

    const v1Plugin = createPlugin();
    v1Plugin.queuePurchase({ status: 'purchased', purchase });
    const v1 = createCapacitorPlayBillingProvider({
      products: [{ id: 'gems_small', type: 'consumable', storeId: 'gems.small' }],
      getObfuscatedAccountId: () => 'player-hash-1',
      isAndroid: () => true,
      sdk: v1Plugin,
    });
    const v1Response = await v1.bridge.request(request('commerce.purchase', { productId: 'gems_small' }));
    expect(v1Response.ok).toBe(true);
    if (!v1Response.ok) {
      throw new Error('expected v1 success');
    }
    const v1Result = v1Response.data as { transactionId: string; evidence: StorePurchase['evidence'] };
    expect(v1Result.evidence).toEqual({
      schema: 'google-play.product-purchase.v2',
      payload: { purchaseToken: 'private-play-token' },
    });
    expect(v2.purchase.evidence).toEqual(v1Result.evidence);
    expect(v2.purchase.transactionId).toBe(v1Result.transactionId);
    expect(v2.purchase).toEqual({
      store: 'google-play',
      transactionId: 'GPA.1111-2222',
      storeSku: 'gems.small',
      logicalId: 'gems_small',
      quantity: 1,
      state: 'purchased',
      purchasedAt: new Date(1_790_000_000_000).toISOString(),
      token: 'private-play-token',
      evidence: v1Result.evidence,
      accountBinding,
    });
    expect(JSON.stringify(v2)).not.toContain('settlement');

    // Without an order id both sides fall back to the shared token key.
    const orderless = fakePlayPurchase({ products: ['gems.small'], purchaseToken: 'no-order-yet' });
    v2Plugin.queuePurchase({ status: 'purchased', purchase: orderless });
    v1Plugin.queuePurchase({ status: 'purchased', purchase: orderless });
    const v2Orderless = await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    });
    const v1Orderless = await v1.bridge.request(request('commerce.purchase', { productId: 'gems_small' }));
    const key = await createGooglePlayTokenPurchaseKey('no-order-yet');
    expect(v2Orderless).toMatchObject({ purchase: { transactionId: key } });
    expect(v1Orderless).toMatchObject({ data: { transactionId: key } });
  });

  it('resolves the account binding before the store opens and keeps a lookup failure recoverable', async () => {
    const calls: string[] = [];
    const { plugin, provider } = createProvider(createPlugin(), {
      accountBinding: async () => {
        calls.push('lookup');
        return accountBinding;
      },
    });
    plugin.queuePurchase({ status: 'cancelled' });
    expect(await provider.requestPurchase({
      logicalId: 'remove_ads', idempotencyKey: 'op-1', source: 'shop',
    })).toMatchObject({ outcome: 'cancelled', error: { code: 'USER_CANCELLED', retryable: false } });
    expect(calls).toEqual(['lookup']);
    expect(plugin.purchaseCalls).toEqual([{
      productId: 'remove.ads', offerToken: 'intro', obfuscatedAccountId: 'player-hash-1',
    }]);

    const missing = createProvider(createPlugin(), { accountBinding: () => undefined });
    await expect(missing.provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    })).rejects.toMatchObject({ code: 'ACCOUNT_BINDING_REQUIRED' });
    expect(missing.plugin.purchaseCalls).toEqual([]);

    const failing = createProvider(createPlugin(), {
      accountBinding: async () => {
        throw new Error('session expired');
      },
    });
    await expect(failing.provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-3', source: 'shop',
    })).rejects.toMatchObject({
      code: 'ACCOUNT_BINDING_REQUIRED',
      storeCode: 'PLAY_BILLING_ACCOUNT_LOOKUP_FAILED',
      retryable: false,
    });

    const wrongKind = createProvider(createPlugin(), {
      accountBinding: () => ({ kind: 'host-identity' }),
    });
    // The SDK's own check is a store failure, so the provider reports it as a failed outcome.
    await expect(wrongKind.provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-4', source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ACCOUNT_BINDING_REQUIRED', storeCode: 'PLAY_BILLING_ACCOUNT_REQUIRED' },
    });
    expect(wrongKind.plugin.purchaseCalls).toEqual([]);
  });

  it('keeps a pending purchase open until the plugin reports it purchased', async () => {
    const { plugin, provider } = createProvider();
    const events: CommerceEvent[] = [];
    provider.subscribe((event) => events.push(event));

    expect(await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).toEqual({ outcome: 'launched' });
    await until(() => events.length === 1);
    expect(events).toEqual([{
      type: 'purchaseUpdated',
      purchase: expect.objectContaining({ logicalId: 'gems_small', state: 'pending' }),
    }]);
    const pendingToken = plugin.purchases[0]?.purchaseToken ?? '';
    expect((await provider.getAvailablePurchases()).map((purchase) => purchase.state)).toEqual([]);
    expect((await provider.getAvailablePurchases({ includePending: true })))
      .toMatchObject([{ state: 'pending', token: pendingToken }]);

    plugin.report(fakePlayPurchase({
      products: ['gems.small'], purchaseToken: pendingToken, orderId: 'GPA.9', purchaseState: 'purchased',
    }));
    await until(() => events.length === 2);
    expect(events[1]).toEqual({
      type: 'purchaseUpdated',
      purchase: expect.objectContaining({ transactionId: 'GPA.9', state: 'purchased' }),
    });
    expect((await provider.getAvailablePurchases()).map((purchase) => purchase.transactionId))
      .toEqual(['GPA.9']);

    // The backend finalizer acknowledges or consumes; the list empties without a client call.
    plugin.finalize(pendingToken, 'consume');
    expect(await provider.getAvailablePurchases()).toEqual([]);
  });

  it('turns uncertain plugin outcomes into a recoverable launched attempt', async () => {
    const { plugin, provider } = createProvider();
    const events: CommerceEvent[] = [];
    provider.subscribe((event) => events.push(event));
    for (const code of [
      'PLAY_BILLING_TIMEOUT', 'PLAY_BILLING_INTERRUPTED', 'PLAY_BILLING_EMPTY_PURCHASE',
      'PLAY_BILLING_ALREADY_OWNED',
    ]) {
      plugin.queuePurchase({ throws: Object.assign(new Error(code), { code }) });
      expect(await provider.requestPurchase({
        logicalId: 'gems_small', idempotencyKey: `op-${code}`, source: 'shop',
      })).toEqual({ outcome: 'launched' });
    }
    plugin.queuePurchase({ throws: Object.assign(new Error('busy'), { code: 'PLAY_BILLING_BUSY' }) });
    expect(await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-busy', source: 'shop',
    })).toMatchObject({
      outcome: 'failed',
      error: { code: 'IN_PROGRESS', storeCode: 'PLAY_BILLING_BUSY', retryable: false },
    });
    plugin.queuePurchase({
      throws: Object.assign(new Error('offline'), { code: 'PLAY_BILLING_NETWORK_ERROR' }),
    });
    expect(await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-net', source: 'shop',
    })).toMatchObject({ outcome: 'failed', error: { code: 'NETWORK', retryable: true } });
    await flush();
    expect(events).toEqual([]);
  });

  it('buffers a plugin update delivered before the first subscriber', async () => {
    const { plugin, provider } = createProvider();
    plugin.report(fakePlayPurchase({ products: ['gems.small'], purchaseToken: 'early', orderId: 'GPA.e' }));
    await flush();
    const events: CommerceEvent[] = [];
    provider.subscribe((event) => events.push(event));
    expect(events).toEqual([{
      type: 'purchaseUpdated',
      purchase: expect.objectContaining({ transactionId: 'GPA.e', logicalId: 'gems_small' }),
    }]);
    provider.dispose();
    await flush();
    expect(plugin.listenerCount).toBe(0);
  });

  it('reports availability from the plugin and refuses to open the store while unavailable', async () => {
    const { plugin, provider } = createProvider();
    plugin.failure = () => Object.assign(new Error('x'), { code: 'PLAY_BILLING_CONFIGURATION_ERROR' });
    expect((await provider.getCapabilities()).availability).toBe('configuration-required');
    await expect(provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).rejects.toMatchObject({ code: 'CONFIGURATION_REQUIRED' });
    plugin.failure = undefined;

    const offAndroid = createProvider(createPlugin(), { isAndroid: () => false });
    expect((await offAndroid.provider.getCapabilities()).availability).toBe('unsupported');
    await expect(offAndroid.provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    })).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', retryable: false });
    expect(offAndroid.plugin.purchaseCalls).toEqual([]);
  });

  it('accepts a store override for conformance harnesses only', async () => {
    const { plugin, provider } = createProvider(createPlugin(), { store: 'fixture.play' });
    expect(provider.store).toBe('fixture.play');
    plugin.upsert(fakePlayPurchase({ products: ['gems.small'], purchaseToken: 't', orderId: 'GPA.t' }));
    expect(await provider.getAvailablePurchases()).toMatchObject([{
      store: 'fixture.play',
      evidence: { schema: 'google-play.product-purchase.v2', payload: { purchaseToken: 't' } },
    }]);
  });
});

describe('createCapacitorPlayBillingCommerceProvider with the reference reconciler', () => {
  const catalog = [
    { logicalId: 'gems_small', kind: 'consumable', storeSku: 'gems.small' },
    { logicalId: 'remove_ads', kind: 'durable', storeSku: 'remove.ads' },
  ] as const;

  function createRuntime(plugin: FakePlayBillingPlugin, unmapped: unknown[] = []) {
    const { provider } = createProvider(plugin, {
      onUnmappedPurchase: (purchase) => {
        unmapped.push(purchase);
      },
    });
    const backend = createCommerceConformanceBackend();
    const journal = createCommerceConformanceJournal();
    const runtime = createCommerceConformanceRuntime({
      provider,
      backend,
      journal,
      clock: createCommerceConformanceClock(),
      catalog,
      playerId: 'player-1',
    });
    return { provider, backend, journal, runtime };
  }

  it('reconciles a valid purchase next to an unfinished purchase for a retired SKU', async () => {
    const plugin = createPlugin();
    plugin.upsert(fakePlayPurchase({ products: ['retired.sku'], purchaseToken: 'token-r', orderId: 'GPA.r' }));
    plugin.upsert(fakePlayPurchase({ products: ['gems.small'], purchaseToken: 'token-v', orderId: 'GPA.v' }));
    const unmapped: unknown[] = [];
    const { backend, journal, runtime } = createRuntime(plugin, unmapped);
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1', finalization: 'completed' });

    await runtime.start();
    await runtime.runUntilIdle();
    expect(journal.snapshot()).toEqual({
      [await createGooglePlayTokenPurchaseKey('token-v')]: [
        'purchased', 'verifying', 'granted', 'finishing', 'finished',
      ],
    });
    expect(backend.verifyRequests).toMatchObject([{ transactionId: 'GPA.v', token: 'token-v' }]);
    expect(unmapped).toMatchObject([{ purchaseToken: 'token-r' }]);
    // The retired purchase stays with the plugin for the backend finalizer.
    expect(plugin.purchases.map((purchase) => purchase.purchaseToken)).toContain('token-r');
  });

  it('closes a launched attempt when the plugin reports a late cancel after its timeout', async () => {
    const plugin = createPlugin();
    const { journal, runtime } = createRuntime(plugin);
    await runtime.start();
    plugin.queuePurchase({
      throws: Object.assign(new Error('timed out'), { code: 'PLAY_BILLING_TIMEOUT' }),
    });
    expect(await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).toEqual({ outcome: 'launched' });
    await runtime.runUntilIdle();
    expect(journal.history('op-1')).toEqual(['requested', 'launched']);
    // While the attempt is open another purchase of the product is refused.
    expect(await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    })).toMatchObject({ outcome: 'failed', error: { code: 'IN_PROGRESS' } });

    plugin.emit({ status: 'cancelled', productId: 'gems.small' });
    await until(() => journal.history('op-1').at(-1) === 'cancelled');
    await runtime.runUntilIdle();
    expect(journal.history('op-1')).toEqual(['requested', 'launched', 'cancelled']);

    plugin.queuePurchase({ status: 'cancelled' });
    expect(await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-3', source: 'shop',
    })).toMatchObject({ outcome: 'cancelled', error: { code: 'USER_CANCELLED' } });
    expect(plugin.purchaseCalls).toHaveLength(2);
  });
});

describe('createCapacitorPlayBillingServiceProvider', () => {
  it('registers with the gateway and serves commerce v2 and v1 through the bridge', async () => {
    const plugin = createPlugin();
    const service = createCapacitorPlayBillingServiceProvider({
      plugin,
      isAndroid: () => true,
      products,
      accountBinding: () => accountBinding,
    });
    expect(service.id).toBe(playBillingCommerceServiceProviderId);
    expect(service.features).toEqual(['nativeIap']);
    expect(service.methods).toEqual([]);
    expect(service.commerce.store).toBe('google-play');

    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'play', bridge: baseBridge(),
      providers: [service],
    });
    const commerceV2 = gateway.commerceV2;
    if (commerceV2 === undefined) {
      throw new Error('expected commerceV2');
    }
    expect(commerceV2.store).toBe('google-play');
    expect((await commerceV2.fetchProducts({})).map((product) => [
      product.logicalId, product.storeSku, product.price.formatted,
    ])).toEqual([['gems_small', 'gems.small', '$0.99'], ['remove_ads', 'remove.ads', '$1.99']]);

    const events: CommerceEvent[] = [];
    const unsubscribe = commerceV2.subscribe((event) => events.push(event));
    plugin.queuePurchase({ throws: Object.assign(new Error('t'), { code: 'PLAY_BILLING_TIMEOUT' }) });
    await expect(commerceV2.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });
    plugin.report(fakePlayPurchase({ products: ['gems.small'], purchaseToken: 'late', orderId: 'GPA.l' }));
    await until(() => events.length === 1);
    expect(events).toEqual([{
      type: 'purchaseUpdated',
      purchase: expect.objectContaining({
        store: 'google-play', transactionId: 'GPA.l', logicalId: 'gems_small',
        evidence: { schema: 'google-play.product-purchase.v2', payload: { purchaseToken: 'late' } },
      }),
    }]);
    expect((await commerceV2.getAvailablePurchases()).map((purchase) => purchase.transactionId))
      .toEqual(['GPA.l']);
    await expect(commerceV2.finishTransaction?.({
      transactionId: 'GPA.l', ledgerEntryId: 'le-1', isConsumable: true,
    })).rejects.toMatchObject({ storeCode: 'COMMERCE_V2_METHOD_UNSUPPORTED' });
    await expect(commerceV2.restorePurchases?.()).resolves.toBeUndefined();
    unsubscribe();

    const capabilities = await gateway.getCapabilities();
    expect(capabilities.nativeIap).toBe(true);
    expect(capabilities.subscriptionIap).toBe(false);
    expect(capabilities.commerce).toEqual({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      catalog: { products: true, offers: true, localizedPrice: true },
      lifecycle: {
        availablePurchases: true, pending: true, restore: false, events: true, finish: 'server',
      },
      authority: { evidence: 'client-token', accountBinding: 'required' },
      availability: 'available',
    });

    expect(await gateway.commerce.getProducts()).toMatchObject([
      { id: 'gems_small', type: 'consumable', price: { formatted: '$0.99', currencyCode: 'USD' } },
      { id: 'remove_ads', type: 'non_consumable', price: { formatted: '$1.99' } },
    ]);
    plugin.queuePurchase({
      status: 'purchased',
      purchase: fakePlayPurchase({ products: ['gems.small'], purchaseToken: 'sync', orderId: 'GPA.s' }),
    });
    await expect(gateway.commerce.purchase({
      productId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    })).resolves.toEqual({
      status: 'completed',
      transactionId: 'GPA.s',
      entitlementIds: [],
      evidence: { schema: 'google-play.product-purchase.v2', payload: { purchaseToken: 'sync' } },
    });
    await expect(gateway.commerce.restore?.()).resolves.toEqual({
      restoredEntitlements: [], settledPurchases: [],
    });
    expect(plugin.purchaseCalls).toHaveLength(2);
  });

  it('answers the commerce.v2.* bridge methods on the registry entry with the envelope sequence', async () => {
    const plugin = createPlugin();
    const service = createCapacitorPlayBillingServiceProvider({
      id: 'play',
      plugin,
      isAndroid: () => true,
      products,
      accountBinding: () => accountBinding,
    });
    expect(service.id).toBe('play');
    const envelopes: BridgeEvent[] = [];
    const detach = service.bridge.subscribe((envelope) => envelopes.push(envelope));

    expect(await service.bridge.request(request('commerce.v2.getCapabilities', {
      protocol: commerceProtocol,
    }))).toMatchObject({
      ok: true,
      data: {
        protocolVersion: commerceProtocolVersion,
        store: 'google-play',
        capabilities: { lifecycle: { finish: 'server' }, availability: 'available' },
      },
    });
    expect(await service.bridge.request(request('commerce.v2.fetchProducts', { type: 'in-app' })))
      .toMatchObject({ ok: true, data: { products: [{ logicalId: 'gems_small' }, { logicalId: 'remove_ads' }] } });
    expect(await service.bridge.request(request('commerce.v2.requestPurchase', {
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    }))).toMatchObject({ ok: true, data: { outcome: 'launched' } });
    await until(() => envelopes.length === 1);
    expect(envelopes).toEqual([{
      protocol: 'mpgd.commerce.v2',
      sequence: 0,
      event: { type: 'purchaseUpdated', purchase: expect.objectContaining({ state: 'pending' }) },
    }]);
    expect(await service.bridge.request(request('commerce.v2.getAvailablePurchases', {
      includePending: true,
    }))).toMatchObject({ ok: true, data: { purchases: [{ state: 'pending', logicalId: 'gems_small' }] } });
    expect(await service.bridge.request(request('commerce.v2.finishTransaction', {
      transactionId: 'x', ledgerEntryId: 'le', isConsumable: true,
    }))).toMatchObject({ ok: false, error: { code: 'COMMERCE_V2_METHOD_UNSUPPORTED' } });
    expect(await service.bridge.request(request('commerce.v2.restorePurchases', {
      protocol: commerceProtocol,
    }))).toMatchObject({ ok: true, data: { restored: false } });
    expect(await service.bridge.request(request('commerce.getEntitlements')))
      .toMatchObject({ ok: true, data: [] });
    detach();
  });
});
