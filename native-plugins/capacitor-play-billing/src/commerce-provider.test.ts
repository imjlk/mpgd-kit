import { describe, expect, it } from 'vitest';

import type { BridgeEvent, BridgeMethod, BridgeRequest } from '@mpgd/bridge';
import { createCapacitorPlatformGateway, type NativeBridge } from '@mpgd/adapter-capacitor';
import {
  createCommerceReconciler,
  createInMemoryMonetizationOperationStore,
  type CommerceReconcilerEvent,
} from '@mpgd/game-services';
import type { VerifyPurchaseRequest } from '@mpgd/game-services/types';
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

  it('emits the purchase-token evidence the Google Play verifier routes on', async () => {
    const purchase = fakePlayPurchase({
      products: ['gems.small'],
      purchaseToken: 'private-play-token',
      orderId: 'GPA.1111-2222',
      obfuscatedAccountId: 'player-hash-1',
    });
    const plugin = createPlugin();
    plugin.queuePurchase({ status: 'purchased', purchase });
    const { provider } = createProvider(plugin);
    const result = await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(result.outcome).toBe('purchased');
    if (result.outcome !== 'purchased') {
      throw new Error('expected purchased');
    }
    const evidence: StorePurchase['evidence'] = {
      schema: 'google-play.product-purchase.v2',
      payload: { purchaseToken: 'private-play-token' },
    };
    expect(result.purchase.evidence).toEqual(evidence);
    expect(result.purchase).toEqual({
      store: 'google-play',
      transactionId: 'GPA.1111-2222',
      storeSku: 'gems.small',
      logicalId: 'gems_small',
      quantity: 1,
      state: 'purchased',
      purchasedAt: new Date(1_790_000_000_000).toISOString(),
      token: 'private-play-token',
      evidence,
      accountBinding,
    });
    expect(JSON.stringify(result)).not.toContain('settlement');

    // Without an order id the transaction id falls back to the shared token key.
    const orderless = fakePlayPurchase({ products: ['gems.small'], purchaseToken: 'no-order-yet' });
    plugin.queuePurchase({ status: 'purchased', purchase: orderless });
    const orderlessResult = await provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    });
    const key = await createGooglePlayTokenPurchaseKey('no-order-yet');
    expect(orderlessResult).toMatchObject({ purchase: { transactionId: key } });
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
    const { provider } = createProvider(plugin, {
      onUnmappedPurchase: (purchase) => {
        unmapped.push(purchase);
      },
    });
    const listed = await provider.getAvailablePurchases();
    expect(listed.map((purchase) => [purchase.transactionId, purchase.storeSku, purchase.token])).toEqual([
      ['GPA.r', 'retired.sku', 'token-r'],
      ['GPA.v', 'gems.small', 'token-v'],
    ]);
    expect(listed[0]?.logicalId).toBeUndefined();
    expect(listed[1]?.logicalId).toBe('gems_small');
    expect(listed[0]?.evidence).toEqual({
      schema: 'google-play.product-purchase.v2',
      payload: { purchaseToken: 'token-r' },
    });

    const requests: VerifyPurchaseRequest[] = [];
    const failures: CommerceReconcilerEvent[] = [];
    const reconciler = createCommerceReconciler({
      provider,
      backend: {
        async verifyPurchase(request) {
          requests.push(request);
          return {
            verified: true,
            alreadyProcessed: false,
            ledgerEntryId: 'le-1',
            finalization: { status: 'completed', action: 'consume', alreadyCompleted: false },
          };
        },
      },
      store: createInMemoryMonetizationOperationStore(),
      playerId: 'player-1',
      target: 'android',
      products: catalog.map((entry) => ({ ...entry })),
      onEvent(event) {
        if (event.type === 'failure') {
          failures.push(event);
        }
      },
    });
    await reconciler.start();
    const valid = await reconciler.read(await createGooglePlayTokenPurchaseKey('token-v'));
    await reconciler.stop();

    expect(valid?.state).toBe('finished');
    expect(requests.map((request) => request.platformTransactionId)).toEqual(['GPA.v']);
    expect(requests[0]?.evidence).toMatchObject({ payload: { purchaseToken: 'token-v' } });
    expect(failures.map((event) => event.type === 'failure' ? event.stage : event.type)).toEqual(['catalog']);
    const catalogFailure = failures[0];
    expect(catalogFailure?.type === 'failure' ? catalogFailure.error : undefined).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('retired.sku'),
      }),
    );
    expect(unmapped).toEqual(expect.arrayContaining([
      expect.objectContaining({ purchaseToken: 'token-r' }),
    ]));
    // The client never acknowledges. The server was not asked to grant the retired token.
    expect(plugin.purchases.map((purchase) => purchase.purchaseToken)).toEqual(['token-r', 'token-v']);
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
  it('registers with the gateway and serves commerce v2 through the bridge', async () => {
    const plugin = createPlugin();
    const service = createCapacitorPlayBillingServiceProvider({
      plugin,
      isAndroid: () => true,
      products,
      accountBinding: () => accountBinding,
    });
    expect(service.id).toBe(playBillingCommerceServiceProviderId);
    expect(service.features).toEqual([]);
    expect(service.methods).toEqual([]);
    expect(service.commerce.store).toBe('google-play');

    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'play', bridge: baseBridge(),
      providers: [service],
    });
    const commerce = gateway.commerce;
    if (commerce === undefined) {
      throw new Error('expected a commerce provider');
    }
    expect(commerce.store).toBe('google-play');
    expect((await commerce.fetchProducts({})).map((product) => [
      product.logicalId, product.storeSku, product.price.formatted,
    ])).toEqual([['gems_small', 'gems.small', '$0.99'], ['remove_ads', 'remove.ads', '$1.99']]);

    const events: CommerceEvent[] = [];
    const unsubscribe = commerce.subscribe((event) => events.push(event));
    plugin.queuePurchase({ throws: Object.assign(new Error('t'), { code: 'PLAY_BILLING_TIMEOUT' }) });
    await expect(commerce.requestPurchase({
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
    expect((await commerce.getAvailablePurchases()).map((purchase) => purchase.transactionId))
      .toEqual(['GPA.l']);
    await expect(commerce.finishTransaction?.({
      transactionId: 'GPA.l', ledgerEntryId: 'le-1', isConsumable: true,
    })).rejects.toMatchObject({ storeCode: 'COMMERCE_V2_METHOD_UNSUPPORTED' });
    await expect(commerce.restorePurchases?.()).resolves.toBeUndefined();
    unsubscribe();

    const capabilities = await gateway.getCapabilities();
    expect(Object.hasOwn(capabilities, 'nativeIap')).toBe(false);
    expect(Object.hasOwn(capabilities, 'subscriptionIap')).toBe(false);
    expect(capabilities.commerce).toEqual({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      catalog: { products: true, offers: true, localizedPrice: true },
      lifecycle: {
        availablePurchases: true, pending: true, restore: false, events: true, finish: 'server',
      },
      authority: { evidence: 'client-token', accountBinding: 'required' },
      availability: 'available',
    });

    expect(plugin.purchaseCalls).toHaveLength(1);
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
    // The retired v1 commerce methods are not served any more.
    expect(await service.bridge.request(request(
      'commerce.getEntitlements' as BridgeMethod,
    ))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_METHOD' } });
    detach();
  });
});
