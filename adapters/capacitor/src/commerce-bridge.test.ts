import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertBridgeEvent,
  bridgeCommerceV2Methods,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeRequest,
} from '@mpgd/bridge';
import { createUnsupportedCapabilities, type PlatformProviderAvailability } from '@mpgd/platform';
import { runPlatformGatewayCapabilityConformance } from '@mpgd/platform/capability-conformance';
import {
  CommerceError,
  commerceProtocol,
  commerceProtocolVersion,
  type CommerceEvent,
  type CommerceProvider,
} from '@mpgd/platform/commerce';

import { createFakeStoreSdk, fakePurchase, type FakeStoreSdk } from '../test/store-sdk-fixture.js';
import {
  createBridgeCommerceProvider,
  createCommerceProviderBridge,
  createCommerceServiceProvider,
} from './commerce-bridge.js';
import { createCapacitorPlatformGateway } from './index.js';
import {
  createCapacitorProviderRegistry,
  createDegradedCommerceCapabilities,
  deriveCommerceFeatureStates,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';
import { createStoreCommerceProvider } from './store-commerce-provider.js';

const v1CommerceMethods = [
  'commerce.getProducts',
  'commerce.purchase',
  'commerce.restore',
  'commerce.getEntitlements',
] as const;

function request(method: BridgeMethod, payload: unknown = {}): BridgeRequest {
  return {
    id: `${method}:${Math.random()}`,
    method,
    payload,
    meta: { target: 'android', appVersion: '1', buildId: 'test', sentAt: new Date().toISOString() },
  };
}

function createStoreProvider(
  sdk: FakeStoreSdk = createFakeStoreSdk({
    products: [
      {
        sku: 'gems.small',
        kind: 'consumable',
        title: 'Gems',
        description: 'Pack',
        price: { formatted: '$0.99', currencyCode: 'USD' },
      },
    ],
  }),
) {
  return {
    sdk,
    provider: createStoreCommerceProvider({
      sdk,
      products: [{ logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' }],
      evidenceSchema: 'fixture.store.v1',
      authority: { evidence: 'client-token', accountBinding: 'optional' },
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

afterEach(() => {
  vi.useRealTimers();
});

describe('createCommerceProviderBridge', () => {
  it('serves the six v2 methods with validated payloads and results', async () => {
    const { sdk, provider } = createStoreProvider();
    const bridge = createCommerceProviderBridge({ provider });

    const capabilities = await bridge.request(request('commerce.v2.getCapabilities', {
      protocol: commerceProtocol,
    }));
    expect(capabilities).toMatchObject({
      ok: true,
      data: {
        protocolVersion: commerceProtocolVersion,
        store: 'fixture.store',
        capabilities: { availability: 'available', lifecycle: { finish: 'client' } },
      },
    });
    expect(await bridge.request(request('commerce.v2.fetchProducts', { type: 'all' })))
      .toMatchObject({ ok: true, data: { products: [{ logicalId: 'gems_small' }] } });
    expect(await bridge.request(request('commerce.v2.requestPurchase', {
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    }))).toEqual({ id: expect.any(String), ok: true, data: { outcome: 'launched' } });
    sdk.upsert(fakePurchase({ transactionId: 'tx-1' }));
    expect(await bridge.request(request('commerce.v2.getAvailablePurchases', {})))
      .toMatchObject({ ok: true, data: { purchases: [{ transactionId: 'tx-1' }] } });
    expect(await bridge.request(request('commerce.v2.finishTransaction', {
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true,
    }))).toMatchObject({ ok: true, data: { finished: true } });
    expect(await bridge.request(request('commerce.v2.restorePurchases', {
      protocol: commerceProtocol,
    }))).toMatchObject({ ok: true, data: { restored: true } });
    expect(sdk.restoreCalls).toBe(1);
  });

  it('answers invalid payloads, unsupported methods, and provider failures with bridge errors', async () => {
    const { provider } = createStoreProvider(createFakeStoreSdk({ finish: false, restore: false }));
    const bridge = createCommerceProviderBridge({ provider });

    expect(await bridge.request(request('commerce.v2.getCapabilities', { protocol: 'other' })))
      .toMatchObject({ ok: false, error: { code: 'COMMERCE_V2_INVALID_PAYLOAD', retryable: false } });
    expect(await bridge.request(request('commerce.v2.requestPurchase', {
      logicalId: 'gems_small', idempotencyKey: '', source: 'shop',
    }))).toMatchObject({ ok: false, error: { code: 'COMMERCE_V2_INVALID_PAYLOAD' } });
    expect(await bridge.request(request('commerce.v2.requestPurchase', {
      logicalId: 'unknown', idempotencyKey: 'op', source: 'shop',
    }))).toMatchObject({ ok: false, error: { code: 'ITEM_UNAVAILABLE', retryable: false } });
    expect(await bridge.request(request('commerce.v2.finishTransaction', {
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true,
    }))).toMatchObject({ ok: false, error: { code: 'COMMERCE_V2_METHOD_UNSUPPORTED' } });
    expect(await bridge.request(request('commerce.v2.restorePurchases', {
      protocol: commerceProtocol,
    }))).toMatchObject({ ok: true, data: { restored: false } });
    expect(await bridge.request(request('storage.load', { key: 'x' })))
      .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_METHOD' } });

    const fallback = vi.fn(async (input: BridgeRequest) => ({ id: input.id, ok: true as const, data: null }));
    const withFallback = createCommerceProviderBridge({ provider, fallback: { request: fallback } });
    expect(await withFallback.request(request('ads.preload', { format: 'rewarded' })))
      .toMatchObject({ ok: true, data: null });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('never forwards a provider result the contract rejects', async () => {
    const provider: CommerceProvider = {
      store: 'broken',
      async getCapabilities() {
        return { purchase: { consumable: 'yes' } } as never;
      },
      async fetchProducts() {
        return [{ logicalId: 'x' }] as never;
      },
      async requestPurchase() {
        return { outcome: 'purchased', purchase: { transactionId: 'tx' } } as never;
      },
      async getAvailablePurchases() {
        return [{ settlement: { ledgerEntryId: 'forged' } }] as never;
      },
      subscribe() {
        return () => undefined;
      },
    };
    const bridge = createCommerceProviderBridge({ provider });
    for (const [method, payload] of [
      ['commerce.v2.getCapabilities', { protocol: commerceProtocol }],
      ['commerce.v2.fetchProducts', {}],
      ['commerce.v2.requestPurchase', { logicalId: 'x', idempotencyKey: 'k', source: 'shop' }],
      ['commerce.v2.getAvailablePurchases', {}],
    ] as const) {
      expect(await bridge.request(request(method, payload))).toMatchObject({
        ok: false, error: { code: 'NATIVE_PROVIDER_INVALID_RESPONSE', retryable: false },
      });
    }
  });

  it('serves v1 callers through toCommerceAdapter without granting', async () => {
    const { sdk, provider } = createStoreProvider();
    const bridge = createCommerceProviderBridge({ provider });
    expect(await bridge.request(request('commerce.getProducts'))).toMatchObject({
      ok: true,
      data: [{ id: 'gems_small', type: 'consumable', price: { currencyCode: 'USD' } }],
    });
    sdk.queueRequest({ outcome: 'purchased', purchase: fakePurchase({ transactionId: 'tx-1' }) });
    expect(await bridge.request(request('commerce.purchase', {
      productId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    }))).toMatchObject({
      ok: true,
      data: {
        status: 'completed', transactionId: 'tx-1', entitlementIds: [],
        evidence: { schema: 'fixture.store.v1' },
      },
    });
    const purchase = await bridge.request(request('commerce.purchase', {
      productId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    }));
    expect(purchase.ok && 'authoritativeGrant' in (purchase.data as object)).toBe(false);
    expect(await bridge.request(request('commerce.restore'))).toMatchObject({
      ok: true, data: { restoredEntitlements: [], settledPurchases: [] },
    });
    expect(await bridge.request(request('commerce.getEntitlements'))).toMatchObject({
      ok: true, data: [],
    });
  });

  it('delivers events in the envelope with one per-session sequence', () => {
    const { sdk, provider } = createStoreProvider();
    const bridge = createCommerceProviderBridge({ provider });
    sdk.report(fakePurchase({ transactionId: 'tx-0' }));

    const first: BridgeEvent[] = [];
    const second: BridgeEvent[] = [];
    const unsubscribeFirst = bridge.subscribe((event) => first.push(assertBridgeEvent(event)));
    expect(first).toEqual([{
      protocol: 'mpgd.commerce.v2', sequence: 0,
      event: { type: 'purchaseUpdated', purchase: expect.objectContaining({ transactionId: 'tx-0' }) },
    }]);
    const unsubscribeSecond = bridge.subscribe((event) => second.push(event));
    sdk.emit({ type: 'purchaseError', sku: 'gems.small', error: { code: 'NETWORK' } });
    expect(first.map((event) => event.sequence)).toEqual([0, 1]);
    expect(second.map((event) => event.sequence)).toEqual([1]);
    expect(second[0]?.event).toMatchObject({ type: 'purchaseError', logicalId: 'gems_small' });

    unsubscribeFirst();
    unsubscribeFirst();
    sdk.report(fakePurchase({ transactionId: 'tx-2' }));
    expect(first).toHaveLength(2);
    expect(second.map((event) => event.sequence)).toEqual([1, 2]);

    // After the last listener leaves the provider buffers again, and the next
    // subscriber receives the buffered event with the next sequence number.
    unsubscribeSecond();
    sdk.report(fakePurchase({ transactionId: 'tx-3' }));
    const third: BridgeEvent[] = [];
    bridge.subscribe((event) => third.push(event));
    expect(third).toEqual([expect.objectContaining({ sequence: 3 })]);
  });
});

describe('createBridgeCommerceProvider', () => {
  it('unwraps envelopes, ignores foreign protocols, and reports invalid ones', () => {
    let deliver: ((event: BridgeEvent) => void) | undefined;
    const provider = createBridgeCommerceProvider({
      store: 'fixture.store',
      request: async () => undefined as never,
      subscribe(listener) {
        deliver = listener;
        return () => undefined;
      },
    });
    const events: CommerceEvent[] = [];
    provider.subscribe((event) => events.push(event));
    const purchase = fakePurchase({ transactionId: 'tx-1' });
    deliver?.({
      protocol: commerceProtocol, sequence: 0,
      event: {
        type: 'purchaseUpdated',
        purchase: {
          store: 'fixture.store', transactionId: 'tx-1', storeSku: purchase.sku, quantity: 1,
          state: 'purchased', token: purchase.token,
          evidence: { schema: 'fixture.store.v1', payload: { token: purchase.token } },
        },
      },
    });
    deliver?.({ protocol: 'mpgd.other.v1', sequence: 1, event: { type: 'nope' } } as never);
    // Notifications v2 envelopes share the channel and are not commerce's to judge.
    deliver?.({
      protocol: 'mpgd.notifications.v2',
      sequence: 0,
      event: { type: 'opened', channel: 'remote', source: 'warm', topic: 'energy-full' },
    });
    deliver?.({ protocol: commerceProtocol, sequence: 'x', event: {} } as never);
    // A notifications event under the commerce protocol is a malformed commerce envelope.
    deliver?.({
      protocol: commerceProtocol,
      sequence: 1,
      event: { type: 'received', channel: 'local' },
    } as never);
    expect(events).toEqual([
      { type: 'purchaseUpdated', purchase: expect.objectContaining({ transactionId: 'tx-1' }) },
      { type: 'purchaseError', error: expect.objectContaining({ code: 'INVALID_RESPONSE' }) },
      { type: 'purchaseError', error: expect.objectContaining({ code: 'INVALID_RESPONSE' }) },
    ]);
  });

  it('turns bridge failures into commerce errors and validates answers', async () => {
    const answers = new Map<string, unknown>();
    const provider = createBridgeCommerceProvider({
      store: 'fixture.store',
      async request(method) {
        const answer = answers.get(method);
        if (answer instanceof Error) {
          throw answer;
        }
        return answer as never;
      },
      subscribe: () => () => undefined,
    });
    answers.set('commerce.v2.fetchProducts', { products: 'nope' });
    await expect(provider.fetchProducts({})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    answers.set('commerce.v2.requestPurchase', Object.assign(new Error('bridge'), {
      code: 'NATIVE_PROVIDER_INVALID_RESPONSE', retryable: false,
    }));
    await expect(provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op', source: 'shop',
    })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE', storeCode: 'NATIVE_PROVIDER_INVALID_RESPONSE',
    });
    answers.set('commerce.v2.restorePurchases', new CommerceError('STORE_UNAVAILABLE'));
    await expect(provider.restorePurchases?.()).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE', retryable: true,
    });
    answers.set('commerce.v2.finishTransaction', { finished: false });
    await expect(provider.finishTransaction?.({
      transactionId: 'tx', ledgerEntryId: 'le', isConsumable: false,
    })).resolves.toEqual({ finished: false });
  });
});

describe('provider registry with a commerce v2 provider', () => {
  it('implies the ten commerce methods and exposes the provider', async () => {
    const { provider } = createStoreProvider();
    const service = createCommerceServiceProvider({ id: 'store', commerce: provider });
    const registry = createCapacitorProviderRegistry([service]);
    for (const method of [...v1CommerceMethods, ...bridgeCommerceV2Methods]) {
      expect(registry.byMethod.get(method)?.id).toBe('store');
    }
    expect(registry.commerce?.commerce).toBe(provider);
    expect(registry.byMethod.size).toBe(10);
    await expect(registry.assertMethodReady('commerce.v2.requestPurchase')).resolves.toBeUndefined();
  });

  it('derives commerce readiness from the provider capabilities', async () => {
    let availability: PlatformProviderAvailability = 'available';
    const sdk = createFakeStoreSdk({ availability: async () => availability });
    const { provider } = createStoreProvider(sdk);
    const registry = createCapacitorProviderRegistry([
      createCommerceServiceProvider({
        id: 'store', commerce: provider, features: ['nativeIap', 'subscriptionIap'],
      }),
    ]);
    expect(await registry.getAvailability()).toMatchObject({
      nativeIap: 'available', subscriptionIap: 'unsupported', rewardedAds: 'unsupported',
    });
    availability = 'configuration-required';
    expect((await registry.getAvailability()).nativeIap).toBe('configuration-required');
    await expect(registry.assertMethodReady('commerce.purchase', {}, 'consumable'))
      .rejects.toMatchObject({ code: 'NATIVE_PROVIDER_CONFIGURATION_REQUIRED' });

    expect(deriveCommerceFeatureStates(undefined, ['nativeIap', 'subscriptionIap'])).toEqual({
      nativeIap: 'temporarily-unavailable', subscriptionIap: 'temporarily-unavailable',
    });
    expect(deriveCommerceFeatureStates({
      ...(await provider.getCapabilities()),
      purchase: { consumable: false, durable: false, subscription: true, quantity: false },
    }, ['nativeIap', 'subscriptionIap', 'rewardedAds'])).toEqual({
      nativeIap: 'unsupported', subscriptionIap: 'configuration-required',
    });
  });

  it('bounds a stalled capability read like a stalled availability read', async () => {
    vi.useFakeTimers();
    const stalled: CommerceProvider = {
      ...createStoreProvider().provider,
      getCapabilities: () => new Promise(() => undefined),
    };
    const registry = createCapacitorProviderRegistry([
      createCommerceServiceProvider({ id: 'store', commerce: stalled }),
    ]);
    const pending = registry.getAvailability();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).nativeIap).toBe('temporarily-unavailable');
  });

  it('rejects providers that mix v1 and v2 commerce or lack the event surface', () => {
    const { provider } = createStoreProvider();
    const service = createCommerceServiceProvider({ id: 'store', commerce: provider });
    expect(() => createCapacitorProviderRegistry([{
      ...service, methods: ['commerce.purchase'],
    }])).toThrow(/cannot declare both/);
    for (const method of bridgeCommerceV2Methods) {
      expect(() => createCapacitorProviderRegistry([{ ...service, methods: [method] }]))
        .toThrow(/commerce v2 is unavailable/);
    }
    expect(() => createCapacitorProviderRegistry([{
      ...service, features: ['rewardedAds'],
    }])).toThrow(/no commerce feature/);
    expect(() => createCapacitorProviderRegistry([{
      ...service, bridge: { request: service.bridge.request },
    }])).toThrow(/no subscribe/);
    expect(() => createCapacitorProviderRegistry([
      service, { ...service, id: 'second' },
    ])).toThrow(/multiple providers/);
    const v1: CapacitorServiceProvider = {
      id: 'v1', features: ['nativeIap'], methods: v1CommerceMethods,
      bridge: { async request(input) { return { id: input.id, ok: true, data: [] }; } },
      async getAvailability() { return { nativeIap: 'available' }; },
    };
    expect(() => createCapacitorProviderRegistry([service, v1])).toThrow(/multiple providers/);
    expect(createCapacitorProviderRegistry([v1]).commerce).toBeUndefined();
  });
});

describe('gateway with a commerce v2 provider', () => {
  it('exposes commerceV2 over the bridge path and serves v1 callers', async () => {
    const { sdk, provider } = createStoreProvider();
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '3', buildId: 'v2', bridge: baseBridge(),
      providers: [createCommerceServiceProvider({ id: 'store', commerce: provider })],
    });
    const commerceV2 = gateway.commerceV2;
    expect(commerceV2?.store).toBe('fixture.store');
    if (commerceV2 === undefined) {
      throw new Error('expected commerceV2');
    }
    expect((await commerceV2.fetchProducts({})).map((product) => product.logicalId))
      .toEqual(['gems_small']);
    const events: CommerceEvent[] = [];
    const unsubscribe = commerceV2.subscribe((event) => events.push(event));
    await expect(commerceV2.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });
    sdk.report(fakePurchase({ transactionId: 'tx-1' }));
    expect(events).toEqual([
      { type: 'purchaseUpdated', purchase: expect.objectContaining({ logicalId: 'gems_small' }) },
    ]);
    expect((await commerceV2.getAvailablePurchases()).map((purchase) => purchase.transactionId))
      .toEqual(['tx-1']);
    await expect(commerceV2.finishTransaction?.({
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true,
    })).resolves.toEqual({ finished: true });
    await expect(commerceV2.requestPurchase({
      logicalId: 'nope', idempotencyKey: 'op-2', source: 'shop',
    })).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    unsubscribe();

    expect(await gateway.commerce.getProducts()).toMatchObject([{ id: 'gems_small' }]);
    await expect(gateway.commerce.purchase({
      productId: 'gems_small', idempotencyKey: 'op-3', source: 'shop',
    })).resolves.toEqual({ status: 'pending', entitlementIds: [] });
    await expect(gateway.commerce.restore?.()).resolves.toEqual({
      restoredEntitlements: [], settledPurchases: [],
    });
    expect(sdk.requestCalls).toHaveLength(2);
  });

  it('reports the commerce capability block and passes capability conformance', async () => {
    let availability: PlatformProviderAvailability = 'available';
    const sdk = createFakeStoreSdk({ availability: async () => availability });
    const { provider } = createStoreProvider(sdk);
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1', buildId: 'caps', bridge: baseBridge(),
      providers: [createCommerceServiceProvider({ id: 'store', commerce: provider })],
    });
    const base = {
      ...createUnsupportedCapabilities(),
      subscriptionIap: false,
      bannerAds: false,
    };
    const providerAvailability = {
      nativeIap: 'available', subscriptionIap: 'unsupported', rewardedAds: 'unsupported',
      interstitialAds: 'unsupported', bannerAds: 'unsupported', nativeLeaderboard: 'unsupported',
      identityUpgrade: 'unsupported', pushNotifications: 'unsupported',
    } as const;
    const commerce = await provider.getCapabilities();
    const report = await runPlatformGatewayCapabilityConformance({
      fixtures: [{
        name: 'ios:commerce-v2',
        gateway,
        expectedTarget: 'ios',
        expectedCapabilities: { ...base, nativeIap: true, providerAvailability, commerce },
        transition: {
          update() {
            availability = 'configuration-required';
          },
          expectedCapabilities: {
            ...base,
            nativeIap: false,
            providerAvailability: { ...providerAvailability, nativeIap: 'configuration-required' },
            commerce: { ...commerce, availability: 'configuration-required' },
          },
        },
      }],
    });
    expect(report.passedFixtures).toEqual(['ios:commerce-v2']);
  });

  it('changes nothing without a v2 provider', async () => {
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'v1', bridge: baseBridge(),
    });
    expect(gateway.commerceV2).toBeUndefined();
    expect('commerce' in (await gateway.getCapabilities())).toBe(false);
  });

  it('degrades the commerce block instead of rejecting the capability read', async () => {
    const degraded = createDegradedCommerceCapabilities();
    const cases: readonly (readonly [string, CommerceProvider['getCapabilities']])[] = [
      ['rejecting', async () => { throw new Error('sdk'); }],
      ['throwing', () => { throw new Error('sync'); }],
      ['invalid', async () => ({ purchase: { consumable: 'yes' } }) as never],
      ['extra keys', async () => ({
        ...(await createStoreProvider().provider.getCapabilities()), extra: true,
      }) as never],
    ];
    for (const [name, getCapabilities] of cases) {
      const gateway = createCapacitorPlatformGateway({
        target: 'android', appVersion: '1', buildId: name, bridge: baseBridge(),
        providers: [createCommerceServiceProvider({
          id: 'store', commerce: { ...createStoreProvider().provider, getCapabilities },
        })],
      });
      const capabilities = await gateway.getCapabilities();
      expect(capabilities, name).toMatchObject({
        nativeIap: false,
        subscriptionIap: false,
        providerAvailability: { nativeIap: 'temporarily-unavailable' },
        commerce: degraded,
      });
      const again = await gateway.getCapabilities();
      expect(again.commerce, name).not.toBe(capabilities.commerce);
    }
  });

  it('bounds a stalled provider in the registry snapshot the gateway reads', async () => {
    vi.useFakeTimers();
    const registry = createCapacitorProviderRegistry([
      createCommerceServiceProvider({
        id: 'store',
        commerce: {
          ...createStoreProvider().provider,
          getCapabilities: () => new Promise(() => undefined),
        },
      }),
    ]);
    const pending = registry.getCapabilitySnapshot();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toEqual({
      availability: expect.objectContaining({ nativeIap: 'temporarily-unavailable' }),
      commerce: createDegradedCommerceCapabilities(),
    });
  });

  it('serves the block from one bounded read and never hands out the provider object', async () => {
    let reads = 0;
    const { provider } = createStoreProvider();
    const shared = await provider.getCapabilities();
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1', buildId: 'single-read', bridge: baseBridge(),
      providers: [createCommerceServiceProvider({
        id: 'store',
        commerce: {
          ...provider,
          async getCapabilities() {
            reads += 1;
            return shared;
          },
        },
      })],
    });
    const capabilities = await gateway.getCapabilities();
    expect(reads).toBe(1);
    expect(capabilities.commerce).toEqual(shared);
    expect(capabilities.commerce).not.toBe(shared);
    expect(capabilities.commerce?.purchase).not.toBe(shared.purchase);
  });
});

describe('commerce v2 payload validation', () => {
  it('rejects a null available-purchases payload instead of defaulting it', async () => {
    const { provider } = createStoreProvider();
    const bridge = createCommerceProviderBridge({ provider });
    expect(await bridge.request(request('commerce.v2.getAvailablePurchases', null)))
      .toMatchObject({ ok: false, error: { code: 'COMMERCE_V2_INVALID_PAYLOAD' } });
    expect(await bridge.request({
      ...request('commerce.v2.getAvailablePurchases'), payload: undefined,
    })).toMatchObject({ ok: false, error: { code: 'COMMERCE_V2_INVALID_PAYLOAD' } });
    expect(await bridge.request(request('commerce.v2.getAvailablePurchases', {})))
      .toMatchObject({ ok: true, data: { purchases: [] } });
  });
});
