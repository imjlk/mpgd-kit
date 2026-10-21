import { afterEach, describe, expect, it } from 'vitest';

import { createUnsupportedCapabilities } from '@mpgd/platform';
import {
  assertStoreProduct,
  assertStorePurchase,
  createUnsupportedCommerceCapabilities,
  isCommerceCapabilities,
} from '@mpgd/platform/commerce';
import { rootRelativeRouteVectors } from '@mpgd/platform/route-vectors';

import {
  browserMockCommerceStoreId,
  browserMockPurchaseEvidenceSchema,
  browserMockRewardEvidenceSchema,
  createBrowserPlatformGateway,
} from './index';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('adapter-browser', () => {
  it('exposes browser capabilities and identity', async () => {
    const gateway = createBrowserPlatformGateway({
      storage: {
        getItem() {
          return null;
        },
        setItem() {},
      },
    });

    const capabilities = await gateway.getCapabilities();
    expect(capabilities).toMatchObject({
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
      cloudSave: true,
      socialShare: false,
      localizedContent: true,
    });
    // The v1 boolean flags are gone; the commerce block is the only source.
    expect(capabilities).not.toHaveProperty('nativeIap');
    expect(capabilities).not.toHaveProperty('subscriptionIap');
    expect(gateway.sharing?.share).toBeUndefined();
    expect(gateway.sharing?.readInboundShare).toBeTypeOf('function');
    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'browser-player',
      displayName: 'Browser Player',
    });
  });

  it('exposes a local guest session and fullscreen launch intent', async () => {
    const gateway = createBrowserPlatformGateway({
      locationHref:
        'https://game.example/play?entry=friend-challenge&puzzleId=daily-1&challengeToken=signed-token',
    });

    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'guest',
      playerId: 'browser-player',
      trustLevel: 'local',
    });
    await expect(gateway.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'friend-challenge',
      puzzleId: 'daily-1',
      referralToken: 'signed-token',
    });
    await expect(
      gateway.presentation?.requestGameSurface({ entry: 'daily', puzzleId: 'daily-1' }),
    ).resolves.toBe('already-fullscreen');
    await expect(gateway.sharing?.readInboundShare?.()).resolves.toEqual({
      puzzleId: 'daily-1',
      challengeToken: 'signed-token',
    });
  });

  it('uses Web Share and falls back to clipboard', async () => {
    const shares: ShareData[] = [];
    const clipboard: string[] = [];
    const shareIntent = {
      kind: 'friend-challenge',
      title: 'Daily challenge',
      text: 'Can you beat me?',
      deepLink: 'https://game.example/?challengeToken=signed-token',
    } as const;
    const shareGateway = createBrowserPlatformGateway({
      async share(data) {
        shares.push(data);
      },
    });
    const clipboardGateway = createBrowserPlatformGateway({
      async writeClipboardText(text) {
        clipboard.push(text);
      },
    });

    await expect(shareGateway.getCapabilities()).resolves.toMatchObject({ socialShare: true });
    await expect(shareGateway.sharing?.share?.(shareIntent)).resolves.toEqual({
      status: 'shared',
    });
    await expect(clipboardGateway.getCapabilities()).resolves.toMatchObject({ socialShare: true });
    await expect(clipboardGateway.sharing?.share?.(shareIntent)).resolves.toEqual({
      status: 'shared',
    });
    expect(shares).toEqual([
      {
        title: 'Daily challenge',
        text: 'Can you beat me?',
        url: 'https://game.example/?challengeToken=signed-token',
      },
    ]);
    expect(clipboard).toEqual([
      'Can you beat me?\nhttps://game.example/?challengeToken=signed-token',
    ]);
  });

  it('shares normalized root-relative routes and refuses links that could name another host', async () => {
    const shares: ShareData[] = [];
    const gateway = createBrowserPlatformGateway({
      async share(data) {
        shares.push(data);
      },
    });
    const intent = { kind: 'invite', title: 'Join', text: 'Join me' } as const;

    for (const deepLink of [
      ...rootRelativeRouteVectors.rejected,
      '\\\\evil.example/daily',
      'javascript:alert(1)',
      'data:text/html,hi',
      'intoss://game/daily',
      'https://game.example/daily\n',
    ]) {
      await expect(gateway.sharing?.share?.({ ...intent, deepLink }), JSON.stringify(deepLink))
        .resolves.toEqual({ status: 'unavailable' });
    }

    expect(shares).toEqual([]);

    for (const [deepLink, route] of rootRelativeRouteVectors.normalized) {
      await expect(gateway.sharing?.share?.({ ...intent, deepLink }), deepLink)
        .resolves.toEqual({ status: 'shared' });
      expect(shares.at(-1)?.url, deepLink).toBe(route);
    }
  });

  it('refuses share links outside the ShareIntent contract', async () => {
    const shares: ShareData[] = [];
    const gateway = createBrowserPlatformGateway({
      locationHref: 'https://game.example/play/index.html?from=menu',
      async share(data) {
        shares.push(data);
      },
    });
    const intent = { kind: 'invite', title: 'Join', text: 'Join me' } as const;

    for (const deepLink of [
      // Page-relative or empty links, which the other targets refuse too.
      '',
      ' /daily',
      './daily',
      'daily?x=1',
      '?challengeToken=x',
      '#top',
      // Absolute links that are not spelled out as HTTP(S), or that could name another host.
      'https:/daily',
      'https:evil.example/x',
      'https://user:pw@game.example/daily',
      'https://game.example//evil.example/x',
      'https://game.example/.//evil.example/x',
      'https://game.example/%2F%2Fevil.example/x',
    ]) {
      await expect(gateway.sharing?.share?.({ ...intent, deepLink }), JSON.stringify(deepLink))
        .resolves.toEqual({ status: 'unavailable' });
    }

    await expect(gateway.sharing?.share?.({ ...intent, text: 1 } as never))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(gateway.sharing?.share?.(null as never))
      .resolves.toEqual({ status: 'unavailable' });
    expect(shares).toEqual([]);

    await expect(gateway.sharing?.share?.({ ...intent, deepLink: 'https://other.example/page' }))
      .resolves.toEqual({ status: 'shared' });
    expect(shares.at(-1)?.url).toBe('https://other.example/page');
  });

  it('ignores malformed nested inbound share data and reports notifications unsupported', async () => {
    const gateway = createBrowserPlatformGateway({
      locationHref: 'https://game.example/?queryParams=%7Binvalid',
    });

    await expect(gateway.sharing?.readInboundShare?.()).resolves.toBeNull();
    await expect(gateway.notifications?.getStatus('daily-ready')).resolves.toBe('unsupported');
    await expect(
      gateway.notifications?.requestSubscription('daily-ready'),
    ).resolves.toBe('unavailable');
  });

  it('does not claim a score was submitted when no native leaderboard is installed', async () => {
    const gateway = createBrowserPlatformGateway();

    expect((await gateway.getCapabilities()).nativeLeaderboard).toBe(false);
    await expect(gateway.leaderboard.submitScore({
      leaderboardId: 'daily',
      score: 10,
      runId: 'run-1',
      submittedAt: '2026-10-21T00:00:00.000Z',
    })).resolves.toEqual({ submitted: false });
  });

  it('fills missing launch keys from nested queryParams and lets direct params win', async () => {
    const gateway = createBrowserPlatformGateway({
      locationHref: `https://game.example/play?puzzleId=direct-puzzle&${nestedQueryParams({
        puzzleId: 'nested-puzzle',
        challengeToken: 'nested-token',
        entry: 'daily',
      })}`,
    });

    await expect(gateway.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'daily',
      puzzleId: 'direct-puzzle',
      referralToken: 'nested-token',
    });
    await expect(gateway.sharing?.readInboundShare?.()).resolves.toEqual({
      puzzleId: 'direct-puzzle',
      challengeToken: 'nested-token',
    });
  });

  it('drops oversized puzzleId and challengeToken values from direct and nested params', async () => {
    const maximum = 'p'.repeat(256);
    const oversized = 't'.repeat(257);
    const direct = createBrowserPlatformGateway({
      locationHref: `https://game.example/play?puzzleId=${maximum}&challengeToken=${oversized}`,
    });

    await expect(direct.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'home',
      puzzleId: maximum,
    });
    await expect(direct.sharing?.readInboundShare?.()).resolves.toEqual({
      puzzleId: maximum,
    });

    const nested = createBrowserPlatformGateway({
      locationHref: `https://game.example/play?${nestedQueryParams({
        puzzleId: oversized,
        challengeToken: maximum,
      })}`,
    });
    await expect(nested.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'friend-challenge',
      referralToken: maximum,
    });
    await expect(nested.sharing?.readInboundShare?.()).resolves.toEqual({
      challengeToken: maximum,
    });
  });

  it('ignores nested queryParams beyond 4096 characters and stops after 32 entries', async () => {
    const token = 'cap-token';
    const skeleton = JSON.stringify({ challengeToken: token, filler: '' });
    const atCap = {
      challengeToken: token,
      filler: 'x'.repeat(4_096 - skeleton.length),
    };
    const overCap = {
      challengeToken: 'over-cap-token',
      filler: 'f'.repeat(4_096),
    };
    expect(JSON.stringify(atCap)).toHaveLength(4_096);
    expect(JSON.stringify(overCap).length).toBeGreaterThan(4_096);

    const capped = createBrowserPlatformGateway({
      locationHref: `https://game.example/play?${nestedQueryParams(atCap)}`,
    });
    await expect(capped.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'friend-challenge',
      referralToken: token,
    });

    const uncapped = createBrowserPlatformGateway({
      locationHref: `https://game.example/play?${nestedQueryParams(overCap)}`,
    });
    await expect(uncapped.presentation?.getLaunchIntent()).resolves.toEqual({ entry: 'home' });
    await expect(uncapped.sharing?.readInboundShare?.()).resolves.toBeNull();

    const padding = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`pad${index}`, 'x']),
    );
    const late = createBrowserPlatformGateway({
      locationHref: `https://game.example/play?${nestedQueryParams({
        ...padding,
        challengeToken: 'late-token',
      })}`,
    });
    await expect(late.presentation?.getLaunchIntent()).resolves.toEqual({ entry: 'home' });

    const early = createBrowserPlatformGateway({
      locationHref: `https://game.example/play?${nestedQueryParams({
        challengeToken: 'early-token',
        ...padding,
      })}`,
    });
    await expect(early.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'friend-challenge',
      referralToken: 'early-token',
    });
  });

  it('rejects launch parameters that contain control characters', async () => {
    const direct = createBrowserPlatformGateway({
      locationHref: 'https://game.example/play?puzzleId=daily-1&challengeToken=bad%00token',
    });
    await expect(direct.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'home',
      puzzleId: 'daily-1',
    });
    await expect(direct.sharing?.readInboundShare?.()).resolves.toEqual({
      puzzleId: 'daily-1',
    });

    const nested = createBrowserPlatformGateway({
      locationHref: `https://game.example/play?${nestedQueryParams({
        puzzleId: 'a\u0001b',
        challengeToken: 'visible-token',
      })}`,
    });
    await expect(nested.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'friend-challenge',
      referralToken: 'visible-token',
    });
    await expect(nested.sharing?.readInboundShare?.()).resolves.toEqual({
      challengeToken: 'visible-token',
    });

    const both = createBrowserPlatformGateway({
      locationHref: 'https://game.example/play'
        + `?puzzleId=${encodeURIComponent('a\u007fb')}`
        + `&challengeToken=${encodeURIComponent('tok\nen')}`,
    });
    await expect(both.sharing?.readInboundShare?.()).resolves.toBeNull();
    await expect(both.presentation?.getLaunchIntent()).resolves.toEqual({ entry: 'home' });
  });

  it('persists save data through localStorage when available', async () => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem(key: string) {
          return storage.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        },
      },
    });

    const gateway = createBrowserPlatformGateway();
    await gateway.storage.save({
      key: 'save:v1',
      value: {
        coins: 25,
      },
    });

    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
      value: {
        coins: 25,
      },
    });
  });

  it('sells nothing by default: no commerce provider and the unsupported block', async () => {
    const gateway = createBrowserPlatformGateway();

    expect(gateway.commerce).toBeUndefined();
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.commerce).toEqual(createUnsupportedCommerceCapabilities());
    expect(capabilities.commerce.availability).toBe('unsupported');
    expect(capabilities.commerce).toEqual(createUnsupportedCapabilities().commerce);
    // A fresh block on every read: mutating one snapshot cannot leak into the next.
    (capabilities.commerce.purchase as { consumable: boolean }).consumable = true;
    expect((await gateway.getCapabilities()).commerce).toEqual(
      createUnsupportedCommerceCapabilities(),
    );
  });

  it('never returns a granted reward by default', async () => {
    const gateway = createBrowserPlatformGateway();

    const reward = await gateway.ads.showRewarded({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'browser-reward',
    });
    expect(reward).toEqual({ status: 'unavailable', rewardGranted: false });
    expect(reward).not.toHaveProperty('ledgerEntryId');
    await expect(
      gateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('never grants under the mockCommerce opt-in either', async () => {
    const gateway = createBrowserPlatformGateway({ mockCommerce: true });

    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeAds: false,
      rewardedAds: true,
      interstitialAds: true,
    });
    const provider = gateway.commerce;
    if (provider === undefined) {
      throw new Error('The mockCommerce opt-in must install a commerce provider.');
    }
    expect(provider.store).toBe(browserMockCommerceStoreId);
    expect(provider.store).toBe('browser-mock');
    expect(provider.finishTransaction).toBeUndefined();
    expect(provider.restorePurchases).toBeUndefined();

    const products = await provider.fetchProducts({});
    expect(products).toHaveLength(1);
    expect(assertStoreProduct(products[0])).toMatchObject({
      logicalId: 'COINS_100',
      store: 'browser-mock',
      storeSku: 'COINS_100',
      kind: 'consumable',
      price: { formatted: '$0.99', currencyCode: 'USD' },
    });
    await expect(provider.fetchProducts({ type: 'subscription' })).resolves.toEqual([]);
    await expect(provider.fetchProducts({ logicalIds: ['REMOVE_ADS'] })).resolves.toEqual([]);

    const result = await provider.requestPurchase({
      logicalId: 'COINS_100',
      source: 'shop',
      idempotencyKey: 'mock-purchase',
    });
    if (result.outcome !== 'purchased') {
      throw new Error(`Expected a purchased mock outcome, got ${result.outcome}.`);
    }
    const purchase = assertStorePurchase(result.purchase);
    expect(purchase).toEqual({
      store: 'browser-mock',
      transactionId: expect.stringMatching(/^browser-purchase-/),
      storeSku: 'COINS_100',
      logicalId: 'COINS_100',
      quantity: 1,
      state: 'purchased',
      token: purchase.transactionId,
      evidence: {
        schema: browserMockPurchaseEvidenceSchema,
        payload: { productId: 'COINS_100' },
      },
    });
    // The mock can never be mistaken for a ledger-settled purchase.
    expect(purchase).not.toHaveProperty('settlement');
    expect(purchase).not.toHaveProperty('accountBinding');
    await expect(provider.getAvailablePurchases()).resolves.toEqual([]);
    expect(provider.subscribe(() => {})).toBeTypeOf('function');

    await expect(provider.requestPurchase({
      logicalId: 'REMOVE_ADS',
      source: 'shop',
      idempotencyKey: 'mock-unknown',
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', retryable: false },
    });
    await expect(provider.requestPurchase({
      logicalId: 'COINS_100',
      source: 'shop',
      idempotencyKey: 'mock-quantity',
      quantity: 2,
    })).resolves.toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });

    await expect(provider.requestPurchase({
      logicalId: 'COINS_100', source: 'shop', idempotencyKey: 'mock-offer', offerId: 'unsupported',
    })).resolves.toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });

    const reward = await gateway.ads.showRewarded({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'mock-reward',
    });
    expect(reward).toEqual({
      status: 'completed',
      rewardGranted: false,
      evidence: {
        schema: browserMockRewardEvidenceSchema,
        payload: { placementId: 'CONTINUE_AFTER_FAIL' },
      },
    });
    expect(reward.rewardGranted).toBe(false);
    expect(reward).not.toHaveProperty('ledgerEntryId');
    await expect(
      gateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('reports the mock provider block as a validated fresh copy per read', async () => {
    const gateway = createBrowserPlatformGateway({ mockCommerce: true });
    const first = await gateway.getCapabilities();
    const second = await gateway.getCapabilities();

    expect(isCommerceCapabilities(first.commerce)).toBe(true);
    expect(first.commerce).toEqual({
      purchase: { consumable: true, durable: false, subscription: false, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: false },
      lifecycle: {
        availablePurchases: false,
        pending: false,
        restore: false,
        events: false,
        finish: 'none',
      },
      authority: { evidence: 'client-token', accountBinding: 'optional' },
      availability: 'available',
    });
    expect(first.commerce).not.toBe(second.commerce);
    expect(first.commerce.purchase).not.toBe(second.commerce.purchase);
    expect(await gateway.commerce?.getCapabilities()).toEqual(first.commerce);
    expect(first).not.toHaveProperty('nativeIap');
    expect(first).not.toHaveProperty('subscriptionIap');
  });

  it('fails closed when browser storage is unavailable', async () => {
    const gateway = createBrowserPlatformGateway();

    await expect(gateway.getCapabilities()).resolves.toMatchObject({ cloudSave: false });
    await expect(gateway.storage.load({ key: 'save:v1' })).rejects.toThrow(
      'Browser storage is unavailable',
    );
    await expect(
      gateway.storage.save({ key: 'save:v1', value: { coins: 25 } }),
    ).rejects.toThrow('Browser storage is unavailable');
  });
});

function nestedQueryParams(value: unknown): string {
  return `queryParams=${encodeURIComponent(JSON.stringify(value))}`;
}
