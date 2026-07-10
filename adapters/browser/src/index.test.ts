import { afterEach, describe, expect, it } from 'vitest';

import { createBrowserPlatformGateway } from './index';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('adapter-browser', () => {
  it('exposes browser capabilities and identity', async () => {
    const gateway = createBrowserPlatformGateway();

    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeAds: false,
      cloudSave: true,
      localizedContent: true,
    });
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
    await expect(gateway.sharing?.readInboundShare()).resolves.toEqual({
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

    await expect(shareGateway.sharing?.share(shareIntent)).resolves.toEqual({
      status: 'shared',
    });
    await expect(clipboardGateway.sharing?.share(shareIntent)).resolves.toEqual({
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

    await expect(gateway.sharing?.readInboundShare()).resolves.toBeNull();
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
});
