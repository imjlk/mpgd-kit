import { describe, expect, it } from 'vitest';

import type { BridgeRequest } from '@mpgd/bridge';

import { createAitHostBridge, shareIntent, type AitHostDependencies } from './host';

describe('AIT production host bridge', () => {
  it('uses the native anonymous identity and persistent string storage', async () => {
    const values = new Map<string, string>();
    const bridge = createAitHostBridge({
      dependencies: createDependencies({
        identityProvider: async () => ({ type: 'HASH', hash: ' player-1 ' }),
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'identity.getSession', {})).resolves.toEqual({
      identityLevel: 'platform-anonymous',
      playerId: 'player-1',
      trustLevel: 'platform-asserted',
    });
    await request(bridge, 'storage.save', { key: 'save:v1', value: { hints: 3 } });
    expect(values.get('save:v1')).toBe('{"hints":3}');
    await expect(request(bridge, 'storage.load', { key: 'save:v1' })).resolves.toEqual({
      __mpgdBridgeProtocol: 'mpgd.storage.load.v1',
      found: true,
      value: { hints: 3 },
    });

    const firstLoad = await request(bridge, 'storage.load', { key: 'save:v1' }) as {
      value: { hints: number };
    };
    firstLoad.value.hints = -1;
    await expect(request(bridge, 'storage.load', { key: 'save:v1' })).resolves.toMatchObject({
      value: { hints: 3 },
    });
  });

  it('fails closed when the native anonymous identity is invalid', async () => {
    const bridge = createAitHostBridge({
      dependencies: createDependencies({ identityProvider: async () => ({ type: 'HASH' }) }),
    });

    await expect(request(bridge, 'identity.getPlayer', {})).rejects.toThrow(
      'AIT user identity is unavailable.',
    );
    await expect(request(bridge, 'identity.getSession', {})).resolves.toEqual({
      identityLevel: 'guest',
      trustLevel: 'local',
    });
  });

  it('fails closed for commerce and unconfigured ads', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });

    await expect(request(bridge, 'runtime.getCapabilities', {})).resolves.toMatchObject({
      nativeIap: false,
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
    });
    await expect(request(bridge, 'commerce.getProducts', {})).resolves.toEqual([]);
    await expect(request(bridge, 'commerce.purchase', { productId: 'HINT_PACK_5' })).resolves
      .toEqual({ status: 'failed', entitlementIds: [] });
    await expect(request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-1',
    })).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
  });

  it('grants a configured rewarded ad only after userEarnedReward and dismissal', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    const dependencies = createDependencies({
      loadFullScreenAd: Object.assign(
        (callbacks: LoadAdCallbacks) => {
          loadCallbacks = callbacks;
          return () => {};
        },
        { isSupported: () => true },
      ),
      showFullScreenAd: Object.assign(
        (callbacks: ShowAdCallbacks) => {
          showCallbacks = callbacks;
          return () => {};
        },
        { isSupported: () => true },
      ),
    });
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies,
    });

    const preload = request(bridge, 'ads.preload', { placementId: 'SUDOKU_HINT_REWARDED' });
    loadCallbacks?.onEvent({ type: 'loaded' });
    await expect(preload).resolves.toEqual({});

    const reward = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-correlation-1',
    });
    showCallbacks?.onEvent({
      type: 'userEarnedReward',
      data: { unitType: 'hint', unitAmount: 1 },
    });
    showCallbacks?.onEvent({ type: 'dismissed' });

    await expect(reward).resolves.toEqual({
      status: 'completed',
      rewardGranted: true,
      ledgerEntryId: 'reward-correlation-1',
      evidence: {
        schema: 'apps-in-toss.rewarded-ad.callback.v1',
        payload: {
          event: 'user-earned-reward',
          correlationId: 'reward-correlation-1',
          placementId: 'ait-ad-group-1',
        },
      },
    });
  });

  it('does not grant a reward when the ad is dismissed without the reward event', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loadCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
        showFullScreenAd: Object.assign(
          (callbacks: ShowAdCallbacks) => {
            showCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const preload = request(bridge, 'ads.preload', { placementId: 'SUDOKU_HINT_REWARDED' });
    loadCallbacks?.onEvent({ type: 'loaded' });
    await preload;
    const reward = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-correlation-2',
    });
    showCallbacks?.onEvent({ type: 'dismissed' });

    await expect(reward).resolves.toEqual({ status: 'skipped', rewardGranted: false });
  });

  it('delegates supported Game Center score submission and opening', async () => {
    const submittedScores: string[] = [];
    let openCount = 0;
    const bridge = createAitHostBridge({
      dependencies: createDependencies({
        submitGameCenterLeaderBoardScore: async ({ score }) => {
          submittedScores.push(score);
          return { statusCode: 'SUCCESS' };
        },
        openGameCenterLeaderboard: async () => {
          openCount += 1;
        },
      }),
    });

    await expect(request(bridge, 'leaderboard.submitScore', { score: 42 })).resolves.toEqual({
      submitted: true,
    });
    await expect(request(bridge, 'leaderboard.open', {})).resolves.toEqual({});
    expect(submittedScores).toEqual(['42']);
    expect(openCount).toBe(1);
  });
});

describe('AIT sharing', () => {
  it('converts an HTTPS game path to the app-owned intoss deep link', async () => {
    const paths: string[] = [];
    const messages: string[] = [];
    const result = await shareIntent(
      {
        text: "Try today's challenge.",
        deepLink: 'https://game.example/daily?challengeToken=signed-token#result',
        previewImageUrl: 'https://game.example/daily.png',
      },
      {
        appName: 'ttokdoku',
        getTossShareLink: async (path) => {
          paths.push(path);
          return 'https://toss.im/_ul/daily';
        },
        share: async ({ message }) => {
          messages.push(message);
        },
      },
    );

    expect(result).toEqual({ status: 'shared', completion: 'presented' });
    expect(paths).toEqual([
      'intoss://ttokdoku/daily?challengeToken=signed-token#result',
    ]);
    expect(messages).toEqual(["Try today's challenge.\nhttps://toss.im/_ul/daily"]);
  });

  it('rejects unsafe links and preserves native share cancellation', async () => {
    const dependencies = {
      appName: 'ttokdoku',
      getTossShareLink: async () => 'https://toss.im/_ul/daily',
      share: async () => {},
    };

    await expect(shareIntent({ text: 'Unsafe', deepLink: 'javascript:alert(1)' }, dependencies))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(shareIntent(
      { text: 'Cancelled', deepLink: '/daily' },
      {
        ...dependencies,
        share: async () => {
          throw { name: 'AbortError' };
        },
      },
    )).resolves.toEqual({ status: 'cancelled' });
  });
});

type LoadAdCallbacks = Parameters<AitHostDependencies['loadFullScreenAd']>[0];
type ShowAdCallbacks = Parameters<AitHostDependencies['showFullScreenAd']>[0];

function createDependencies(
  overrides: Partial<AitHostDependencies> = {},
): AitHostDependencies {
  const unsupportedAd = Object.assign(() => () => {}, { isSupported: () => false });

  return {
    identityProvider: async () => ({ type: 'HASH', hash: 'test-player' }),
    storage: {
      getItem: async () => null,
      setItem: async () => {},
    },
    getTossShareLink: async () => 'https://toss.im/test',
    share: async () => {},
    isMinVersionSupported: () => true,
    loadFullScreenAd: unsupportedAd,
    showFullScreenAd: unsupportedAd,
    openGameCenterLeaderboard: async () => {},
    submitGameCenterLeaderBoardScore: async () => ({ statusCode: 'SUCCESS' }),
    ...overrides,
  } as AitHostDependencies;
}

async function request(
  bridge: ReturnType<typeof createAitHostBridge>,
  method: BridgeRequest['method'],
  payload: unknown,
): Promise<unknown> {
  const response = await bridge.request({
    id: `${method}:test`,
    method,
    payload,
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'test',
      sentAt: '2026-07-19T00:00:00.000Z',
    },
  } satisfies BridgeRequest);

  if (!response.ok) {
    throw new Error(response.error.message);
  }

  return response.data;
}
