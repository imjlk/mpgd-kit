import { describe, expect, it, vi } from 'vitest';
import {
  createOnePlayAdProvider,
  createOnePlayCommerceCapabilities,
  createOnePlayCommerceProvider,
  createOnePlayPlatformGateway,
  onePlayCommerceStoreId,
  onePlayManagedPurchaseEvidenceSchema,
  type OnePlayCommerceProvider,
  type OnePlayEnvironment,
  type OnePlaySdk,
} from './oneplay.js';
import { toAdAdapter, type AdPresentationEvent } from '@mpgd/platform/ads';
import type { PlatformPurchasePresentationEvent } from '@mpgd/platform';
import {
  assertStorePurchase,
  CommerceError,
  isCommerceCapabilities,
  type CommerceErrorCode,
  type RequestPurchaseInput,
} from '@mpgd/platform/commerce';

function fixture() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const values = new Map<string, string>();
  const info: OnePlayEnvironment = {
    playerId: 'platform-player',
    locale: 'ko-KR',
    ringerSilent: false,
    safeArea: { top: 24, right: 0, bottom: 16, left: 0 },
  };
  const sdk: OnePlaySdk = {
    initializeAsync: vi.fn(async () => info),
    setLoadingProgress: vi.fn(),
    startGameAsync: vi.fn(async () => ({})),
    on(event: string, callback: (event: never) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
    },
    off(event, callback) {
      listeners.get(event)?.delete(callback);
    },
    onBackPressed: vi.fn(),
    ads: {
      isSupported: vi.fn(() => true),
      loadRewarded: vi.fn(),
      loadInterstitial: vi.fn(),
      isReadyAsync: vi.fn(async () => true),
      showRewardedAsync: vi.fn(async () => ({ status: 'rewarded' as const })),
      showInterstitialAsync: vi.fn(async () => ({ status: 'completed' as const })),
    },
  };
  return {
    sdk,
    values,
    info,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
    emit(event: string, payload: unknown = {}) {
      for (const callback of [...listeners.get(event) ?? []]) {
        callback(payload as never);
      }
    },
    listeners,
  };
}
const placementIds = {
  STAGE_END_INTERSTITIAL: { format: 'interstitial', platformId: 'issued-interstitial' },
} as const;
const show = {
  format: 'interstitial',
  placementId: 'STAGE_END_INTERSTITIAL',
  invocationId: 'invocation',
  idempotencyKey: 'request',
} as const;

function commerceFixture() {
  const f = fixture();
  const purchase = vi.fn(async (input: { productId: string; developerPayload: string }) => ({
    orderId: 'order',
    purchaseTimeMillis: Date.now(),
    purchaseId: 'purchase',
    purchaseToken: 'token',
    productId: input.productId,
    developerPayload: input.developerPayload,
  }));
  const sdk: OnePlaySdk = {
    ...f.sdk,
    iap: { isSupported: () => true, purchase, getProductDetailsAsync: async () => [] },
  };
  const products = [{ id: 'COINS', platformId: 'coins-sku', type: 'consumable' as const }];
  const server = {
    issueIntent: vi.fn(async () => ({ developerPayload: 'server-intent' })),
  };
  return { sdk, purchase, products, server, emit: f.emit };
}
function purchaseInput(idempotencyKey: string, overrides: Partial<RequestPurchaseInput> = {}): RequestPurchaseInput {
  return { logicalId: 'COINS', source: 'shop', idempotencyKey, ...overrides };
}
function recordPresentation(commerce: OnePlayCommerceProvider): PlatformPurchasePresentationEvent[] {
  const events: PlatformPurchasePresentationEvent[] = [];
  commerce.presentation.subscribe((event) => events.push(event));
  return events;
}
describe('ONE play H5 adapter', () => {
  it('uses authenticated checkout payloads without granting and deduplicates checkout UI', async () => {
    const f = commerceFixture();
    const commerce = createOnePlayCommerceProvider(f);
    const request = purchaseInput('checkout');
    const presentations: string[] = [];
    commerce.presentation.subscribe((event) => presentations.push(event.state));
    const first = commerce.requestPurchase(request);
    expect(commerce.requestPurchase(request)).toBe(first);
    const result = await first;
    if (result.outcome !== 'purchased') {
      throw new Error(`Expected purchased, got ${result.outcome}.`);
    }
    expect(assertStorePurchase(result.purchase)).toEqual({
      store: 'oneplay',
      transactionId: 'purchase',
      storeSku: 'coins-sku',
      logicalId: 'COINS',
      quantity: 1,
      state: 'purchased',
      token: 'token',
      evidence: {
        schema: 'oneplay.managed-purchase.v1',
        payload: {
          purchaseToken: 'token',
          purchaseId: 'purchase',
          productId: 'coins-sku',
          developerPayload: 'server-intent',
        },
      },
      accountBinding: { kind: 'host-identity' },
    });
    expect(result.purchase.evidence.schema).toBe(onePlayManagedPurchaseEvidenceSchema);
    expect(commerce.store).toBe(onePlayCommerceStoreId);
    // The client never grants: no ledger pointer and nothing is finished here.
    expect(result.purchase).not.toHaveProperty('settlement');
    expect(commerce.finishTransaction).toBeUndefined();
    expect(commerce.restorePurchases).toBeUndefined();
    expect(presentations).toEqual(['closed']);
    expect(f.purchase).toHaveBeenCalledExactlyOnceWith({
      productId: 'coins-sku',
      developerPayload: 'server-intent',
    });
    expect(f.server.issueIntent).toHaveBeenCalledWith({
      productId: 'COINS',
      platformProductId: 'coins-sku',
      idempotencyKey: 'checkout',
    });
    // A settled attempt still answers a replayed key from the same flight.
    await expect(commerce.requestPurchase(request)).resolves.toBe(result);
    expect(f.purchase).toHaveBeenCalledOnce();
    await expect(commerce.getAvailablePurchases()).resolves.toEqual([]);
    expect(commerce.subscribe(() => {})).toBeTypeOf('function');
  });
  it('rejects a replayed key that names another product or source and an invalid key', async () => {
    const f = commerceFixture();
    const commerce = createOnePlayCommerceProvider(f);
    await commerce.requestPurchase(purchaseInput('checkout'));
    await expect(commerce.requestPurchase(purchaseInput('checkout', { source: 'event' }))).rejects.toThrow(
      'identity changed',
    );
    await expect(commerce.requestPurchase(purchaseInput('checkout', { logicalId: 'OTHER' }))).rejects.toThrow(
      'identity changed',
    );
    // A replay that changes what is bought is refused, not answered from the settled flight.
    await expect(commerce.requestPurchase(purchaseInput('checkout', { quantity: 2 }))).rejects.toThrow(
      'identity changed',
    );
    await expect(commerce.requestPurchase(purchaseInput('checkout', { offerId: 'launch-offer' }))).rejects.toThrow(
      'identity changed',
    );
    await expect(commerce.requestPurchase(purchaseInput(' padded '))).rejects.toThrow('identity is invalid');
    expect(f.purchase).toHaveBeenCalledOnce();
  });
  it('reports a busy SDK as not started before rejecting so another coordinator can release its lease', async () => {
    const f = commerceFixture();
    const ads = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
    const ad = ads.show(show);
    const commerce = createOnePlayCommerceProvider(f);
    const facts = recordPresentation(commerce);
    const busy = commerce.requestPurchase(purchaseInput('busy'));
    await expect(busy).rejects.toBeInstanceOf(CommerceError);
    await expect(busy).rejects.toMatchObject({ code: 'IN_PROGRESS', storeCode: 'ONEPLAY_BUSY', retryable: false });
    expect(facts).toEqual([{ idempotencyKey: 'busy', sequence: 1, state: 'not-started' }]);
    expect(f.purchase).not.toHaveBeenCalled();
    await ad;
    expect(await commerce.requestPurchase(purchaseInput('retry'))).toMatchObject({ outcome: 'purchased' });
  });
  it('keeps purchase support independent from product detail support', async () => {
    const f = commerceFixture();
    const sdk: OnePlaySdk = {
      ...f.sdk,
      iap: { ...f.sdk.iap!, isSupported: (feature) => feature !== 'getProductDetails' },
    };
    const gateway = await createOnePlayPlatformGateway({ sdk, products: f.products, commerceServer: f.server });
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.commerce).toEqual(createOnePlayCommerceCapabilities({
      availability: 'available',
      consumable: true,
      durable: false,
      catalogProducts: false,
    }));
    expect(capabilities.commerce.purchase.consumable).toBe(true);
    expect(capabilities.commerce.catalog.products).toBe(false);
    expect(capabilities).not.toHaveProperty('nativeIap');
    expect(capabilities).not.toHaveProperty('subscriptionIap');
    expect(capabilities.providerAvailability).not.toHaveProperty('nativeIap');
    expect(await gateway.commerce?.fetchProducts({})).toEqual([]);
    await gateway.lifecycle.dispose?.();
  });
  it('batches price lookup by 20 and handles partial, reordered and unknown products', async () => {
    const f = commerceFixture();
    const products = Array.from({ length: 21 }, (_, index) => ({
      id: `P${index}`,
      platformId: `sku${index}`,
      type: 'consumable' as const,
    }));
    const details = vi.fn(async (ids: readonly string[]) =>
      [ids.at(-1)!, 'unknown', ids[0]!, ids[0]!].map((productId) => ({
        productId,
        type: 'inapp',
        title: productId,
        price: '1,000',
        priceAmountMicros: 1_000_000_000,
        priceCurrencyCode: 'KRW',
      })),
    );
    const sdk: OnePlaySdk = { ...f.sdk, iap: { ...f.sdk.iap!, getProductDetailsAsync: details } };
    const result = await createOnePlayCommerceProvider({ ...f, sdk, products }).fetchProducts({});
    expect(details.mock.calls.map(([ids]) => ids.length)).toEqual([20, 1]);
    expect(result.map((product) => product.logicalId)).toEqual(['P19', 'P0', 'P20']);
    expect(result[0]).toEqual({
      logicalId: 'P19',
      store: 'oneplay',
      storeSku: 'sku19',
      kind: 'consumable',
      title: 'sku19',
      description: '',
      price: { formatted: '1,000 KRW', currencyCode: 'KRW', amountMicros: 1_000_000_000 },
    });
  });
  it('maps product kinds, filters by logical id and skips malformed SDK details', async () => {
    const f = commerceFixture();
    const products = [
      { id: 'COINS', platformId: 'coins-sku', type: 'consumable' as const },
      { id: 'NO_ADS', platformId: 'no-ads-sku', type: 'non_consumable' as const },
      { id: 'BAD', platformId: 'bad-sku', type: 'consumable' as const },
    ];
    const detail = (productId: string, overrides: Record<string, unknown> = {}) => ({
      productId,
      type: 'inapp',
      title: productId,
      price: '1,000',
      priceAmountMicros: 1_000_000_000,
      priceCurrencyCode: 'KRW',
      ...overrides,
    });
    const details = vi.fn(async (ids: readonly string[]) => ids.map((id) => (
      id === 'bad-sku' ? detail(id, { priceCurrencyCode: 'won' }) : detail(id)
    )));
    const sdk: OnePlaySdk = { ...f.sdk, iap: { ...f.sdk.iap!, getProductDetailsAsync: details } };
    const commerce = createOnePlayCommerceProvider({ ...f, sdk, products });
    const all = await commerce.fetchProducts({});
    expect(all.map((product) => [product.logicalId, product.kind])).toEqual([
      ['COINS', 'consumable'],
      ['NO_ADS', 'durable'],
    ]);
    details.mockClear();
    expect((await commerce.fetchProducts({ logicalIds: ['NO_ADS'] })).map((product) => product.logicalId)).toEqual(['NO_ADS']);
    expect(details).toHaveBeenCalledExactlyOnceWith(['no-ads-sku']);
    await expect(commerce.fetchProducts({ type: 'subscription' })).resolves.toEqual([]);
    details.mockRejectedValueOnce(new Error('bridge down'));
    await expect(commerce.fetchProducts({})).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', retryable: true });
  });
  it.each([
    ['user_cancelled', 'cancelled', 'USER_CANCELLED'],
    ['already_processing', 'failed', 'IN_PROGRESS'],
    ['need_login', 'failed', 'ACTION_REQUIRED'],
    ['need_update', 'failed', 'ACTION_REQUIRED'],
    ['sdk_not_initialized', 'failed', 'NOT_PREPARED'],
    ['platform_not_supported', 'failed', 'STORE_UNAVAILABLE'],
    ['unsupported_action', 'failed', 'STORE_UNAVAILABLE'],
    ['invalid_request', 'failed', 'UNKNOWN'],
    ['invalid_params', 'failed', 'UNKNOWN'],
    ['security_error', 'failed', 'UNKNOWN'],
    ['payment_failed', 'failed', 'UNKNOWN'],
  ] as const)(
    'maps the %s SDK reason to a closed %s outcome and releases fullscreen ownership',
    async (reason, outcome, code) => {
      const f = commerceFixture();
      const sdk: OnePlaySdk = {
        ...f.sdk,
        iap: { ...f.sdk.iap!, purchase: async () => { throw { reason }; } },
      };
      const commerce = createOnePlayCommerceProvider({ ...f, sdk });
      const facts = recordPresentation(commerce);
      const result = await commerce.requestPurchase(purchaseInput('checkout'));
      expect(result).toEqual({
        outcome,
        error: expect.objectContaining({ code, storeCode: reason }),
      });
      expect(facts).toEqual([{ idempotencyKey: 'checkout', sequence: 1, state: 'closed' }]);
      const ads = createOnePlayAdProvider({ sdk, placementIds });
      expect((await ads.getAvailability({ format: 'interstitial', placementId: 'STAGE_END_INTERSTITIAL' })).state).toBe(
        'available',
      );
    },
  );
  it('keeps an already-owned purchase reconcilable after the SDK closes its surface', async () => {
    const f = commerceFixture();
    const sdk: OnePlaySdk = {
      ...f.sdk,
      iap: { ...f.sdk.iap!, purchase: async () => { throw { reason: 'already_owned' }; } },
    };
    const commerce = createOnePlayCommerceProvider({ ...f, sdk });
    await expect(commerce.requestPurchase(purchaseInput('owned'))).resolves.toEqual({ outcome: 'launched' });
    const ads = createOnePlayAdProvider({ sdk, placementIds });
    expect((await ads.getAvailability({ format: 'interstitial', placementId: 'STAGE_END_INTERSTITIAL' })).state)
      .toBe('available');
  });
  it.each(['timeout', 'transport', 'unlisted_reason'])(
    'keeps a %s checkout launched and shares fullscreen ownership with ads',
    async (reason) => {
      const f = commerceFixture();
      const sdk: OnePlaySdk = {
        ...f.sdk,
        iap: {
          ...f.sdk.iap!,
          purchase: async () => {
            throw reason === 'transport' ? new Error('bridge disconnected') : { reason };
          },
        },
      };
      const commerce = createOnePlayCommerceProvider({ ...f, sdk });
      const facts = recordPresentation(commerce);
      const request = purchaseInput('checkout');
      const first = commerce.requestPurchase(request);
      await expect(first).resolves.toEqual({ outcome: 'launched' });
      // The native surface may still be open: ownership stays and a replay never reopens it.
      expect(facts).toEqual([{ idempotencyKey: 'checkout', sequence: 1, state: 'unknown' }]);
      expect(commerce.requestPurchase(request)).toBe(first);
      expect(f.purchase).not.toHaveBeenCalled();
      const ads = createOnePlayAdProvider({ sdk, placementIds });
      expect((await ads.getAvailability({ format: 'interstitial', placementId: 'STAGE_END_INTERSTITIAL' })).state).toBe(
        'temporarily-unavailable',
      );
      await expect(commerce.requestPurchase(purchaseInput('another'))).rejects.toMatchObject({
        code: 'IN_PROGRESS',
        storeCode: 'ONEPLAY_BUSY',
      });
    },
  );
  it.each([
    ['purchase id', { purchaseId: '' }],
    ['purchase token', { purchaseToken: ' ' }],
    ['product id', { productId: 'other-sku' }],
    ['developer payload', { developerPayload: 'other-intent' }],
  ])('treats an SDK answer with a mismatched %s as an unknown outcome, never a purchase', async (_label, override) => {
    const f = commerceFixture();
    const sdk: OnePlaySdk = {
      ...f.sdk,
      iap: {
        ...f.sdk.iap!,
        purchase: async (input) => ({
          orderId: 'order',
          purchaseTimeMillis: 1,
          purchaseId: 'purchase',
          purchaseToken: 'token',
          productId: input.productId,
          developerPayload: input.developerPayload,
          ...override,
        }),
      },
    };
    const commerce = createOnePlayCommerceProvider({ ...f, sdk });
    const facts = recordPresentation(commerce);
    await expect(commerce.requestPurchase(purchaseInput('checkout'))).resolves.toEqual({ outcome: 'launched' });
    expect(facts.map((event) => event.state)).toEqual(['unknown']);
  });
  it('requires server integration and validates developer payload byte length before native UI', async () => {
    const f = commerceFixture();
    const unconfigured = createOnePlayCommerceProvider({ sdk: f.sdk, products: f.products });
    const facts = recordPresentation(unconfigured);
    await expect(unconfigured.requestPurchase(purchaseInput('missing'))).resolves.toEqual({
      outcome: 'failed',
      error: expect.objectContaining({ code: 'CONFIGURATION_REQUIRED' }),
    });
    expect(facts.map((event) => event.state)).toEqual(['not-started']);
    const commerce = createOnePlayCommerceProvider({
      ...f,
      server: { ...f.server, issueIntent: async () => ({ developerPayload: '한'.repeat(70) }) },
    });
    const oversizeFacts = recordPresentation(commerce);
    await expect(commerce.requestPurchase(purchaseInput('oversize'))).resolves.toEqual({
      outcome: 'failed',
      error: expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    });
    expect(oversizeFacts.map((event) => event.state)).toEqual(['not-started']);
    expect(f.purchase).not.toHaveBeenCalled();
    // The failed attempt released ownership, so another key can still check out.
    expect(await createOnePlayCommerceProvider(f).requestPurchase(purchaseInput('after'))).toMatchObject({
      outcome: 'purchased',
    });
  });
  it('keeps the server error class when intent issuance fails and never opens native UI', async () => {
    const f = commerceFixture();
    const commerce = createOnePlayCommerceProvider({
      ...f,
      server: {
        issueIntent: async () => {
          throw new CommerceError('ACCOUNT_BINDING_REQUIRED', { message: 'Sign in first.' });
        },
      },
    });
    await expect(commerce.requestPurchase(purchaseInput('intent-fail'))).resolves.toEqual({
      outcome: 'failed',
      error: expect.objectContaining({ code: 'ACCOUNT_BINDING_REQUIRED' }),
    });
    const generic = createOnePlayCommerceProvider({
      ...f,
      server: { issueIntent: async () => { throw new Error('unauthorized'); } },
    });
    await expect(generic.requestPurchase(purchaseInput('intent-fail-2'))).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'UNKNOWN' },
    });
    // A fetch-backed port rejects with a TypeError when offline: a retryable network failure, not an
    // invalid intent.
    const offline = createOnePlayCommerceProvider({
      ...f,
      server: { issueIntent: async () => { throw new TypeError('Failed to fetch'); } },
    });
    await expect(offline.requestPurchase(purchaseInput('intent-offline'))).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'NETWORK', retryable: true },
    });
    expect(f.purchase).not.toHaveBeenCalled();
  });
  it('refuses unknown products, quantities above one, offers and an unavailable SDK without opening UI', async () => {
    const f = commerceFixture();
    const commerce = createOnePlayCommerceProvider(f);
    const facts = recordPresentation(commerce);
    const refusals: [RequestPurchaseInput, CommerceErrorCode][] = [
      [purchaseInput('unknown', { logicalId: 'MISSING' }), 'ITEM_UNAVAILABLE'],
      [purchaseInput('quantity', { quantity: 2 }), 'ITEM_UNAVAILABLE'],
      [purchaseInput('offer', { offerId: 'launch-offer' }), 'ITEM_UNAVAILABLE'],
    ];
    for (const [request, code] of refusals) {
      await expect(commerce.requestPurchase(request)).resolves.toEqual({
        outcome: 'failed',
        error: expect.objectContaining({ code }),
      });
    }
    const noSdk = createOnePlayCommerceProvider({ products: f.products, server: f.server });
    await expect(noSdk.requestPurchase(purchaseInput('no-sdk'))).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_UNAVAILABLE' },
    });
    expect(facts.map((event) => event.state)).toEqual(['not-started', 'not-started', 'not-started']);
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.server.issueIntent).not.toHaveBeenCalled();
  });
  it('retries offline intent issuance with the same bound identity and shares each flight', async () => {
    const f = commerceFixture();
    let offline = true;
    const issueIntent = vi.fn(async () => {
      if (offline) {
        throw new TypeError('Failed to fetch');
      }
      return { developerPayload: 'server-intent' };
    });
    const commerce = createOnePlayCommerceProvider({ ...f, server: { issueIntent } });
    const request = purchaseInput('offline-retry');
    const [first, duplicate] = await Promise.all([
      commerce.requestPurchase(request), commerce.requestPurchase(request),
    ]);
    expect(first).toMatchObject({ outcome: 'failed', error: { code: 'NETWORK', retryable: true } });
    expect(duplicate).toEqual(first);
    expect(issueIntent).toHaveBeenCalledTimes(1);
    await expect(commerce.requestPurchase({ ...request, logicalId: 'CHANGED' })).rejects.toThrow('identity changed');
    offline = false;
    await expect(commerce.requestPurchase(request)).resolves.toMatchObject({ outcome: 'purchased' });
    await expect(commerce.requestPurchase(request)).resolves.toMatchObject({ outcome: 'purchased' });
    expect(issueIntent).toHaveBeenCalledTimes(2);
    expect(f.purchase).toHaveBeenCalledTimes(1);
  });
  it('declares the RFC oneplay profile and reports why it cannot sell', async () => {
    const f = commerceFixture();
    const sdkWith = (iap: Partial<NonNullable<OnePlaySdk['iap']>> | undefined): OnePlaySdk => {
      const { iap: _omitted, ...rest } = f.sdk;
      return iap === undefined ? rest : { ...rest, iap: { ...f.sdk.iap!, ...iap } };
    };
    const products = [
      ...f.products,
      { id: 'NO_ADS', platformId: 'no-ads-sku', type: 'non_consumable' as const },
    ];
    const available = await createOnePlayCommerceProvider({ ...f, products }).getCapabilities();
    expect(available).toEqual({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: true },
      lifecycle: { availablePurchases: false, pending: true, restore: false, events: false, finish: 'server' },
      authority: { evidence: 'client-token', accountBinding: 'host' },
      availability: 'available',
    });
    expect(isCommerceCapabilities(available)).toBe(true);
    // Only consumables are mapped: durable stays false. A fresh block per read.
    const consumableOnly = createOnePlayCommerceProvider(f);
    const first = await consumableOnly.getCapabilities();
    expect(first.purchase).toEqual({ consumable: true, durable: false, subscription: false, quantity: false });
    expect(await consumableOnly.getCapabilities()).not.toBe(first);
    // No server port, no products, no purchase support, and no SDK at all.
    await expect(createOnePlayCommerceProvider({ sdk: f.sdk, products: f.products }).getCapabilities())
      .resolves.toMatchObject({ availability: 'configuration-required' });
    await expect(createOnePlayCommerceProvider({ sdk: f.sdk, server: f.server }).getCapabilities())
      .resolves.toMatchObject({ availability: 'configuration-required', purchase: { consumable: false, durable: false } });
    await expect(createOnePlayCommerceProvider({ ...f, sdk: sdkWith({ isSupported: (feature) => feature !== 'purchase' }) }).getCapabilities())
      .resolves.toMatchObject({ availability: 'unsupported' });
    await expect(createOnePlayCommerceProvider({ ...f, sdk: sdkWith(undefined) }).getCapabilities())
      .resolves.toMatchObject({ availability: 'unsupported' });
    await expect(createOnePlayCommerceProvider({ products: f.products, server: f.server }).getCapabilities())
      .resolves.toMatchObject({ availability: 'unsupported' });
  });
  it('exposes the pure capability declaration as a fresh object per call', () => {
    const input = { availability: 'available', consumable: true, durable: true, catalogProducts: true } as const;
    const first = createOnePlayCommerceCapabilities(input);
    const second = createOnePlayCommerceCapabilities(input);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.purchase).not.toBe(first.purchase);
    expect(isCommerceCapabilities(first)).toBe(true);
    expect(createOnePlayCommerceCapabilities({ ...input, availability: 'unsupported', durable: false, catalogProducts: false }))
      .toMatchObject({
        purchase: { consumable: true, durable: false },
        catalog: { products: false, localizedPrice: false },
        availability: 'unsupported',
      });
  });
  it('rejects invalid product mappings at construction', () => {
    const f = commerceFixture();
    for (const products of [
      [{ id: '', platformId: 'sku', type: 'consumable' as const }],
      [{ id: 'A', platformId: 'sku', type: 'subscription' as never }],
      [
        { id: 'A', platformId: 'sku', type: 'consumable' as const },
        { id: 'A', platformId: 'other', type: 'consumable' as const },
      ],
      [
        { id: 'A', platformId: 'sku', type: 'consumable' as const },
        { id: 'B', platformId: 'sku', type: 'consumable' as const },
      ],
    ]) {
      expect(() => createOnePlayCommerceProvider({ ...f, products })).toThrow('mapping is invalid');
    }
  });
  it('installs the provider on the gateway and reports its block without boolean flags', async () => {
    const f = commerceFixture();
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, products: f.products, commerceServer: f.server });
    const provider = gateway.commerce;
    if (provider === undefined) {
      throw new Error('The ONE play gateway must install a commerce provider.');
    }
    expect(provider.store).toBe('oneplay');
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.commerce).toEqual(await provider.getCapabilities());
    expect(capabilities.commerce.availability).toBe('available');
    expect(await gateway.getCapabilities()).not.toHaveProperty('nativeIap');
    // The gateway's provider keeps the presentation facts and the server-issued intent flow.
    const facts: string[] = [];
    provider.presentation?.subscribe((event) => facts.push(event.state));
    expect(await provider.requestPurchase(purchaseInput('gateway'))).toMatchObject({ outcome: 'purchased' });
    expect(facts).toEqual(['closed']);
    await gateway.lifecycle.dispose?.();
  });
  it('requires server request issuance and never treats a rewarded callback as a grant', async () => {
    const f = fixture();
    const ids = { REWARD: { format: 'rewarded', platformId: 'issued-reward' } } as const;
    const missing = createOnePlayAdProvider({ sdk: f.sdk, placementIds: ids });
    expect(await missing.getAvailability({ format: 'rewarded', placementId: 'REWARD' })).toMatchObject(
      { state: 'configuration-required' },
    );
    const issueRequest = vi.fn(async () => ({ requestId: 'server-request' }));
    f.sdk.ads.showRewardedAsync = vi.fn(async ({ requestId }: { requestId: string }) => ({ status: 'rewarded' as const, requestId }));
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage, placementIds: ids, rewardRequests: { issueRequest } });
    expect(await gateway.getCapabilities()).toMatchObject({ rewardedAds: true });
    const reward = await gateway.ads.showRewarded({ placementId: 'REWARD', idempotencyKey: 'claim' });
    expect(issueRequest).toHaveBeenCalledWith({
      placementId: 'REWARD',
      platformPlacementId: 'issued-reward',
      idempotencyKey: 'claim',
    });
    expect(reward).toMatchObject({
      status: 'completed',
      rewardGranted: false,
      evidence: {
        schema: 'oneplay.rewarded-ad.callback.v1',
        payload: { requestId: 'server-request', rewardGranted: false },
      },
    });
    expect(reward.ledgerEntryId).toBeUndefined();
    await gateway.lifecycle.dispose?.();
  });
  it('does not open native UI when authenticated request issuance fails', async () => {
    const f = fixture();
    const provider = createOnePlayAdProvider({
      sdk: f.sdk,
      placementIds: { REWARD: { format: 'rewarded', platformId: 'issued' } },
      rewardRequests: {
        issueRequest: async () => {
          throw new Error('unauthorized');
        },
      },
    });
    expect(await provider.show({ ...show, format: 'rewarded', placementId: 'REWARD' })).toMatchObject(
      { presentation: 'not-started', outcome: 'failed' },
    );
    expect(f.sdk.ads.showRewardedAsync).not.toHaveBeenCalled();
    expect(await provider.getAvailability({ format: 'rewarded', placementId: 'REWARD' })).toMatchObject(
      { state: 'available' },
    );
  });
  it.each(['no_fill', 'dismissed', 'timeout', 'mismatched'])(
    'preserves reward semantics for %s',
    async (outcome) => {
      const f = fixture();
      f.sdk.ads.showRewardedAsync = async () => ({ requestId: outcome === 'mismatched' ? 'other-request' : 'server-request', status: outcome === 'dismissed' ? 'dismissed' : outcome === 'mismatched' ? 'rewarded' : 'failed', reason: outcome });
      const provider = createOnePlayAdProvider({
        sdk: f.sdk,
        placementIds: { REWARD: { format: 'rewarded', platformId: 'issued' } },
        rewardRequests: { issueRequest: async () => ({ requestId: 'server-request' }) },
      });
      const reward = await toAdAdapter(provider).showRewarded({ placementId: 'REWARD', idempotencyKey: 'claim' });
      expect(reward.rewardGranted).toBe(false);
      expect(reward.status).toBe(
        outcome === 'no_fill' ? 'unavailable' : outcome === 'dismissed' ? 'skipped' : 'pending',
      );
      if (reward.status === 'pending') {
        expect(reward.evidence?.payload.requestId).toBe('server-request');
        expect(await provider.getAvailability({ placementId: 'REWARD', format: 'rewarded' })).toMatchObject(
          { reason: 'busy' },
        );
      }
    },
  );
  it('preserves a newer ringer observation delivered during initialization', async () => {
    const f = fixture();
    f.sdk.initializeAsync = async () => { f.emit('resume', { ringerSilent: true }); return f.info; };
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    expect(gateway.gameSettings?.getAudioMuted()).toBe(true);
  });
  it('initializes before capability detection, exposes platform asserted identity and host settings', async () => {
    const f = fixture();
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage, placementIds });
    expect(f.sdk.initializeAsync).toHaveBeenCalledOnce();
    expect(await gateway.identity.getSession?.()).toEqual({
      playerId: 'platform-player',
      identityLevel: 'platform-anonymous',
      trustLevel: 'platform-asserted',
    });
    expect(gateway.gameSettings?.getLocale?.()).toBe('ko-KR');
    expect(gateway.viewport?.getState().safeAreaInsets).toEqual(f.info.safeArea);
    expect(await gateway.getCapabilities()).toMatchObject({
      interstitialAds: true,
      rewardedAds: false,
      cloudSave: false,
    });
    // The fixture SDK has no IAP surface: the provider is installed but reports it cannot sell.
    expect((await gateway.getCapabilities()).commerce).toMatchObject({ availability: 'unsupported' });
    expect(await gateway.presentation?.getLaunchIntent()).toEqual({ entry: 'free-play' });
  });
  it('retains an early pause, applies ringer changes independently and never resumes an exited document', async () => {
    const f = fixture();
    f.sdk.initializeAsync = async () => { f.emit('pause', { reason: 'background' }); return f.info; };
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    const paused = vi.fn();
    const resumed = vi.fn();
    const exit = vi.fn();
    const mute = vi.fn();
    gateway.lifecycle.onPause(paused);
    gateway.lifecycle.onResume(resumed);
    gateway.lifecycle.onExit?.(exit);
    gateway.gameSettings?.onAudioMuteChange(mute);
    expect(paused).toHaveBeenCalledOnce();
    f.emit('resume', { ringerSilent: true });
    expect(mute).toHaveBeenLastCalledWith(true);
    expect(gateway.gameSettings?.getAudioMuted()).toBe(true);
    f.emit('exit');
    f.emit('exit');
    f.emit('resume', { ringerSilent: false });
    expect(exit).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledOnce();
    await expect(gateway.gameLoading?.complete()).rejects.toThrow('terminated');
    await gateway.lifecycle.dispose?.();
    expect([...f.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
  it('shares synchronous and async checkpoint keys, isolates platform players, and preserves previous writes on serialization failure', async () => {
    const f = fixture();
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    gateway.storage.saveSync?.({ key: 'run', value: { elapsedMs: 45 } });
    expect(await gateway.storage.load({ key: 'run' })).toEqual({ value: { elapsedMs: 45 } });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => gateway.storage.saveSync?.({ key: 'run', value: cyclic })).toThrow();
    expect(await gateway.storage.load({ key: 'run' })).toEqual({ value: { elapsedMs: 45 } });
    expect([...f.values.keys()]).toEqual(['mpgd:oneplay:platform-player:run']);
  });
  it('awaits a single start acknowledgement and permits retry after rejection', async () => {
    const f = fixture();
    f.sdk.startGameAsync = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({});
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    const start = gateway.gameLoading!.complete();
    expect(gateway.gameLoading!.complete()).toBe(start);
    await expect(start).rejects.toThrow('timeout');
    await gateway.gameLoading!.complete();
    expect(f.sdk.startGameAsync).toHaveBeenCalledTimes(2);
  });
  it('keeps ordinary browser gameplay available while platform monetization is unsupported', async () => {
    const f = fixture();
    f.sdk.initializeAsync = async () => ({ err: 'Platform Not Supported' });
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    expect(gateway.gameLoading).toBeUndefined();
    expect(await gateway.identity.getSession?.()).toMatchObject({ trustLevel: 'local' });
    expect(await gateway.getCapabilities()).toMatchObject({
      rewardedAds: false,
      interstitialAds: false,
      commerce: { availability: 'unsupported' },
    });
    expect(await gateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' })).toEqual(
      { status: 'unavailable' },
    );
    expect([...f.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await gateway.lifecycle.dispose?.();
  });
  it('maps terminal outcomes, deduplicates invocations and broadcasts identical ordered events', async () => {
    const f = fixture();
    const provider = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
    const events: AdPresentationEvent[] = [];
    const second: AdPresentationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    provider.subscribe((event) => second.push(event));
    const first = provider.show(show);
    expect(provider.show(show)).toBe(first);
    await expect(first).resolves.toMatchObject({ presentation: 'closed', outcome: 'shown', eligibility: 'not-applicable' });
    expect(events.map(({ type }) => type)).toEqual(['requested', 'closed']);
    expect(events).toEqual(second);
    expect(f.sdk.ads.showInterstitialAsync).toHaveBeenCalledOnce();
    expect(() => provider.show({ ...show, placementId: 'another' })).toThrow('identity changed');
  });
  it.each(['timeout', 'network_error', 'internal_error'])(
    'quarantines %s even after the SDK has synthesized resume and rejects another gateway request',
    async (reason) => {
      const f = fixture();
      f.sdk.ads.showInterstitialAsync = async () => { f.emit('resume'); return { status: 'failed', reason }; };
      const provider = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
      await expect(provider.show(show)).resolves.toMatchObject({ outcome: 'pending', presentation: 'unknown' });
      const another = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
      expect(await another.getAvailability(show)).toEqual({
        state: 'temporarily-unavailable',
        reason: 'busy',
      });
    },
  );
  it('treats no fill as no presentation without any reward and frees its native owner', async () => {
    const f = fixture();
    f.sdk.ads.showInterstitialAsync = async () => ({ status: 'failed', reason: 'no_fill' });
    const provider = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
    expect(await provider.show(show)).toMatchObject({
      outcome: 'unavailable',
      presentation: 'not-started',
      reason: 'no-fill',
    });
    expect(await provider.getAvailability(show)).toEqual({ state: 'available' });
  });
  it('releases fullscreen ownership when an ad show rejects before the host pauses and does not grant', async () => {
    const f = commerceFixture();
    f.sdk.ads.showRewardedAsync = async () => {
      throw new Error('bridge lost');
    };
    const provider = createOnePlayAdProvider({
      sdk: f.sdk,
      placementIds: { REWARD: { format: 'rewarded', platformId: 'issued' } },
      rewardRequests: { issueRequest: async () => ({ requestId: 'server-request' }) },
      showTimeoutMs: 40,
      recoveryTimeoutMs: 40,
    });
    const events: string[] = [];
    provider.subscribe((event) => events.push(event.type));
    const commerce = createOnePlayCommerceProvider(f);
    const reward = await toAdAdapter(provider).showRewarded({ placementId: 'REWARD', idempotencyKey: 'claim' });
    expect(reward.rewardGranted).toBe(false);
    expect(reward.status).toBe('failed');
    expect(reward.evidence).toBeUndefined();
    expect(events).not.toContain('reward-earned');
    expect(await provider.getAvailability({ format: 'rewarded', placementId: 'REWARD' })).toEqual({ state: 'available' });
    await expect(commerce.requestPurchase(purchaseInput('after-reject'))).resolves.toMatchObject({ outcome: 'purchased' });
  });
  it('keeps occupancy after a rejection that paused, then releases it on the recovery bound without granting', async () => {
    vi.useFakeTimers();
    try {
      const f = commerceFixture();
      f.sdk.ads.showInterstitialAsync = async () => {
        f.emit('pause', { reason: 'ad' });
        throw new Error('bridge lost');
      };
      const provider = createOnePlayAdProvider({ sdk: f.sdk, placementIds, showTimeoutMs: 40, recoveryTimeoutMs: 40 });
      const commerce = createOnePlayCommerceProvider(f);
      const pending = provider.show(show);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toMatchObject({ outcome: 'pending', presentation: 'unknown', reason: 'outcome-unknown' });
      expect(await provider.getAvailability(show)).toMatchObject({ reason: 'busy' });
      await expect(commerce.requestPurchase(purchaseInput('during'))).rejects.toMatchObject({ code: 'IN_PROGRESS' });
      await vi.advanceTimersByTimeAsync(40);
      expect(await provider.getAvailability(show)).toEqual({ state: 'available' });
      await expect(commerce.requestPurchase(purchaseInput('after'))).resolves.toMatchObject({ outcome: 'purchased' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('resolves a show that never settles as pending without granting, and frees checkout after recovery or a later terminal result', async () => {
    vi.useFakeTimers();
    try {
      const f = commerceFixture();
      let finish: ((result: { status: 'rewarded'; requestId: string }) => void) | undefined;
      f.sdk.ads.showRewardedAsync = () => new Promise((resolve) => {
        finish = resolve;
      });
      const provider = createOnePlayAdProvider({
        sdk: f.sdk,
        placementIds: { REWARD: { format: 'rewarded', platformId: 'issued' } },
        rewardRequests: { issueRequest: async () => ({ requestId: 'server-request' }) },
        showTimeoutMs: 40,
        recoveryTimeoutMs: 80,
      });
      const events: string[] = [];
      provider.subscribe((event) => events.push(event.type));
      const commerce = createOnePlayCommerceProvider(f);
      const pending = toAdAdapter(provider).showRewarded({ placementId: 'REWARD', idempotencyKey: 'claim' });
      await vi.advanceTimersByTimeAsync(40);
      const reward = await pending;
      expect(reward).toMatchObject({
        status: 'pending',
        rewardGranted: false,
        evidence: { payload: { requestId: 'server-request', rewardGranted: false } },
      });
      expect(events).toEqual(['requested', 'unknown']);
      await expect(commerce.requestPurchase(purchaseInput('during'))).rejects.toMatchObject({ code: 'IN_PROGRESS' });
      finish?.({ status: 'rewarded', requestId: 'server-request' });
      await vi.advanceTimersByTimeAsync(0);
      expect(events).not.toContain('reward-earned');
      expect(reward.rewardGranted).toBe(false);
      expect(await provider.getAvailability({ format: 'rewarded', placementId: 'REWARD' })).toEqual({ state: 'available' });
      await expect(commerce.requestPurchase(purchaseInput('after-terminal'))).resolves.toMatchObject({ outcome: 'purchased' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('frees an unsettled show on the recovery bound when the SDK never calls back', async () => {
    vi.useFakeTimers();
    try {
      const f = commerceFixture();
      f.sdk.ads.showInterstitialAsync = () => new Promise(() => {});
      const provider = createOnePlayAdProvider({ sdk: f.sdk, placementIds, showTimeoutMs: 20, recoveryTimeoutMs: 20 });
      const commerce = createOnePlayCommerceProvider(f);
      const pending = provider.show(show);
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toMatchObject({ outcome: 'pending', presentation: 'unknown' });
      await expect(commerce.requestPurchase(purchaseInput('during'))).rejects.toMatchObject({ code: 'IN_PROGRESS' });
      await vi.advanceTimersByTimeAsync(20);
      expect(await provider.getAvailability(show)).toEqual({ state: 'available' });
      await expect(commerce.requestPurchase(purchaseInput('after-recovery'))).resolves.toMatchObject({ outcome: 'purchased' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('clears fullscreen owners on dispose so a hung ad cannot wedge the next checkout', async () => {
    vi.useFakeTimers();
    try {
      const f = commerceFixture();
      f.sdk.ads.showInterstitialAsync = () => new Promise(() => {});
      const gateway = await createOnePlayPlatformGateway({
        sdk: f.sdk,
        products: f.products,
        commerceServer: f.server,
        placementIds,
      });
      const hung = gateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' });
      await gateway.lifecycle.dispose?.();
      const commerce = createOnePlayCommerceProvider(f);
      await expect(commerce.requestPurchase(purchaseInput('after-dispose'))).resolves.toMatchObject({ outcome: 'purchased' });
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(commerce.requestPurchase(purchaseInput('after-dispose-timer'))).resolves.toMatchObject({ outcome: 'purchased' });
      void hung;
    } finally {
      vi.useRealTimers();
    }
  });
  it('consumes the host back event when a handler returns a promise', async () => {
    const f = fixture();
    let host: (() => boolean) | undefined;
    f.sdk.onBackPressed = (callback) => {
      host = callback;
    };
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    let older = 0;
    gateway.lifecycle.onBackButton?.(() => {
      older += 1;
      return Promise.resolve(false);
    });
    gateway.lifecycle.onBackButton?.(() => false);
    expect(host?.()).toBe(true);
    expect(older).toBe(1);
    await gateway.lifecycle.dispose?.();
  });
});
