import { describe, expect, it, vi } from 'vitest';

import { bridgeStorageLoadProtocol, type BridgeRequest } from '@mpgd/bridge';
import { createUnsupportedCapabilities } from '@mpgd/platform';

import { createCapacitorPlatformGateway } from './index.js';
import {
  createCapacitorProviderRegistry,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';

const commerceMethods = [
  'commerce.getProducts',
  'commerce.purchase',
  'commerce.restore',
  'commerce.getEntitlements',
] as const;

function baseBridge(requests: BridgeRequest[]): NativeBridge {
  return {
    async request(input) {
      requests.push(input);
      const data = input.method === 'runtime.getCapabilities'
        ? createUnsupportedCapabilities()
        : input.method === 'identity.getSession'
          ? { identityLevel: 'guest', trustLevel: 'local' }
          : input.method === 'storage.load'
            ? { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false }
            : null;
      return { id: input.id, ok: true, data };
    },
  };
}

function commerceProvider(
  requests: BridgeRequest[],
  availability: () => Promise<'available' | 'configuration-required' | 'temporarily-unavailable'>,
  purchaseData: unknown = {
    status: 'completed',
    transactionId: 'order-1',
    entitlementIds: [],
    authoritativeGrant: { ledgerEntryId: 'ledger-1' },
  },
): CapacitorServiceProvider {
  return {
    id: 'store-provider',
    features: ['nativeIap'],
    methods: commerceMethods,
    getAvailability: async () => ({ nativeIap: await availability() }),
    bridge: {
      async request(input) {
        requests.push(input);
        const data = input.method === 'commerce.purchase' ? purchaseData : [];
        return { id: input.id, ok: true, data };
      },
    },
  };
}

describe('Capacitor optional provider composition', () => {
  it('keeps storage and guest boot on the base bridge without providers', async () => {
    const baseRequests: BridgeRequest[] = [];
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'base', bridge: baseBridge(baseRequests),
    });
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.nativeIap).toBe(false);
    expect(capabilities.subscriptionIap).toBe(false);
    expect(capabilities.providerAvailability?.nativeIap).toBe('unsupported');
    await expect(gateway.storage.load({ key: 'save' })).resolves.toBeNull();
    await expect(gateway.identity.getSession?.()).resolves.toMatchObject({
      identityLevel: 'guest', trustLevel: 'local',
    });
    expect(baseRequests.map((request) => request.method)).toEqual([
      'runtime.getCapabilities', 'storage.load', 'identity.getSession',
    ]);
  });

  it('routes a ready provider but never delegates base storage to it', async () => {
    const baseRequests: BridgeRequest[] = [];
    const providerRequests: BridgeRequest[] = [];
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '2', buildId: 'native', bridge: baseBridge(baseRequests),
      providers: [commerceProvider(providerRequests, async () => 'available')],
    });
    expect((await gateway.getCapabilities()).nativeIap).toBe(true);
    await expect(gateway.commerce.purchase({
      productId: 'COINS_100', source: 'shop', idempotencyKey: 'op-1',
    })).resolves.toMatchObject({
      status: 'completed', authoritativeGrant: { ledgerEntryId: 'ledger-1' },
    });
    await gateway.storage.load({ key: 'save' });
    expect(providerRequests.map((request) => request.method)).toEqual(['commerce.purchase']);
    expect(providerRequests[0]?.meta).toMatchObject({ target: 'ios', appVersion: '2' });
    expect(baseRequests.map((request) => request.method)).toEqual([
      'runtime.getCapabilities', 'storage.load',
    ]);
  });

  it('checks only the owning provider for a routed operation', async () => {
    let unrelatedReads = 0;
    const unrelated: CapacitorServiceProvider = {
      id: 'unrelated-banner',
      features: ['bannerAds'],
      methods: ['ads.mountBanner', 'ads.unmountBanner'],
      async getAvailability() {
        unrelatedReads += 1;
        return { bannerAds: 'available' };
      },
      bridge: { async request() { throw new Error('not invoked'); } },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1', buildId: 'scoped', bridge: baseBridge([]),
      providers: [commerceProvider([], async () => 'available'), unrelated],
    });
    await gateway.commerce.purchase({
      productId: 'COINS_100', source: 'shop', idempotencyKey: 'scoped-order',
    });
    expect(unrelatedReads).toBe(0);
  });

  it('does not invoke an unconfigured purchase provider', async () => {
    const providerRequests: BridgeRequest[] = [];
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'base', bridge: baseBridge([]),
      providers: [commerceProvider(providerRequests, async () => 'configuration-required')],
    });
    expect((await gateway.getCapabilities()).providerAvailability?.nativeIap).toBe(
      'configuration-required',
    );
    await expect(gateway.commerce.purchase({
      productId: 'COINS_100', source: 'shop', idempotencyKey: 'op-1',
    })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_CONFIGURATION_REQUIRED' });
    expect(providerRequests).toHaveLength(0);
  });

  it('resolves product type before purchasing through a mixed-readiness store', async () => {
    const requests: BridgeRequest[] = [];
    const provider: CapacitorServiceProvider = {
      id: 'mixed-store',
      features: ['nativeIap', 'subscriptionIap'],
      methods: commerceMethods,
      async getAvailability() {
        return { nativeIap: 'available', subscriptionIap: 'configuration-required' };
      },
      bridge: {
        async request(input) {
          requests.push(input);
          const product = (id: string, type: 'consumable' | 'subscription') => ({
            id, type, title: id, description: id,
            price: { formatted: '$1', currencyCode: 'USD' },
          });
          return { id: input.id, ok: true, data: input.method === 'commerce.getProducts'
            ? [product('COINS_100', 'consumable'), product('PASS_MONTHLY', 'subscription')]
            : { status: 'pending', entitlementIds: [] } };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'mixed', bridge: baseBridge([]),
      providers: [provider],
    });
    await expect(gateway.commerce.purchase({
      productId: 'PASS_MONTHLY', source: 'shop', idempotencyKey: 'sub',
    })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_CONFIGURATION_REQUIRED' });
    await expect(gateway.commerce.purchase({
      productId: 'UNKNOWN', source: 'shop', idempotencyKey: 'unknown',
    })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_PRODUCT_UNKNOWN' });
    await expect(gateway.commerce.purchase({
      productId: 'COINS_100', source: 'shop', idempotencyKey: 'coins',
    })).resolves.toMatchObject({ status: 'pending' });
    await expect(gateway.commerce.restore?.()).rejects.toMatchObject({
      code: 'NATIVE_PROVIDER_CONFIGURATION_REQUIRED',
    });
    expect(requests.filter((request) => request.method === 'commerce.purchase')).toHaveLength(1);
  });

  it('keeps subscription, rewarded, and interstitial readiness independent', async () => {
    const adRequests: BridgeRequest[] = [];
    const subscription: CapacitorServiceProvider = {
      ...commerceProvider([], async () => 'available'),
      id: 'subscription-provider',
      features: ['subscriptionIap'],
      async getAvailability() { return { subscriptionIap: 'available' }; },
    };
    const ads: CapacitorServiceProvider = {
      id: 'ads-provider',
      features: ['rewardedAds', 'interstitialAds'],
      methods: ['ads.preload', 'ads.showRewarded', 'ads.showInterstitial'],
      async getAvailability() {
        return { rewardedAds: 'temporarily-unavailable', interstitialAds: 'available' };
      },
      bridge: {
        async request(input) {
          adRequests.push(input);
          return {
            id: input.id, ok: true,
            data: input.method === 'ads.preload' ? undefined : { status: 'shown' },
          };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1', buildId: 'base', bridge: baseBridge([]),
      providers: [subscription, ads],
    });
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.nativeIap).toBe(false);
    expect(capabilities.subscriptionIap).toBe(true);
    expect(capabilities.rewardedAds).toBe(false);
    expect(capabilities.interstitialAds).toBe(true);
    expect(capabilities.bannerAds).toBe(false);
    await expect(gateway.ads.showRewarded({
      placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'ad-1',
    })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_TEMPORARILY_UNAVAILABLE' });
    await expect(gateway.ads.preload({
      placementId: 'CONTINUE_AFTER_FAIL', format: 'rewarded',
    })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_TEMPORARILY_UNAVAILABLE' });
    await expect(gateway.ads.preload({
      placementId: 'STAGE_END_INTERSTITIAL',
    })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_TEMPORARILY_UNAVAILABLE' });
    await expect(gateway.ads.preload({
      placementId: 'STAGE_END_INTERSTITIAL', format: 'interstitial',
    })).resolves.toBeUndefined();
    await expect(gateway.ads.showInterstitial?.({
      placementId: 'STAGE_END_INTERSTITIAL',
    })).resolves.toEqual({ status: 'shown' });
    expect(adRequests.map((request) => request.method)).toEqual([
      'ads.preload', 'ads.showInterstitial',
    ]);
  });

  it('keeps a target-selected remote leaderboard off the native provider', async () => {
    const baseRequests: BridgeRequest[] = [];
    const nativeRequests: BridgeRequest[] = [];
    const native: CapacitorServiceProvider = {
      id: 'native-leaderboard',
      features: ['nativeLeaderboard'],
      methods: ['leaderboard.submitScore', 'leaderboard.open'],
      async getAvailability() { return { nativeLeaderboard: 'available' }; },
      bridge: {
        async request(input) {
          nativeRequests.push(input);
          return { id: input.id, ok: true, data: { submitted: true } };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'routes',
      bridge: {
        async request(input) {
          baseRequests.push(input);
          return { id: input.id, ok: true, data: { submitted: true } };
        },
      },
      providers: [native],
    });
    const score = {
      leaderboardId: 'daily', score: 10, runId: 'run-1', submittedAt: '2026-09-24T00:00:00Z',
    };
    await gateway.leaderboard.submitScore({ ...score, route: 'remote' });
    expect(baseRequests.map((request) => request.method)).toEqual(['leaderboard.submitScore']);
    expect(nativeRequests).toHaveLength(0);
    await gateway.leaderboard.submitScore({ ...score, route: 'native' });
    expect(nativeRequests.map((request) => request.method)).toEqual(['leaderboard.submitScore']);
  });

  it('cannot claim an ad reward without a backend ledger entry', async () => {
    const provider: CapacitorServiceProvider = {
      id: 'rewarded-provider',
      features: ['rewardedAds'],
      methods: ['ads.preload', 'ads.showRewarded'],
      async getAvailability() { return { rewardedAds: 'available' }; },
      bridge: {
        async request(input) {
          return { id: input.id, ok: true, data: {
            status: 'completed', rewardGranted: true,
          } };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'base', bridge: baseBridge([]),
      providers: [provider],
    });
    await expect(gateway.ads.showRewarded({
      placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'ad-1',
    })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_INVALID_RESPONSE' });
  });

  it('routes banner mount and unmount through a ready banner provider', async () => {
    const providerRequests: BridgeRequest[] = [];
    const provider: CapacitorServiceProvider = {
      id: 'banner-provider',
      features: ['bannerAds'],
      methods: ['ads.mountBanner', 'ads.unmountBanner'],
      async getAvailability() { return { bannerAds: 'available' }; },
      bridge: {
        async request(input) {
          providerRequests.push(input);
          return {
            id: input.id, ok: true,
            data: input.method === 'ads.mountBanner' ? { status: 'mounted' } : undefined,
          };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'banner', bridge: baseBridge([]),
      providers: [provider],
    });
    expect((await gateway.getCapabilities()).bannerAds).toBe(true);
    await expect(gateway.ads.mountBanner?.({
      placementId: 'BANNER_HOME', surfaceId: 'home-banner',
    })).resolves.toEqual({ status: 'mounted' });
    await expect(gateway.ads.unmountBanner?.({ surfaceId: 'home-banner' })).resolves.toBeUndefined();
    expect(providerRequests.map((request) => request.method)).toEqual([
      'ads.mountBanner', 'ads.unmountBanner',
    ]);
  });

  it('degrades initialization failures without breaking guest identity', async () => {
    const provider: CapacitorServiceProvider = {
      id: 'identity-provider',
      features: ['identityUpgrade'],
      methods: ['identity.getPlayer', 'identity.getSession', 'identity.requestUpgrade'],
      async getAvailability() { throw new Error('SDK init failed'); },
      bridge: { async request() { throw new Error('must not be invoked'); } },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1', buildId: 'base', bridge: baseBridge([]),
      providers: [provider],
    });
    expect((await gateway.getCapabilities()).providerAvailability?.identityUpgrade).toBe(
      'temporarily-unavailable',
    );
    await expect(gateway.identity.getSession?.()).resolves.toMatchObject({
      identityLevel: 'guest',
    });
    await expect(gateway.identity.requestUpgrade?.({ reason: 'save' })).rejects.toMatchObject({
      code: 'NATIVE_PROVIDER_TEMPORARILY_UNAVAILABLE', retryable: true,
    });
  });

  it('falls back for failed safe provider reads, including invalid optional player data', async () => {
    const baseRequests: BridgeRequest[] = [];
    const provider: CapacitorServiceProvider = {
      id: 'failed-identity',
      features: ['identityUpgrade'],
      methods: ['identity.getPlayer', 'identity.getSession', 'identity.requestUpgrade'],
      async getAvailability() { return { identityUpgrade: 'available' }; },
      bridge: {
        async request(input) {
          if (input.method === 'identity.getPlayer') {
            return { id: input.id, ok: true, data: { playerId: 'p1', displayName: 42 } };
          }
          if (input.method === 'identity.getSession') {
            throw new Error('SDK session read failed');
          }
          return { id: input.id, ok: false,
            error: { code: 'SDK_FAILED', message: 'Upgrade failed', retryable: false } };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1', buildId: 'fallback',
      bridge: baseBridge(baseRequests), providers: [provider],
    });
    await expect(gateway.identity.getPlayer()).resolves.toBeNull();
    await expect(gateway.identity.getSession?.()).resolves.toMatchObject({ identityLevel: 'guest' });
    await expect(gateway.identity.requestUpgrade?.({ reason: 'save' })).rejects.toMatchObject({
      code: 'SDK_FAILED',
    });
    expect(baseRequests.map((request) => request.method)).toEqual([
      'identity.getPlayer', 'identity.getSession',
    ]);
  });

  it('falls back for an errored notification status read without retrying mutations', async () => {
    const baseRequests: BridgeRequest[] = [];
    const provider: CapacitorServiceProvider = {
      id: 'failed-push',
      features: ['pushNotifications'],
      methods: ['notifications.getStatus', 'notifications.requestSubscription'],
      async getAvailability() { return { pushNotifications: 'available' }; },
      bridge: {
        async request(input) {
          return { id: input.id, ok: false,
            error: { code: 'PUSH_FAILED', message: 'Push is offline', retryable: true } };
        },
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1', buildId: 'push-fallback', providers: [provider],
      bridge: {
        async request(input) {
          baseRequests.push(input);
          return { id: input.id, ok: true, data: 'configuration-required' };
        },
      },
    });
    await expect(gateway.notifications?.getStatus('daily-ready')).resolves.toBe(
      'configuration-required',
    );
    await expect(gateway.notifications?.requestSubscription('daily-ready')).rejects.toMatchObject({
      code: 'PUSH_FAILED',
    });
    expect(baseRequests.map((request) => request.method)).toEqual(['notifications.getStatus']);
  });

  it('bounds a stalled identity provider before guest fallback', async () => {
    vi.useFakeTimers();
    try {
      const provider: CapacitorServiceProvider = {
        id: 'stalled-identity',
        features: ['identityUpgrade'],
        methods: ['identity.getPlayer', 'identity.getSession', 'identity.requestUpgrade'],
        async getAvailability() {
          return await new Promise<{ identityUpgrade: 'available' }>(() => {});
        },
        bridge: { async request() { throw new Error('must not be invoked'); } },
      };
      const gateway = createCapacitorPlatformGateway({
        target: 'ios', appVersion: '1', buildId: 'stalled', bridge: baseBridge([]),
        providers: [provider],
      });
      const session = gateway.identity.getSession?.();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(session).resolves.toMatchObject({ identityLevel: 'guest' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: 'unknown purchase state', data: { status: 'granted', entitlementIds: [] } },
    { name: 'missing entitlement list', data: { status: 'completed' } },
    { name: 'malformed authoritative grant', data: {
      status: 'completed', entitlementIds: [], authoritativeGrant: { ledgerEntryId: 42 },
    } },
    { name: 'grant on a pending order', data: {
      status: 'pending', entitlementIds: [], transactionId: 'order-1',
      authoritativeGrant: { ledgerEntryId: 'ledger-1' },
    } },
  ])('rejects $name from an optional provider', async ({ data }) => {
    const gateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1', buildId: 'base', bridge: baseBridge([]),
      providers: [commerceProvider([], async () => 'available', data)],
    });
    await expect(gateway.commerce.purchase({
      productId: 'COINS_100', source: 'shop', idempotencyKey: 'op-1',
    })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_INVALID_RESPONSE' });
  });

  it('rejects duplicate and base-method registrations', () => {
    const provider = commerceProvider([], async () => 'available');
    expect(() => createCapacitorProviderRegistry([provider, provider])).toThrow(/registered twice/);
    expect(() => createCapacitorProviderRegistry([{
      ...provider, id: 'other', methods: ['storage.save'],
    }])).toThrow(/cannot replace base method/);
    expect(() => createCapacitorProviderRegistry([{
      ...provider, methods: ['commerce.purchase'],
    }])).toThrow(/lacks methods/);
  });
});
