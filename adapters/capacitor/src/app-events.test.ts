import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginListenerHandle } from '@capacitor/core';
import type { BridgeResponse } from '@mpgd/bridge';

import { createFakeStoreSdk, fakePurchase } from '../test/store-sdk-fixture.js';
import { createCommerceServiceProvider } from './commerce-bridge.js';
import { createCapacitorPlatformGateway, launchedPurchaseActivityTimeoutMs } from './index.js';
import {
  createCapacitorAppEvents,
  type CapacitorAppEventsApi,
  type CapacitorVisibilitySource,
} from './app-events.js';
import type { CapacitorServiceProvider } from './providers.js';
import { createStoreCommerceProvider } from './store-commerce-provider.js';

class FakeApp {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  launchUrl: string | undefined;
  active = true;
  exits = 0;
  delayed = false;
  private readonly pending: Array<() => void> = [];

  addListener(name: string, callback: (event: unknown) => void): Promise<PluginListenerHandle> {
    const listeners = this.listeners.get(name) ?? new Set<(event: unknown) => void>();
    listeners.add(callback);
    this.listeners.set(name, listeners);
    const handle = {
      remove: async () => {
        listeners.delete(callback);
      },
    };
    if (!this.delayed) {
      return Promise.resolve(handle);
    }
    return new Promise((resolve) => {
      this.pending.push(() => resolve(handle));
    });
  }

  emit(name: string, event: unknown): void {
    for (const callback of this.listeners.get(name) ?? []) {
      callback(event);
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  releaseRegistrations(): void {
    for (const release of this.pending.splice(0)) {
      release();
    }
  }

  async getState() {
    return { isActive: this.active };
  }
  async getLaunchUrl() {
    return this.launchUrl === undefined ? undefined : { url: this.launchUrl };
  }
  async exitApp() {
    this.exits += 1;
  }
}

class FakeVisibility implements CapacitorVisibilitySource {
  hidden = false;
  readonly listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', callback: () => void) {
    this.listeners.add(callback);
  }
  removeEventListener(_type: 'visibilitychange', callback: () => void) {
    this.listeners.delete(callback);
  }
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    for (const callback of this.listeners) {
      callback();
    }
  }
}

const asApp = (fake: FakeApp): CapacitorAppEventsApi => fake as unknown as CapacitorAppEventsApi;
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('Capacitor App event ownership', () => {
  it('emits one initial pause for an already-hidden page and isolates late callback errors', async () => {
    const fake = new FakeApp();
    const visibility = new FakeVisibility();
    visibility.hidden = true;
    const errors: unknown[] = [];
    const events = createCapacitorAppEvents({
      target: 'ios', app: asApp(fake), visibility,
      onError(error) { errors.push(error); },
    });
    let firstPauses = 0;
    events.onPause(() => { firstPauses += 1; });
    expect(firstPauses).toBe(1);
    expect(() => events.onPause(() => { throw new Error('late pause callback'); })).not.toThrow();
    expect(errors).toHaveLength(1);
    await settle();
    expect(firstPauses).toBe(1);
    await events.dispose?.();
  });

  it('reports a cached App listener registration failure only once', async () => {
    const fake = new FakeApp();
    fake.addListener = async () => { throw new Error('App plugin unavailable'); };
    const errors: unknown[] = [];
    const events = createCapacitorAppEvents({
      target: 'ios', app: asApp(fake), visibility: null,
      onError(error) { errors.push(error); },
    });
    events.onPause(() => {});
    events.onResume(() => {});
    await settle();
    events.onGameUrlOpen?.(() => {});
    await settle();
    expect(errors).toHaveLength(1);
    await events.dispose?.();
  });

  it('deduplicates native and visibility transitions and holds external UI', async () => {
    const fake = new FakeApp();
    const visibility = new FakeVisibility();
    const events = createCapacitorAppEvents({ target: 'android', app: asApp(fake), visibility });
    let pauses = 0;
    let resumes = 0;
    events.onPause(() => {
      pauses += 1;
    });
    events.onResume(() => {
      resumes += 1;
    });
    await settle();
    fake.emit('appStateChange', { isActive: false });
    visibility.setHidden(true);
    expect(pauses).toBe(1);
    fake.emit('appStateChange', { isActive: true });
    expect(resumes).toBe(0);
    visibility.setHidden(false);
    expect(resumes).toBe(1);
    const release = events.beginExternalActivity?.();
    expect(pauses).toBe(2);
    fake.emit('appStateChange', { isActive: false });
    fake.emit('appStateChange', { isActive: true });
    expect(resumes).toBe(1);
    release?.();
    release?.();
    expect(resumes).toBe(2);
    await events.dispose?.();
    expect(fake.listenerCount()).toBe(0);
    expect(visibility.listeners.size).toBe(0);
  });

  it('does not deliver a stale resume after a subscriber reenters pause', async () => {
    const fake = new FakeApp();
    const events = createCapacitorAppEvents({ target: 'android', app: asApp(fake), visibility: null });
    let openExternal = true;
    let release: (() => void) | undefined;
    const later: string[] = [];
    events.onResume(() => {
      if (openExternal) {
        openExternal = false;
        release = events.beginExternalActivity?.();
      }
    });
    events.onPause(() => { later.push('pause'); });
    events.onResume(() => { later.push('resume'); });
    await settle();
    fake.emit('appStateChange', { isActive: false });
    fake.emit('appStateChange', { isActive: true });
    expect(later.at(-1)).toBe('pause');
    expect(later).not.toContain('resume');
    release?.();
    expect(later.at(-1)).toBe('resume');
    await events.dispose?.();
  });

  it('keeps game links and OAuth redirects on separate cold and warm paths', async () => {
    const fake = new FakeApp();
    fake.launchUrl = 'mpgd://game/daily';
    const events = createCapacitorAppEvents({
      target: 'ios',
      app: asApp(fake),
      visibility: null,
      classifyIncomingUrl(url) {
        return url.includes('/game/') ? 'game' : url.includes('/oauth/') ? 'oauth' : null;
      },
    });
    const game: string[] = [];
    const oauth: string[] = [];
    events.onGameUrlOpen?.((event) => game.push(event.url));
    events.onOAuthRedirect?.((event) => oauth.push(event.url));
    expect(await events.getInitialGameUrl?.()).toEqual({
      url: 'mpgd://game/daily',
      source: 'cold',
      route: '/daily',
    });
    expect(await events.getInitialOAuthRedirect?.()).toBeNull();
    fake.emit('appUrlOpen', { url: 'mpgd://game/daily' });
    expect(game).toEqual([]);
    fake.emit('appUrlOpen', { url: 'mpgd://oauth/callback?code=secret' });
    fake.emit('appUrlOpen', { url: 'https://not-this-game.example/' });
    expect(game).toEqual([]);
    expect(oauth).toEqual(['mpgd://oauth/callback?code=secret']);
    fake.emit('appUrlOpen', { url: 'mpgd://game/daily' });
    expect(game).toEqual(['mpgd://game/daily']);
    await events.dispose?.();
  });

  it('delivers a game link only with a route the shared route rule accepts', async () => {
    const fake = new FakeApp();
    fake.launchUrl = 'mpgd://game//evil.example/x';
    const events = createCapacitorAppEvents({
      target: 'android',
      app: asApp(fake),
      visibility: null,
      classifyIncomingUrl: (url) => (url.includes('oauth') ? 'oauth' : 'game'),
    });
    const game: unknown[] = [];
    const oauth: string[] = [];
    events.onGameUrlOpen?.((event) => game.push(event));
    events.onOAuthRedirect?.((event) => oauth.push(event.url));
    // A cold link whose path names another host is not delivered either.
    await expect(events.getInitialGameUrl?.()).resolves.toBeNull();
    await settle();
    for (const url of [
      'mpgd://game//evil.example/x',
      'mpgd://game/.//evil.example/x',
      'mpgd://game/%2F%2Fevil.example/x',
      'mpgd://game/.%2F/evil.example/x',
      'https://game.example/%5Cevil.example/x',
      'https://game.example/%3F%2F..%2F%2Fevil.example/x',
      'mpgd://game/daily\u0000',
      'not a url',
    ]) {
      fake.emit('appUrlOpen', { url });
    }
    expect(game).toEqual([]);
    fake.emit('appUrlOpen', { url: 'mpgd://game/levels/../daily?from=push#top' });
    fake.emit('appUrlOpen', { url: 'https://game.example/a%20b/%C3%A9' });
    // The host is not part of the route.
    fake.emit('appUrlOpen', { url: 'mpgd://level/3' });
    fake.emit('appUrlOpen', { url: 'mpgd://game?entry=daily' });
    fake.emit('appUrlOpen', { url: 'mpgd://game#top' });
    // No path to check: the router maps these itself and checks what it derives.
    fake.emit('appUrlOpen', { url: 'mpgd://daily' });
    fake.emit('appUrlOpen', { url: 'mpgd:daily' });
    expect(game).toEqual([
      {
        url: 'mpgd://game/levels/../daily?from=push#top',
        source: 'warm',
        route: '/daily?from=push#top',
      },
      { url: 'https://game.example/a%20b/%C3%A9', source: 'warm', route: '/a%20b/%C3%A9' },
      { url: 'mpgd://level/3', source: 'warm', route: '/3' },
      { url: 'mpgd://game?entry=daily', source: 'warm', route: '/?entry=daily' },
      { url: 'mpgd://game#top', source: 'warm', route: '/#top' },
      { url: 'mpgd://daily', source: 'warm' },
      { url: 'mpgd:daily', source: 'warm' },
    ]);
    // OAuth redirects are not routes and keep their own path.
    fake.emit('appUrlOpen', { url: 'mpgd://oauth//callback?code=secret' });
    expect(oauth).toEqual(['mpgd://oauth//callback?code=secret']);
    await events.dispose?.();
  });

  it('preserves a cold URL when a warm event had no matching subscriber', async () => {
    const fake = new FakeApp();
    let finishLaunch: ((value: { url: string }) => void) | undefined;
    fake.getLaunchUrl = () => new Promise((resolve) => { finishLaunch = resolve; });
    const events = createCapacitorAppEvents({
      target: 'ios', app: asApp(fake), visibility: null,
      classifyIncomingUrl: () => 'game',
    });
    const cold = events.getInitialGameUrl?.();
    fake.emit('appUrlOpen', { url: 'mpgd://game/unread' });
    finishLaunch?.({ url: 'mpgd://game/unread' });
    await expect(cold).resolves.toEqual({
      url: 'mpgd://game/unread', source: 'cold', route: '/unread',
    });
    await events.dispose?.();
  });

  it('lets the game handle back and applies fallback only when unhandled', async () => {
    const fake = new FakeApp();
    let historyBacks = 0;
    const events = createCapacitorAppEvents({
      target: 'android',
      app: asApp(fake),
      visibility: null,
      historyBack() {
        historyBacks += 1;
      },
    });
    const unsubscribe = events.onBackButton?.(async () => true);
    await settle();
    fake.emit('backButton', { canGoBack: false });
    await settle();
    expect(fake.exits).toBe(0);
    unsubscribe?.();
    fake.emit('backButton', { canGoBack: true });
    await settle();
    expect(historyBacks).toBe(1);
    fake.emit('backButton', { canGoBack: false });
    await settle();
    expect(fake.exits).toBe(1);
    await events.dispose?.();
  });

  it('removes only owned handles when disposed during async registration', async () => {
    const fake = new FakeApp();
    fake.delayed = true;
    const events = createCapacitorAppEvents({ target: 'ios', app: asApp(fake), visibility: null });
    events.onPause(() => {});
    const disposing = events.dispose?.();
    await disposing;
    expect(fake.listenerCount()).toBe(2);
    fake.releaseRegistrations();
    await settle();
    expect(fake.listenerCount()).toBe(0);
  });

  it('reads the cold URL even when native listener registration is delayed', async () => {
    const fake = new FakeApp();
    fake.delayed = true;
    fake.launchUrl = 'mpgd://game/first';
    const events = createCapacitorAppEvents({
      target: 'ios', app: asApp(fake), visibility: null,
      classifyIncomingUrl: () => 'game',
    });
    await expect(events.getInitialGameUrl?.()).resolves.toEqual({
      url: 'mpgd://game/first', source: 'cold', route: '/first',
    });
    await events.dispose?.();
    fake.releaseRegistrations();
    await settle();
    expect(fake.listenerCount()).toBe(0);
  });

  it('does not perform the Android fallback after an async handler is disposed', async () => {
    const fake = new FakeApp();
    let finish: ((handled: boolean) => void) | undefined;
    const events = createCapacitorAppEvents({ target: 'android', app: asApp(fake), visibility: null });
    events.onBackButton?.(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await settle();
    fake.emit('backButton', { canGoBack: false });
    await settle();
    await events.dispose?.();
    finish?.(false);
    await settle();
    expect(fake.exits).toBe(0);
  });

  it('does not dispatch duplicate back presses while an async handler is pending', async () => {
    const fake = new FakeApp();
    let finish: ((handled: boolean) => void) | undefined;
    const events = createCapacitorAppEvents({ target: 'android', app: asApp(fake), visibility: null });
    let calls = 0;
    events.onBackButton?.(() => {
      calls += 1;
      return new Promise<boolean>((resolve) => { finish = resolve; });
    });
    await settle();
    fake.emit('backButton', { canGoBack: false });
    fake.emit('backButton', { canGoBack: false });
    expect(calls).toBe(1);
    finish?.(false);
    await settle();
    expect(fake.exits).toBe(1);
    await events.dispose?.();
  });

  it('does not remove a second gateway registration during teardown', async () => {
    const fake = new FakeApp();
    const first = createCapacitorAppEvents({
      target: 'android',
      app: asApp(fake),
      visibility: null,
    });
    const second = createCapacitorAppEvents({
      target: 'android',
      app: asApp(fake),
      visibility: null,
    });
    let firstPauses = 0;
    let secondPauses = 0;
    first.onPause(() => {
      firstPauses += 1;
    });
    second.onPause(() => {
      secondPauses += 1;
    });
    await settle();
    expect(fake.listenerCount()).toBe(4);
    fake.emit('appStateChange', { isActive: false });
    expect([firstPauses, secondPauses]).toEqual([1, 1]);
    await first.dispose?.();
    expect(fake.listenerCount()).toBe(2);
    fake.emit('appStateChange', { isActive: true });
    fake.emit('appStateChange', { isActive: false });
    expect([firstPauses, secondPauses]).toEqual([1, 2]);
    await second.dispose?.();
    expect(fake.listenerCount()).toBe(0);
  });

  it('keeps a native purchase UI pause until the provider settles', async () => {
    const fake = new FakeApp();
    let finish: ((response: BridgeResponse) => void) | undefined;
    const provider: CapacitorServiceProvider = {
      id: 'purchase-ui',
      features: ['nativeIap'],
      methods: [
        'commerce.getProducts', 'commerce.purchase', 'commerce.restore',
        'commerce.getEntitlements',
      ],
      async getAvailability() { return { nativeIap: 'available' }; },
      bridge: {
        async request(input) {
          return await new Promise<BridgeResponse>((resolve) => {
            finish = (response) => resolve({ ...response, id: input.id });
          });
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'purchase-ui',
      app: asApp(fake), visibility: null, providers: [provider],
      bridge: { async request(input) { return { id: input.id, ok: true, data: null }; } },
    });
    let pauses = 0;
    let resumes = 0;
    gateway.lifecycle.onPause(() => { pauses += 1; });
    gateway.lifecycle.onResume(() => { resumes += 1; });
    await settle();
    const purchase = gateway.commerce.purchase({
      productId: 'COINS_100', source: 'shop', idempotencyKey: 'purchase-ui',
    });
    await settle();
    expect(pauses).toBe(1);
    fake.emit('appStateChange', { isActive: false });
    fake.emit('appStateChange', { isActive: true });
    expect(resumes).toBe(0);
    expect(finish).toBeDefined();
    finish?.({ id: '', ok: true, data: { status: 'pending', entitlementIds: [] } });
    await expect(purchase).resolves.toMatchObject({ status: 'pending' });
    expect(resumes).toBe(1);
    await gateway.lifecycle.dispose?.();
  });
});

describe('commerce v2 launched purchase activity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createLaunchedGateway(fake: FakeApp) {
    const sdk = createFakeStoreSdk();
    const commerce = createStoreCommerceProvider({
      sdk,
      products: [
        { logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' },
        { logicalId: 'remove_ads', storeSku: 'remove.ads', kind: 'durable' },
      ],
      evidenceSchema: 'fixture.store.v1',
      authority: { evidence: 'client-token', accountBinding: 'optional' },
    });
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'launched-ui',
      app: asApp(fake), visibility: null,
      providers: [createCommerceServiceProvider({ id: 'store', commerce })],
      bridge: { async request(input) { return { id: input.id, ok: true, data: null }; } },
    });
    const counts = { pauses: 0, resumes: 0 };
    gateway.lifecycle.onPause(() => { counts.pauses += 1; });
    gateway.lifecycle.onResume(() => { counts.resumes += 1; });
    return { sdk, gateway, counts };
  }

  it('stays paused after a launched purchase until that product reports', async () => {
    const fake = new FakeApp();
    const { sdk, gateway, counts } = createLaunchedGateway(fake);
    await settle();
    const commerceV2 = gateway.commerceV2;
    if (commerceV2 === undefined) {
      throw new Error('expected commerceV2');
    }
    commerceV2.subscribe(() => undefined);
    await expect(commerceV2.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).resolves.toEqual({ outcome: 'launched' });
    await settle();
    expect(counts).toEqual({ pauses: 1, resumes: 0 });
    fake.emit('appStateChange', { isActive: false });
    fake.emit('appStateChange', { isActive: true });
    expect(counts.resumes).toBe(0);
    // Another product's result does not end this purchase's activity.
    sdk.report(fakePurchase({ transactionId: 'tx-other', sku: 'remove.ads' }));
    expect(counts.resumes).toBe(0);
    sdk.report(fakePurchase({ transactionId: 'tx-1', sku: 'gems.small' }));
    expect(counts.resumes).toBe(1);
    // The release is idempotent: a later event for the product changes nothing.
    sdk.report(fakePurchase({ transactionId: 'tx-2', sku: 'gems.small' }));
    expect(counts).toEqual({ pauses: 1, resumes: 1 });
    await gateway.lifecycle.dispose?.();
  });

  it('releases a launched purchase on a purchase error, the safety timeout, or dispose', async () => {
    vi.useFakeTimers();
    const fake = new FakeApp();
    const { sdk, gateway, counts } = createLaunchedGateway(fake);
    await vi.advanceTimersByTimeAsync(0);
    const commerceV2 = gateway.commerceV2;
    if (commerceV2 === undefined) {
      throw new Error('expected commerceV2');
    }
    commerceV2.subscribe(() => undefined);
    const request = { logicalId: 'gems_small', idempotencyKey: 'op', source: 'shop' } as const;

    await commerceV2.requestPurchase(request);
    expect(counts).toEqual({ pauses: 1, resumes: 0 });
    sdk.emit({ type: 'purchaseError', sku: 'gems.small', error: { code: 'NETWORK' } });
    expect(counts).toEqual({ pauses: 1, resumes: 1 });

    await commerceV2.requestPurchase(request);
    expect(counts).toEqual({ pauses: 2, resumes: 1 });
    await vi.advanceTimersByTimeAsync(launchedPurchaseActivityTimeoutMs - 1);
    expect(counts.resumes).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(counts).toEqual({ pauses: 2, resumes: 2 });

    await commerceV2.requestPurchase(request);
    expect(counts).toEqual({ pauses: 3, resumes: 2 });
    await gateway.lifecycle.dispose?.();
    expect(counts.resumes).toBe(3);
    // Nothing is left listening on the provider once every hold released.
    expect(sdk.listenerCount).toBe(2);
  });

  it('releases a synchronous v2 result when the request returns', async () => {
    const fake = new FakeApp();
    const { sdk, gateway, counts } = createLaunchedGateway(fake);
    await settle();
    sdk.queueRequest({ outcome: 'purchased', purchase: fakePurchase({ transactionId: 'tx-1' }) });
    await gateway.commerceV2?.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(counts).toEqual({ pauses: 1, resumes: 1 });
    await gateway.lifecycle.dispose?.();
  });
});
