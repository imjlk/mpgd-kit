import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  assertBridgeEvent,
  bridgeCommerceV2Methods,
  type BridgeCommerceEvent,
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
  createUnsupportedCommerceCapabilities,
  type CommerceEvent,
  type CommerceProvider,
} from '@mpgd/platform/commerce';

import { createFakeStoreSdk, fakePurchase, type FakeStoreSdk } from '../test/store-sdk-fixture.js';
import {
  createBridgeCommerceProvider,
  createCommerceProviderBridge,
  createCommerceServiceProvider,
  type CommerceProviderBridge,
  type CreateBridgeCommerceProviderInput,
} from './commerce-bridge.js';
import { createCapacitorPlatformGateway } from './index.js';
import {
  createCapacitorProviderRegistry,
  createDegradedCommerceCapabilities,
  type CapacitorCommerceServiceProvider,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';
import { createStoreCommerceProvider } from './store-commerce-provider.js';

// The retired v1 names; `BridgeMethod` no longer lists them.
const retiredV1CommerceMethods = [
  'commerce.getProducts',
  'commerce.purchase',
  'commerce.restore',
  'commerce.getEntitlements',
] as unknown as readonly BridgeMethod[];

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

  it('does not serve the retired v1 commerce methods', async () => {
    const { sdk, provider } = createStoreProvider();
    const bridge = createCommerceProviderBridge({ provider });
    for (const method of retiredV1CommerceMethods) {
      expect(await bridge.request(request(method, { productId: 'gems_small' })))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_METHOD', retryable: false } });
    }
    expect(sdk.requestCalls).toHaveLength(0);

    // A retired name is not a commerce method, so a fallback bridge owns the answer.
    const fallback = vi.fn(async (input: BridgeRequest) => ({
      id: input.id,
      ok: false as const,
      error: { code: 'UNSUPPORTED_METHOD', message: 'Fallback.', retryable: false },
    }));
    const withFallback = createCommerceProviderBridge({ provider, fallback: { request: fallback } });
    await withFallback.request(request(retiredV1CommerceMethods[1] as BridgeMethod));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(sdk.requestCalls).toHaveLength(0);
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
  it('keeps the commerce envelope type on the commerce-only channels', () => {
    // A listener written for the commerce envelope, as `BridgeEvent` was before
    // notifications v2, still fits each channel that carries only commerce.
    const onCommerce = (envelope: BridgeCommerceEvent): void => {
      expect(envelope.protocol).toBe(commerceProtocol);
    };
    const { provider } = createStoreProvider();
    const bridge: CommerceProviderBridge = createCommerceProviderBridge({ provider });
    bridge.subscribe(onCommerce)();
    const input: CreateBridgeCommerceProviderInput = {
      store: 'fixture.store',
      request: async () => undefined as never,
      subscribe: (listener) => bridge.subscribe(listener),
    };
    input.subscribe(onCommerce)();
    expectTypeOf<Parameters<CommerceProviderBridge['subscribe']>[0]>()
      .toEqualTypeOf<(event: BridgeCommerceEvent) => void>();
    expectTypeOf<Parameters<CreateBridgeCommerceProviderInput['subscribe']>[0]>()
      .toEqualTypeOf<(event: BridgeCommerceEvent) => void>();
  });

  it('unwraps envelopes, ignores foreign protocols, and reports invalid ones', () => {
    let deliver: ((event: BridgeCommerceEvent) => void) | undefined;
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
    // A notifications v2 envelope on a channel shared despite its type is not
    // commerce's to judge.
    deliver?.({
      protocol: 'mpgd.notifications.v2',
      sequence: 0,
      event: { type: 'opened', channel: 'remote', source: 'warm', topic: 'energy-full' },
    } satisfies BridgeEvent as never);
    deliver?.({ protocol: commerceProtocol, sequence: 'x', event: {} } as never);
    // A notifications event under the commerce protocol is a malformed commerce envelope.
    deliver?.({
      protocol: commerceProtocol,
      sequence: 1,
      event: { type: 'received', channel: 'local' },
    } as never);
    // An envelope that names no protocol is malformed, not another protocol's.
    deliver?.({ sequence: 2, event: { type: 'purchaseUpdated' } } as never);
    deliver?.({ protocol: 7, sequence: 3, event: { type: 'purchaseUpdated' } } as never);
    expect(events).toEqual([
      { type: 'purchaseUpdated', purchase: expect.objectContaining({ transactionId: 'tx-1' }) },
      { type: 'purchaseError', error: expect.objectContaining({ code: 'INVALID_RESPONSE' }) },
      { type: 'purchaseError', error: expect.objectContaining({ code: 'INVALID_RESPONSE' }) },
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

describe('provider registry with a commerce provider', () => {
  it('implies the six commerce v2 methods and exposes the provider', async () => {
    const { provider } = createStoreProvider();
    const service = createCommerceServiceProvider({ id: 'store', commerce: provider });
    expect(service.features).toEqual([]);
    expect(service.methods).toEqual([]);
    const registry = createCapacitorProviderRegistry([service]);
    for (const method of bridgeCommerceV2Methods) {
      expect(registry.byMethod.get(method)?.id).toBe('store');
    }
    for (const method of retiredV1CommerceMethods) {
      expect(registry.byMethod.has(method)).toBe(false);
    }
    expect(registry.commerce?.commerce).toBe(provider);
    expect(registry.byMethod.size).toBe(6);
    await expect(registry.assertMethodReady('commerce.v2.requestPurchase')).resolves.toBeUndefined();
  });

  it('reports the provider capability block next to the feature states', async () => {
    let availability: PlatformProviderAvailability = 'available';
    const sdk = createFakeStoreSdk({ availability: async () => availability });
    const { provider } = createStoreProvider(sdk);
    const registry = createCapacitorProviderRegistry([
      createCommerceServiceProvider({ id: 'store', commerce: provider }),
    ]);
    const first = await registry.getCapabilitySnapshot();
    expect(first.commerce).toEqual(await provider.getCapabilities());
    expect(first.commerce.availability).toBe('available');
    // Commerce readiness is the block, not a feature: nothing else is available.
    expect(Object.values(first.availability).every((state) => state === 'unsupported')).toBe(true);
    expect(Object.keys(first.availability)).not.toContain('nativeIap');
    availability = 'configuration-required';
    const second = await registry.getCapabilitySnapshot();
    expect(second.commerce.availability).toBe('configuration-required');
    expect(second.commerce).not.toBe(first.commerce);
    expect(second.commerce.purchase).not.toBe(first.commerce.purchase);
    // The v2 provider fails closed itself before any store UI opens.
    await expect(registry.assertMethodReady('commerce.v2.requestPurchase')).resolves.toBeUndefined();
    await expect(provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op', source: 'shop',
    })).rejects.toMatchObject({ code: 'CONFIGURATION_REQUIRED' });
  });

  it('reports the unsupported block when no commerce provider is registered', async () => {
    const registry = createCapacitorProviderRegistry([]);
    const first = await registry.getCapabilitySnapshot();
    expect(first.commerce).toEqual(createUnsupportedCommerceCapabilities());
    expect(registry.commerce).toBeUndefined();
    const second = await registry.getCapabilitySnapshot();
    expect(second.commerce).not.toBe(first.commerce);
    expect(second.commerce.purchase).not.toBe(first.commerce.purchase);
  });

  it('serves commerce and feature providers together', async () => {
    const { provider } = createStoreProvider();
    const banner: CapacitorServiceProvider = {
      id: 'banner',
      features: ['bannerAds'],
      methods: ['ads.mountBanner', 'ads.unmountBanner'],
      async getAvailability() { return { bannerAds: 'available' }; },
      bridge: { async request(input) { return { id: input.id, ok: true, data: null }; } },
    };
    const registry = createCapacitorProviderRegistry([
      createCommerceServiceProvider({ id: 'store', commerce: provider }),
      banner,
    ]);
    const snapshot = await registry.getCapabilitySnapshot();
    expect(snapshot.availability.bannerAds).toBe('available');
    expect(snapshot.commerce.availability).toBe('available');
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
    const pending = registry.getCapabilitySnapshot();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).commerce).toEqual(createDegradedCommerceCapabilities());
  });

  it('rejects providers that declare retired or implied methods or lack the event surface', () => {
    const { provider } = createStoreProvider();
    const service = createCommerceServiceProvider({ id: 'store', commerce: provider });
    for (const method of retiredV1CommerceMethods) {
      expect(() => createCapacitorProviderRegistry([{ ...service, methods: [method] }]))
        .toThrow(/cannot replace base method/);
    }
    for (const method of bridgeCommerceV2Methods) {
      expect(() => createCapacitorProviderRegistry([{ ...service, methods: [method] }]))
        .toThrow(/commerce v2 is unavailable/);
    }
    // A feature the commerce bridge does not own needs its methods declared.
    expect(() => createCapacitorProviderRegistry([{
      ...service, features: ['rewardedAds'],
    }])).toThrow(/lacks methods/);
    expect(() => createCapacitorProviderRegistry([{
      ...service, bridge: { request: service.bridge.request },
    }])).toThrow(/no subscribe/);
    expect(() => createCapacitorProviderRegistry([
      service, { ...service, id: 'second' },
    ])).toThrow(/multiple providers/);
    // Without a commerce provider a registration still needs features and methods.
    const { commerce: _commerce, ...plain } = service;
    expect(() => createCapacitorProviderRegistry([plain])).toThrow(/must declare features/);
    const rewarded: CapacitorServiceProvider = {
      id: 'rewarded',
      features: ['rewardedAds'],
      methods: ['ads.preload', 'ads.showRewarded'],
      bridge: { async request(input) { return { id: input.id, ok: true, data: null }; } },
      async getAvailability() { return { rewardedAds: 'available' }; },
    };
    expect(createCapacitorProviderRegistry([service, rewarded]).commerce?.id).toBe('store');
    expect(createCapacitorProviderRegistry([rewarded]).commerce).toBeUndefined();
  });
});

describe('gateway with a commerce provider', () => {
  it('hands its commerce provider only the commerce envelopes of a shared channel', () => {
    const { provider } = createStoreProvider();
    const served = createCommerceServiceProvider({ id: 'store', commerce: provider });
    let emit: ((envelope: BridgeEvent) => void) | undefined;
    const shared: CapacitorCommerceServiceProvider = {
      ...served,
      bridge: {
        request: (input) => served.bridge.request(input),
        subscribe(listener) {
          emit = listener;
          return () => {
            emit = undefined;
          };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '3', buildId: 'shared', bridge: baseBridge(),
      providers: [shared],
    });
    const events: CommerceEvent[] = [];
    gateway.commerce?.subscribe((event) => events.push(event));
    // A notifications envelope on the provider's channel is not commerce's.
    emit?.({
      protocol: 'mpgd.notifications.v2',
      sequence: 0,
      event: { type: 'received', channel: 'remote' },
    });
    expect(events).toEqual([]);
    // A malformed envelope still reaches the commerce provider's validator.
    emit?.(null as never);
    expect(events).toEqual([
      { type: 'purchaseError', error: expect.objectContaining({ code: 'INVALID_RESPONSE' }) },
    ]);
  });

  it('exposes the provider over the bridge path', async () => {
    const { sdk, provider } = createStoreProvider();
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '3', buildId: 'v2', bridge: baseBridge(),
      providers: [createCommerceServiceProvider({ id: 'store', commerce: provider })],
    });
    const commerce = gateway.commerce;
    expect(commerce?.store).toBe('fixture.store');
    if (commerce === undefined) {
      throw new Error('expected a commerce provider');
    }
    expect((await commerce.fetchProducts({})).map((product) => product.logicalId))
      .toEqual(['gems_small']);
    const events: CommerceEvent[] = [];
    const unsubscribe = commerce.subscribe((event) => events.push(event));
    await expect(commerce.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });
    sdk.report(fakePurchase({ transactionId: 'tx-1' }));
    expect(events).toEqual([
      { type: 'purchaseUpdated', purchase: expect.objectContaining({ logicalId: 'gems_small' }) },
    ]);
    expect((await commerce.getAvailablePurchases()).map((purchase) => purchase.transactionId))
      .toEqual(['tx-1']);
    // The host is this package's: the retry hint crosses the bridge to the SDK.
    expect(commerce.acceptsFinishRetry).toBe(true);
    await expect(commerce.finishTransaction?.({
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true, retry: true,
    })).resolves.toEqual({ finished: true });
    expect(sdk.finishCalls.at(-1)).toEqual(
      { transactionId: 'tx-1', isConsumable: true, ledgerEntryId: 'le-1', retry: true },
    );
    await expect(commerce.requestPurchase({
      logicalId: 'nope', idempotencyKey: 'op-2', source: 'shop',
    })).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    unsubscribe();
    expect(sdk.requestCalls).toHaveLength(1);
  });

  it('keeps the store code of a pre-launch refusal across the bridge path', async () => {
    const sdk = createFakeStoreSdk();
    let paused = true;
    const commerce = createStoreCommerceProvider({
      sdk,
      products: [{ logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' }],
      evidenceSchema: 'fixture.store.v1',
      authority: { evidence: 'client-token', accountBinding: 'required' },
      purchaseGate: () => (paused ? { allowed: false } : { allowed: true }),
      accountBinding: async () => {
        throw new CommerceError('ACCOUNT_BINDING_REQUIRED', { storeCode: 'SESSION_EXPIRED' });
      },
    });
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '3', buildId: 'v2', bridge: baseBridge(),
      providers: [createCommerceServiceProvider({ id: 'store', commerce })],
    });
    const bridged = gateway.commerce;
    if (bridged === undefined) {
      throw new Error('expected a commerce provider');
    }
    await expect(bridged.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: 'PURCHASES_PAUSED', retryable: false },
    });
    paused = false;
    await expect(bridged.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ACCOUNT_BINDING_REQUIRED', storeCode: 'SESSION_EXPIRED' },
    });
    expect(sdk.requestCalls).toEqual([]);
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
      bannerAds: false,
    };
    const providerAvailability = {
      rewardedAds: 'unsupported',
      interstitialAds: 'unsupported', bannerAds: 'unsupported', nativeLeaderboard: 'unsupported',
      identityUpgrade: 'unsupported', pushNotifications: 'unsupported',
    } as const;
    const commerce = await provider.getCapabilities();
    const report = await runPlatformGatewayCapabilityConformance({
      fixtures: [{
        name: 'ios:commerce',
        gateway,
        expectedTarget: 'ios',
        expectedCapabilities: { ...base, providerAvailability, commerce },
        transition: {
          update() {
            availability = 'configuration-required';
          },
          expectedCapabilities: {
            ...base,
            providerAvailability,
            commerce: { ...commerce, availability: 'configuration-required' },
          },
        },
      }],
    });
    expect(report.passedFixtures).toEqual(['ios:commerce']);
  });

  it('omits the provider and reports the unsupported block without one', async () => {
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'none', bridge: baseBridge(),
    });
    expect(gateway.commerce).toBeUndefined();
    expect('commerce' in gateway).toBe(false);
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.commerce).toEqual(createUnsupportedCommerceCapabilities());
    expect((await gateway.getCapabilities()).commerce).not.toBe(capabilities.commerce);
  });

  it('never carries the retired boolean flags, whatever the native shell sends', async () => {
    const { provider } = createStoreProvider();
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1', buildId: 'stale-shell',
      bridge: {
        async request(input) {
          return {
            id: input.id,
            ok: true,
            data: {
              ...createUnsupportedCapabilities(),
              nativeIap: true,
              subscriptionIap: true,
              commerce: { availability: 'available' },
            },
          };
        },
      },
      providers: [createCommerceServiceProvider({ id: 'store', commerce: provider })],
    });
    const capabilities = await gateway.getCapabilities();
    expect(Object.hasOwn(capabilities, 'nativeIap')).toBe(false);
    expect(Object.hasOwn(capabilities, 'subscriptionIap')).toBe(false);
    expect(capabilities.commerce).toEqual(await provider.getCapabilities());
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
      expect(capabilities.commerce, name).toEqual(degraded);
      expect(Object.hasOwn(capabilities, 'nativeIap'), name).toBe(false);
      expect(Object.hasOwn(capabilities.providerAvailability ?? {}, 'nativeIap'), name).toBe(false);
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
      availability: expect.objectContaining({ rewardedAds: 'unsupported' }),
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
    expect(capabilities.commerce.purchase).not.toBe(shared.purchase);
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
