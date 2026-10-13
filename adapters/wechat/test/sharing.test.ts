import { afterEach, describe, expect, it, vi } from 'vitest';

import { rootRelativeRouteVectors, shareLinkVectors } from '@mpgd/platform/route-vectors';

import { createWechatPlatformGateway } from '../src/index.js';
import { createFakeWechatMiniGameApi } from './fake-api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WeChat sharing', () => {
  it('hands the host no link, so a share link outside the contract never reaches it', async () => {
    // `wx.shareAppMessage` shares a card that reopens the game with `query`,
    // and mini-game runtimes have no URL global: the adapter drops `deepLink`
    // instead of running the share-link rule, so it shares without one.
    vi.stubGlobal('URL', undefined);
    const fake = createFakeWechatMiniGameApi();
    const gateway = createWechatPlatformGateway({ api: fake.api });
    const deepLinks = [...rootRelativeRouteVectors.rejected, ...shareLinkVectors.rejected];

    for (const deepLink of deepLinks) {
      await expect(gateway.sharing?.share?.({
        kind: 'invite',
        title: 'Join',
        text: 'Join me',
        deepLink,
      }), JSON.stringify(deepLink)).resolves.toEqual({ status: 'shared', completion: 'presented' });
    }

    expect(fake.shareCalls).toHaveLength(deepLinks.length);
    expect(new Set(fake.shareCalls.map((options) => JSON.stringify(options))))
      .toEqual(new Set([JSON.stringify({ title: 'Join', query: 'kind=invite' })]));
  });
});
