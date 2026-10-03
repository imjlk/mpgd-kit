import { afterEach, describe, expect, it } from 'vitest';

import { createBrowserPlatformGateway } from './index';

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

    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: false,
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
      cloudSave: true,
      socialShare: false,
      localizedContent: true,
    });
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

  it('never returns a completed purchase or a granted reward by default', async () => {
    const gateway = createBrowserPlatformGateway();

    await expect(gateway.commerce.getProducts()).resolves.toEqual([]);
    const purchase = await gateway.commerce.purchase({
      productId: 'COINS_100',
      source: 'shop',
      idempotencyKey: 'browser-purchase',
    });
    expect(purchase).toEqual({ status: 'failed', entitlementIds: [] });
    expect(purchase).not.toHaveProperty('transactionId');
    expect(purchase).not.toHaveProperty('authoritativeGrant');

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

  it('only fabricates purchases and rewards when mockCommerce is opted in', async () => {
    const gateway = createBrowserPlatformGateway({ mockCommerce: true });

    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      rewardedAds: true,
      interstitialAds: true,
    });
    await expect(gateway.commerce.getProducts()).resolves.toMatchObject([{ id: 'COINS_100' }]);
    await expect(
      gateway.commerce.purchase({
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'mock-purchase',
      }),
    ).resolves.toMatchObject({ status: 'completed', entitlementIds: ['COINS_100'] });
    await expect(
      gateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'mock-reward',
      }),
    ).resolves.toMatchObject({ status: 'completed', rewardGranted: true });
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
