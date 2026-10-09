import { describe, expect, it, vi } from 'vitest';
import {
  createOnePlayAdProvider,
  createOnePlayCommerceAdapter,
  createOnePlayPlatformGateway,
  type OnePlayEnvironment,
  type OnePlaySdk,
} from './oneplay.js';
import { toAdAdapter, type AdPresentationEvent } from '@mpgd/platform/ads';

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
    getEntitlements: vi.fn(async () => []),
    restore: vi.fn(async () => ({ restoredEntitlements: [] })),
  };
  return { sdk, purchase, products, server };
}
describe('ONE play H5 adapter', () => {
  it('uses authenticated checkout payloads without granting and deduplicates checkout UI', async () => {
    const f = commerceFixture();
    const commerce = createOnePlayCommerceAdapter(f);
    const request = { productId: 'COINS', source: 'shop' as const, idempotencyKey: 'checkout' };
    const presentations: string[] = [];
    commerce.presentation?.subscribe((event) => presentations.push(event.state));
    const first = commerce.purchase(request);
    expect(commerce.purchase(request)).toBe(first);
    const result = await first;
    expect(result).toMatchObject({
      status: 'completed',
      transactionId: 'purchase',
      entitlementIds: [],
      evidence: {
        schema: 'oneplay.managed-purchase.v1',
        payload: {
          developerPayload: 'server-intent',
          purchaseToken: 'token',
          productId: 'coins-sku',
        },
      },
    });
    expect(result.authoritativeGrant).toBeUndefined();
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
    await commerce.restore?.();
    expect(f.server.restore).toHaveBeenCalledOnce();
  });
  it('keeps purchase support independent from product detail support', async () => {
    const f = commerceFixture();
    const sdk: OnePlaySdk = {
      ...f.sdk,
      iap: { ...f.sdk.iap!, isSupported: (feature) => feature !== 'getProductDetails' },
    };
    const gateway = await createOnePlayPlatformGateway({ sdk, products: f.products, commerceServer: f.server });
    expect(await gateway.getCapabilities()).toMatchObject({
      nativeIap: true,
      subscriptionIap: false,
    });
    expect(await gateway.commerce.getProducts()).toEqual([]);
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
    const result = await createOnePlayCommerceAdapter({ ...f, sdk, products }).getProducts();
    expect(details.mock.calls.map(([ids]) => ids.length)).toEqual([20, 1]);
    expect(result.map((product) => product.id)).toEqual(['P19', 'P0', 'P20']);
    expect(result[0]?.price).toEqual({ formatted: '1,000 KRW', currencyCode: 'KRW' });
  });
  it.each(['user_cancelled', 'already_owned', 'timeout', 'transport'])(
    'handles checkout %s and shares fullscreen ownership with ads',
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
      const result = await createOnePlayCommerceAdapter({ ...f, sdk }).purchase({ productId: 'COINS', source: 'shop', idempotencyKey: 'checkout' });
      expect(result.status).toBe(
        reason === 'user_cancelled'
          ? 'cancelled'
          : reason === 'already_owned'
            ? 'failed'
            : 'pending',
      );
      const ads = createOnePlayAdProvider({ sdk, placementIds });
      expect((await ads.getAvailability({ format: 'interstitial', placementId: 'STAGE_END_INTERSTITIAL' })).state).toBe(
        reason === 'timeout' || reason === 'transport' ? 'temporarily-unavailable' : 'available',
      );
    },
  );
  it('requires server integration and validates developer payload byte length before native UI', async () => {
    const f = commerceFixture();
    expect((await createOnePlayCommerceAdapter({ sdk: f.sdk, products: f.products }).purchase({ productId: 'COINS', source: 'shop', idempotencyKey: 'missing' })).status).toBe(
      'failed',
    );
    const commerce = createOnePlayCommerceAdapter({
      ...f,
      server: { ...f.server, issueIntent: async () => ({ developerPayload: '한'.repeat(70) }) },
    });
    expect((await commerce.purchase({ productId: 'COINS', source: 'shop', idempotencyKey: 'oversize' })).status).toBe(
      'failed',
    );
    expect(f.purchase).not.toHaveBeenCalled();
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
      nativeIap: false,
      cloudSave: false,
    });
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
      nativeIap: false,
      rewardedAds: false,
      interstitialAds: false,
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
});
