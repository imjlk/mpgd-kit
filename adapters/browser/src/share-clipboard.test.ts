import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleAdapter } from '@mpgd/platform';

import { createBrowserPlatformGateway } from './index';

const lifecycle: LifecycleAdapter = {
  onPause: () => () => {},
  onResume: () => () => {},
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser share clipboard fallback', () => {
  it('copies a root-relative link resolved against the document base and keeps Web Share relative', async () => {
    vi.stubGlobal('document', { baseURI: 'https://game.example/play/index.html' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shares: ShareData[] = [];
    const clipboard: string[] = [];
    const shareIntent = {
      kind: 'friend-challenge',
      title: 'Daily challenge',
      text: 'Can you beat me?',
      deepLink: '/levels/../daily?challengeToken=signed-token',
    } as const;
    const shareGateway = createBrowserPlatformGateway({
      lifecycle,
      async share(data) {
        shares.push(data);
      },
    });
    const fallbackGateway = createBrowserPlatformGateway({
      lifecycle,
      async share() {
        throw new Error('Web Share failed');
      },
      async writeClipboardText(text) {
        clipboard.push(text);
      },
    });

    await expect(shareGateway.sharing?.share?.(shareIntent)).resolves.toEqual({ status: 'shared' });
    await expect(fallbackGateway.sharing?.share?.(shareIntent))
      .resolves.toEqual({ status: 'shared' });

    // Web Share resolves the route against the document itself.
    expect(shares.map((data) => data.url)).toEqual(['/daily?challengeToken=signed-token']);
    expect(clipboard).toEqual([
      'Can you beat me?\nhttps://game.example/daily?challengeToken=signed-token',
    ]);
  });

  it('copies a root-relative link only with an HTTP(S) page to resolve it against', async () => {
    const clipboard: string[] = [];
    const intent = { kind: 'invite', title: 'Join', text: 'Join me', deepLink: '/daily' } as const;
    const writeClipboardText = async (text: string) => {
      clipboard.push(text);
    };

    await expect(createBrowserPlatformGateway({
      locationHref: 'https://game.example/play/',
      writeClipboardText,
    }).sharing?.share?.(intent)).resolves.toEqual({ status: 'shared' });
    expect(clipboard).toEqual(['Join me\nhttps://game.example/daily']);

    for (const locationHref of [undefined, 'file:///game/index.html', 'about:blank']) {
      await expect(createBrowserPlatformGateway({
        ...(locationHref === undefined ? {} : { locationHref }),
        writeClipboardText,
      }).sharing?.share?.(intent), String(locationHref)).resolves.toEqual({ status: 'unavailable' });
    }

    expect(clipboard).toHaveLength(1);
  });

  it('falls back to the page URL it was given when the document base is not a web page', async () => {
    vi.stubGlobal('document', { baseURI: 'capacitor://localhost/' });
    const clipboard: string[] = [];

    await expect(createBrowserPlatformGateway({
      lifecycle,
      locationHref: 'https://game.example/play/',
      async writeClipboardText(text) {
        clipboard.push(text);
      },
    }).sharing?.share?.({ kind: 'invite', title: 'Join', text: 'Join me', deepLink: '/daily' }))
      .resolves.toEqual({ status: 'shared' });
    expect(clipboard).toEqual(['Join me\nhttps://game.example/daily']);
  });
});
