import { RewardAdPluginEvents } from '@capacitor-community/admob';
import type { BridgeRequest } from '@mpgd/bridge';
import { decodeAdMobSsvCustomData } from '@mpgd/game-services/admob-ssv';
import { describe, expect, it, vi } from 'vitest';
import { createGameExecutionController } from '@mpgd/game-runtime';
import { createFullScreenPresentationScope } from '@mpgd/game-runtime/presentation';
import { createCoordinatedAdProvider } from '@mpgd/game-runtime/ads';
import type { AdPresentationEvent } from '@mpgd/platform/ads';

import { createCapacitorAdMobRewardedProvider } from './admob.js';
import { createCapacitorPlatformGateway } from './index.js';
import { createAdMobSdkFixture as createSdk } from '../test/admob-sdk-fixture.js';

const unit = 'ca-app-pub-1234567890123456/1234567890';

function bridgeRequest(method: 'ads.preload' | 'ads.showRewarded', payload: unknown): BridgeRequest {
  return {
    id: 'request-1',
    method,
    payload,
    meta: {
      target: 'android',
      appVersion: '1',
      buildId: 'test',
      sentAt: '2026-09-27T00:00:00Z',
    },
  };
}

async function settleShow(emit: (event: RewardAdPluginEvents) => void): Promise<void> {
  for (let index = 0; index < 64; index += 1) {
    await Promise.resolve();
  }
  emit(RewardAdPluginEvents.Rewarded);
  emit(RewardAdPluginEvents.Dismissed);
}

describe('Capacitor AdMob rewarded provider', () => {
  it('binds late earned promises to their original invocation and ignores unscoped global reward events', async () => {
    const fake = createSdk();
    let firstReward!: (value: { type: string; amount: number }) => void;
    let secondReward!: (value: { type: string; amount: number }) => void;
    fake.show.mockImplementationOnce(() => new Promise((resolve) => { firstReward = resolve; }));
    fake.show.mockImplementationOnce(() => new Promise((resolve) => { secondReward = resolve; }));
    const provider = createCapacitorAdMobRewardedProvider({ sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1' });
    await provider.requestConsent();
    const events: AdPresentationEvent[] = [];
    provider.adProvider.subscribe((event) => { events.push(event); });
    const first = provider.adProvider.show({ placementId: 'CONTINUE', format: 'rewarded', invocationId: 'a', idempotencyKey: 'a' });
    for (let i = 0; i < 64; i += 1) { await Promise.resolve(); }
    fake.emit(RewardAdPluginEvents.Showed);
    fake.emit(RewardAdPluginEvents.Dismissed);
    expect(await first).toMatchObject({ presentation: 'closed', eligibility: 'unknown' });
    const second = provider.adProvider.show({ placementId: 'CONTINUE', format: 'rewarded', invocationId: 'b', idempotencyKey: 'b' });
    for (let i = 0; i < 64; i += 1) { await Promise.resolve(); }
    fake.emit(RewardAdPluginEvents.Showed);
    fake.emit(RewardAdPluginEvents.Rewarded);
    firstReward({ type: 'coin', amount: 1 });
    await Promise.resolve();
    expect(events.filter((event) => event.type === 'reward-earned').map((event) => event.invocationId)).toEqual(['a']);
    secondReward({ type: 'coin', amount: 1 });
    fake.emit(RewardAdPluginEvents.Dismissed);
    expect(await second).toMatchObject({ presentation: 'closed', eligibility: 'eligible' });
  });
  it('exposes the actual provider through the installed gateway and prepares without an unbound SDK load', async () => {
    const fake = createSdk();
    const provider = createCapacitorAdMobRewardedProvider({ sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1' });
    const gateway = createCapacitorPlatformGateway({ target: 'android', appVersion: 'test', buildId: 'test', providers: [provider], visibility: null });
    try {
      expect(gateway.ads.provider).toBe(provider.adProvider);
      expect(await provider.adProvider.getAvailability({ placementId: 'CONTINUE', format: 'rewarded' })).toMatchObject({ reason: 'action-required' });
      await provider.requestConsent();
      expect(await provider.adProvider.preload({ placementId: 'CONTINUE', format: 'rewarded' })).toEqual({ status: 'deferred' });
      expect(await provider.adProvider.show({ placementId: 'CONTINUE', format: 'interstitial', invocationId: 'interstitial', idempotencyKey: 'interstitial' })).toMatchObject({ outcome: 'unavailable', reason: 'unsupported', presentation: 'not-started', eligibility: 'not-applicable' });
      expect(await provider.adProvider.getAvailability({ placementId: 'UNKNOWN', format: 'rewarded' })).toMatchObject({ reason: 'configuration-required' });
      expect(fake.prepare).not.toHaveBeenCalled();
      expect(fake.show).not.toHaveBeenCalled();
    } finally { await gateway.lifecycle.dispose?.(); }
  });
  it('keeps an earned reward pending while native UI remains uncertain and observes late closure', async () => {
    const fake = createSdk();
    const provider = createCapacitorAdMobRewardedProvider({ sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1', showTimeoutMs: 1000 });
    await provider.requestConsent();
    const events: AdPresentationEvent[] = [];
    provider.adProvider.subscribe((event) => { events.push(event); });
    vi.useFakeTimers();
    try {
      const result = provider.bridge.request(bridgeRequest('ads.showRewarded', { placementId: 'CONTINUE', idempotencyKey: 'earned-timeout' }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ data: { status: 'pending', rewardGranted: false } });
      expect(events.some((event) => event.type === 'reward-earned')).toBe(true);
      expect(events.some((event) => event.type === 'closed')).toBe(false);
      expect(fake.listenerCount()).toBeGreaterThan(0);
      fake.emit(RewardAdPluginEvents.Dismissed);
      await vi.advanceTimersByTimeAsync(0);
      expect(events.at(-1)?.type).toBe('closed');
      expect((await provider.getAvailability()).rewardedAds).toBe('available');
      expect(fake.listenerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('preserves SSV journal identity through a common deadline and view disposal', async () => {
    const fake = createSdk();
    fake.show.mockImplementation(() => new Promise(() => {}));
    const provider = createCapacitorAdMobRewardedProvider({ sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1' });
    await provider.requestConsent();
    const execution = createGameExecutionController();
    const presentation = createFullScreenPresentationScope({ execution });
    const background = execution.acquireBlock({ reason: 'background', channels: ['simulation', 'gameplay-input', 'audio'] });
    const ads = createCoordinatedAdProvider({ provider: provider.adProvider, presentation, deadline: { milliseconds: 30, schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } } });
    vi.useFakeTimers();
    try {
      const result = ads.show({ placementId: 'CONTINUE', format: 'rewarded', invocationId: 'native-instance', idempotencyKey: 'original-journal-key' });
      await vi.advanceTimersByTimeAsync(30);
      expect(await result).toMatchObject({ outcome: 'pending', presentation: 'unknown', eligibility: 'unknown', claimEvidence: { schema: 'mpgd.admob.client-reward.v1', payload: { adUnitId: unit } } });
      const options = fake.prepare.mock.calls[0]?.[0] as { ssv: { customData: string } };
      expect(decodeAdMobSsvCustomData(options.ssv.customData)?.idempotencyKey).toBe('original-journal-key');
      ads.dispose();
      fake.emit(RewardAdPluginEvents.Dismissed);
      await vi.advanceTimersByTimeAsync(0);
      expect(presentation.getSnapshot().owner).toBeUndefined();
      expect(execution.getSnapshot().blocks).toEqual([background.info]);
      expect(fake.listenerCount()).toBe(0);
    } finally { background.release(); vi.useRealTimers(); }
  });
  it.each([{ target: 'android', code: 3 }, { target: 'android', code: 9 }, { target: 'ios', code: 1 }] as const)('distinguishes native no-fill from a display deadline without calling show ($target/$code)', async ({ target, code }) => {
    const fake = createSdk();
    fake.prepare.mockImplementation(async () => { fake.emit(RewardAdPluginEvents.FailedToLoad, { code, message: 'No fill' }); throw new Error('no fill'); });
    const provider = createCapacitorAdMobRewardedProvider({ sdk: fake.sdk, target, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1' });
    await provider.requestConsent();
    expect(await provider.adProvider.show({ placementId: 'CONTINUE', format: 'rewarded', invocationId: 'no-fill', idempotencyKey: 'no-fill' })).toMatchObject({ outcome: 'failed', presentation: 'not-started', eligibility: 'not-earned', reason: 'no-fill' });
    expect(fake.show).not.toHaveBeenCalled();
    expect(fake.listenerCount()).toBe(0);
  });
  it('releases a timed-out load quarantine only when that original preparation settles', async () => {
    const fake = createSdk();
    let finish!: (result: { adUnitId: string }) => void;
    fake.prepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const provider = createCapacitorAdMobRewardedProvider({ sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1' });
    await provider.requestConsent();
    vi.useFakeTimers();
    try {
      const result = provider.adProvider.show({ placementId: 'CONTINUE', format: 'rewarded', invocationId: 'load-timeout', idempotencyKey: 'load-timeout' });
      await vi.advanceTimersByTimeAsync(30000);
      expect(await result).toMatchObject({ presentation: 'not-started', outcome: 'failed' });
      expect((await provider.getAvailability()).rewardedAds).toBe('action-required');
      finish({ adUnitId: unit });
      await vi.advanceTimersByTimeAsync(0);
      expect((await provider.getAvailability()).rewardedAds).toBe('available');
      expect(fake.show).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('requires consent and binds a fresh ad load to the backend operation', async () => {
    const fake = createSdk();
    fake.setConsent(true, true);
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    expect((await provider.getAvailability()).rewardedAds).toBe('action-required');
    expect(await provider.requestConsent()).toBe(true);
    expect((await provider.getAvailability()).rewardedAds).toBe('available');

    const preload = await provider.bridge.request(bridgeRequest('ads.preload', {
      placementId: 'CONTINUE', format: 'rewarded',
    }));
    expect(preload.ok).toBe(true);
    expect(await provider.bridge.request(bridgeRequest('ads.preload', {
      placementId: 'CONTINUE',
    }))).toMatchObject({ ok: true });
    expect(fake.prepare).not.toHaveBeenCalled();

    const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'operation-1',
    }));
    await settleShow(fake.emit);
    expect(await result).toMatchObject({
      ok: true, data: { status: 'completed', rewardGranted: false },
    });
    expect(fake.prepare).toHaveBeenCalledOnce();
    const options = fake.prepare.mock.calls[0]?.[0] as {
      adId: string; ssv: { userId: string; customData: string };
    };
    expect(options.adId).toBe(unit);
    expect(options.ssv.userId).toBe('player-1');
    expect(decodeAdMobSsvCustomData(options.ssv.customData)).toEqual({
      playerId: 'player-1', placementId: 'CONTINUE', idempotencyKey: 'operation-1',
    });
    expect(fake.show).toHaveBeenCalledWith({ adId: unit });
    expect(fake.listenerCount()).toBe(0);
  });

  it('does not treat dismissal, denied consent, or missing player identity as a grant', async () => {
    const fake = createSdk();
    fake.setConsent(false, true);
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    expect(await provider.requestConsent()).toBe(false);
    expect((await provider.getAvailability()).rewardedAds).toBe('action-required');
    expect(fake.prepare).not.toHaveBeenCalled();

    fake.setConsent(true);
    await provider.requestConsent();
    fake.show.mockImplementation(() => new Promise(() => {}));
    const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'operation-2',
    }));
    for (let index = 0; index < 64; index += 1) {
      await Promise.resolve();
    }
    fake.emit(RewardAdPluginEvents.Dismissed);
    expect(await result).toMatchObject({
      ok: true, data: { status: 'pending', rewardGranted: false },
    });

    const anonymous = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => '',
    });
    await anonymous.requestConsent();
    expect(await anonymous.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'operation-3',
    }))).toMatchObject({ ok: true, data: { status: 'failed', rewardGranted: false } });
    expect(fake.prepare).toHaveBeenCalledTimes(1);
  });

  it('rejects overlapping shows and leaves only one bound operation in flight', async () => {
    const fake = createSdk();
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    await provider.requestConsent();
    const first = provider.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'first',
    }));
    expect((await provider.getAvailability()).rewardedAds).toBe('temporarily-unavailable');
    expect(await provider.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'second',
    }))).toMatchObject({ ok: true, data: { status: 'unavailable' } });
    await settleShow(fake.emit);
    await first;
    expect(fake.prepare).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(0);
  });

  it('rejects invalid placements and keeps test-mode SSV explicitly non-authoritative', async () => {
    const fake = createSdk();
    expect(() => createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: 'not-an-ad-unit' }, getPlayerId: () => 'player-1',
    })).toThrow();
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
      isTesting: true,
    });
    await provider.requestConsent();
    const demoUnit = 'ca-app-pub-3940256099942544/5224354917';
    fake.prepare.mockResolvedValueOnce({ adUnitId: demoUnit });
    expect(await provider.bridge.request(bridgeRequest('ads.preload', {
      placementId: 'UNKNOWN', format: 'rewarded',
    }))).toMatchObject({ ok: false, error: { code: 'ADMOB_PLACEMENT_INVALID' } });
    const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'test',
    }));
    await settleShow(fake.emit);
    await result;
    expect(fake.prepare.mock.calls[0]?.[0]).toMatchObject({ isTesting: true });
    expect(fake.show).toHaveBeenCalledWith({ adId: demoUnit });
  });

  it('does not accept a malformed native reward item as earned', async () => {
    const fake = createSdk();
    fake.show.mockResolvedValueOnce({ type: '', amount: 0 });
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    await provider.requestConsent();
    const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'invalid-item',
    }));
    for (let index = 0; index < 64; index += 1) {
      await Promise.resolve();
    }
    fake.emit(RewardAdPluginEvents.Rewarded, { type: '', amount: 0 });
    fake.emit(RewardAdPluginEvents.Dismissed);
    expect(await result).toMatchObject({
      ok: true, data: { status: 'pending', rewardGranted: false },
    });
  });

  it('keeps an unconfirmed dismissal pending for later SSV reconciliation', async () => {
    const fake = createSdk();
    fake.show.mockImplementation(() => new Promise(() => {}));
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    await provider.requestConsent();
    const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'late-reward',
    }));
    for (let index = 0; index < 64; index += 1) {
      await Promise.resolve();
    }
    fake.emit(RewardAdPluginEvents.Dismissed);
    expect(await result).toMatchObject({
      ok: true, data: { status: 'pending', rewardGranted: false,
        evidence: { schema: 'mpgd.admob.client-reward.v1' } },
    });
  });

  it('opens privacy options only when UMP requires them and restores consent after errors', async () => {
    const fake = createSdk();
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    await provider.requestConsent();
    await provider.showPrivacyOptions();
    expect(fake.sdk.showPrivacyOptionsForm).not.toHaveBeenCalled();
    fake.setPrivacyRequired(true);
    await provider.requestConsent();
    vi.mocked(fake.sdk.showPrivacyOptionsForm).mockRejectedValueOnce(new Error('native form failed'));
    await expect(provider.showPrivacyOptions()).rejects.toThrow('native form failed');
    expect((await provider.getAvailability()).rewardedAds).toBe('available');
  });

  it('bounds player identity lookup before touching the native SDK', async () => {
    const fake = createSdk();
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit },
      getPlayerId: () => new Promise<string>(() => {}),
    });
    await provider.requestConsent();
    vi.useFakeTimers();
    try {
      const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
        placementId: 'CONTINUE', idempotencyKey: 'stuck-identity',
      }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toMatchObject({
        ok: true, data: { status: 'failed', rewardGranted: false },
      });
      expect(fake.prepare).not.toHaveBeenCalled();
      expect((await provider.getAvailability()).rewardedAds).toBe('available');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects SSV fields that the receiver cannot accept before loading an ad', async () => {
    const fake = createSdk();
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    await provider.requestConsent();
    expect(await provider.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'x'.repeat(257),
    }))).toMatchObject({ ok: true, data: { status: 'failed' } });
    const badPlayer = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'x'.repeat(257),
    });
    await badPlayer.requestConsent();
    expect(await badPlayer.bridge.request(bridgeRequest('ads.showRewarded', {
      placementId: 'CONTINUE', idempotencyKey: 'valid',
    }))).toMatchObject({ ok: true, data: { status: 'failed' } });
    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it('bounds listener cleanup and quarantines an uncertain native SDK', async () => {
    const fake = createSdk();
    fake.setRemoveStuck(true);
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    await provider.requestConsent();
    vi.useFakeTimers();
    try {
      const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
        placementId: 'CONTINUE', idempotencyKey: 'cleanup-stuck',
      }));
      await settleShow(fake.emit);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toMatchObject({ ok: true, data: { status: 'completed' } });
      expect((await provider.getAvailability()).rewardedAds).toBe('action-required');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an unobserved native presentation pending and blocks another show', async () => {
    const fake = createSdk();
    fake.show.mockImplementation(() => new Promise(() => {}));
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
      showTimeoutMs: 1_000,
    });
    await provider.requestConsent();
    vi.useFakeTimers();
    try {
      const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
        placementId: 'CONTINUE', idempotencyKey: 'timed-out',
      }));
      for (let index = 0; index < 64; index += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toMatchObject({
        ok: true, data: { status: 'pending', rewardGranted: false },
      });
      expect((await provider.getAvailability()).rewardedAds).toBe('action-required');
      expect(fake.listenerCount()).toBeGreaterThan(0);
      const recreated = createCapacitorAdMobRewardedProvider({
        sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
      });
      await recreated.requestConsent();
      expect((await recreated.getAvailability()).rewardedAds).toBe('action-required');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a stuck native load without opening an unbound ad later', async () => {
    const fake = createSdk();
    fake.prepare.mockImplementation(() => new Promise(() => {}));
    const provider = createCapacitorAdMobRewardedProvider({
      sdk: fake.sdk, adUnits: { CONTINUE: unit }, getPlayerId: () => 'player-1',
    });
    await provider.requestConsent();
    vi.useFakeTimers();
    try {
      const result = provider.bridge.request(bridgeRequest('ads.showRewarded', {
        placementId: 'CONTINUE', idempotencyKey: 'stuck-load',
      }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({
        ok: true, data: { status: 'failed', rewardGranted: false },
      });
      expect(fake.show).not.toHaveBeenCalled();
      expect((await provider.getAvailability()).rewardedAds).toBe('action-required');
      expect(fake.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
