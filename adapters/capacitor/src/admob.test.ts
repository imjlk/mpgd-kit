import { AdmobConsentStatus, RewardAdPluginEvents } from '@capacitor-community/admob';
import type { BridgeRequest } from '@mpgd/bridge';
import { decodeAdMobSsvCustomData } from '@mpgd/game-services/admob-ssv';
import { describe, expect, it, vi } from 'vitest';

import { createCapacitorAdMobRewardedProvider, type RewardedAdMobSdk } from './admob.js';

const unit = 'ca-app-pub-1234567890123456/1234567890';

function createSdk() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  let canRequestAds = true;
  let required = false;
  let privacyRequired = false;
  let removeStuck = false;
  const emit = (event: RewardAdPluginEvents, payload?: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (value?: unknown) => void)(payload ?? { type: 'coin', amount: 1 });
    }
  };
  const prepare = vi.fn(async (_options: unknown) => ({ adUnitId: unit }));
  const show = vi.fn(async (_options: unknown) => ({ type: 'coin', amount: 1 }));
  const sdk = {
    initialize: vi.fn(async () => undefined),
    requestConsentInfo: vi.fn(async () => ({
      status: required ? AdmobConsentStatus.REQUIRED : AdmobConsentStatus.NOT_REQUIRED,
      isConsentFormAvailable: required,
      canRequestAds: !required && canRequestAds,
      privacyOptionsRequirementStatus: privacyRequired ? 'REQUIRED' : 'NOT_REQUIRED',
    })),
    showConsentForm: vi.fn(async () => ({
      status: canRequestAds ? AdmobConsentStatus.OBTAINED : AdmobConsentStatus.REQUIRED,
      canRequestAds,
      privacyOptionsRequirementStatus: privacyRequired ? 'REQUIRED' : 'NOT_REQUIRED',
    })),
    showPrivacyOptionsForm: vi.fn(async () => undefined),
    prepareRewardVideoAd: prepare,
    showRewardVideoAd: show,
    addListener: vi.fn(async (
      event: string,
      listener: (...args: never[]) => void,
    ) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(listener);
      listeners.set(event, callbacks);
      return { remove: async () => {
        if (removeStuck) {
          await new Promise<void>(() => {});
        }
        callbacks.delete(listener);
      } };
    }),
  };
  return {
    sdk: sdk as unknown as RewardedAdMobSdk,
    prepare,
    show,
    emit,
    setConsent(value: boolean, consentRequired = false) {
      canRequestAds = value;
      required = consentRequired;
    },
    setPrivacyRequired(value: boolean) {
      privacyRequired = value;
    },
    setRemoveStuck(value: boolean) {
      removeStuck = value;
    },
    listenerCount() {
      return [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0);
    },
  };
}

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
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
  emit(RewardAdPluginEvents.Rewarded);
  emit(RewardAdPluginEvents.Dismissed);
}

describe('Capacitor AdMob rewarded provider', () => {
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
    for (let index = 0; index < 10; index += 1) {
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
    for (let index = 0; index < 10; index += 1) {
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
    for (let index = 0; index < 10; index += 1) {
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
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toMatchObject({
        ok: true, data: { status: 'pending', rewardGranted: false },
      });
      expect((await provider.getAvailability()).rewardedAds).toBe('action-required');
      expect(fake.listenerCount()).toBe(0);
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
        ok: true, data: { status: 'pending', rewardGranted: false },
      });
      expect(fake.show).not.toHaveBeenCalled();
      expect((await provider.getAvailability()).rewardedAds).toBe('action-required');
      expect(fake.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
