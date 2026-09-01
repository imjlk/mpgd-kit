import { describe, expect, it } from 'vitest';

import { PlatformOperationError } from '@mpgd/platform';

import {
  createWechatPlatformGateway,
  createWechatStorageAdapter,
  type WechatMiniGameApi,
} from '../src/index.js';
import { createFakeWechatMiniGameApi } from './fake-api.js';

describe('WeChat platform gateway', () => {
  it('validates directly injected APIs before exposing gateway operations', () => {
    expect(() => createWechatPlatformGateway({ api: {} as WechatMiniGameApi }))
      .toThrowError(expect.objectContaining({
        code: 'WECHAT_API_METHOD_UNAVAILABLE',
        retryable: false,
      }));
  });

  it('serializes native storage without overwriting on invalid values or quota failures', async () => {
    const fake = createFakeWechatMiniGameApi();
    const storage = createWechatStorageAdapter(fake.api);

    await storage.save({ key: 'save', value: { level: 2 } });
    expect(fake.storage.get('mpgd:save')).toBe('{"schemaVersion":1,"value":{"level":2}}');
    await expect(storage.load({ key: 'save' })).resolves.toEqual({ value: { level: 2 } });
    await expect(storage.load({ key: 'missing' })).resolves.toBeNull();

    await expect(storage.save({ key: 'undefined', value: undefined })).rejects.toMatchObject({
      code: 'WECHAT_STORAGE_VALUE_NOT_SERIALIZABLE',
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(storage.save({ key: 'cyclic', value: cyclic })).rejects.toMatchObject({
      code: 'WECHAT_STORAGE_VALUE_NOT_SERIALIZABLE',
    });

    const quota = createFakeWechatMiniGameApi({
      setStorageSync() {
        throw new Error('quota');
      },
    });
    await expect(createWechatStorageAdapter(quota.api).save({ key: 'save', value: 1 }))
      .rejects.toMatchObject({ code: 'WECHAT_STORAGE_SAVE_FAILED' });
    expect(quota.storage.size).toBe(0);
  });

  it('subscribes and unsubscribes lifecycle callbacks exactly once', () => {
    const fake = createFakeWechatMiniGameApi();
    const gateway = createWechatPlatformGateway({ api: fake.api });
    const calls: string[] = [];
    const disposePause = gateway.lifecycle.onPause(() => calls.push('pause'));
    const disposeResume = gateway.lifecycle.onResume(() => calls.push('resume'));

    for (const listener of fake.lifecycleListeners.hide) {
      listener();
    }
    for (const listener of fake.lifecycleListeners.show) {
      listener();
    }
    disposePause();
    disposePause();
    disposeResume();

    expect(calls).toEqual(['pause', 'resume']);
    expect(fake.lifecycleListeners.hide.size).toBe(0);
    expect(fake.lifecycleListeners.show.size).toBe(0);
  });

  it('normalizes sharing to presented and never invents authenticated identity or grants', async () => {
    const fake = createFakeWechatMiniGameApi();
    const gateway = createWechatPlatformGateway({ api: fake.api });
    Object.defineProperty(fake.api, 'shareAppMessage', {
      configurable: true,
      value: undefined,
    });

    await expect(gateway.sharing?.share?.({
      kind: 'friend-challenge',
      title: 'Challenge',
      text: 'Join me',
      deepLink: 'https://example.test/challenge',
      payload: { puzzleId: 'daily/1', challengeToken: 'token value' },
      previewImageUrl: 'assets/share.png',
    })).resolves.toEqual({ status: 'shared', completion: 'presented' });
    expect(fake.shareCalls).toEqual([{
      title: 'Challenge',
      query: 'kind=friend-challenge&puzzleId=daily%2F1&challengeToken=token%20value',
      imageUrl: 'assets/share.png',
    }]);
    await expect(gateway.identity.getPlayer()).resolves.toBeNull();
    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'guest',
      trustLevel: 'local',
    });
    await expect(gateway.commerce.purchase({
      productId: 'COINS_100',
      source: 'shop',
      idempotencyKey: 'purchase-1',
    })).resolves.toEqual({ status: 'failed', entitlementIds: [] });
    await expect(gateway.ads.showRewarded({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'ad-1',
    })).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
    await expect(gateway.ads.preload({ placementId: 'CONTINUE_AFTER_FAIL' }))
      .rejects.toBeInstanceOf(PlatformOperationError);
    await expect(gateway.leaderboard.submitScore({
      leaderboardId: 'weekly',
      score: 1,
      runId: 'run-1',
      submittedAt: '2026-09-01T00:00:00Z',
    })).resolves.toEqual({ submitted: false });
  });

  it('keeps capabilities aligned with actually exposed optional methods', async () => {
    const withShare = createFakeWechatMiniGameApi();
    const withoutShare = createFakeWechatMiniGameApi({}, false);
    const shareGateway = createWechatPlatformGateway({ api: withShare.api });
    const noShareGateway = createWechatPlatformGateway({ api: withoutShare.api });

    await expect(shareGateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: false,
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
      nativeLeaderboard: false,
      socialShare: true,
      localizedContent: true,
    });
    await expect(noShareGateway.getCapabilities()).resolves.toMatchObject({ socialShare: false });
    expect(noShareGateway.sharing).toBeUndefined();
  });
});
