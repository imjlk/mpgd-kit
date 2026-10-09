import { describe, expect, it, vi } from 'vitest';
import {
  createOnePlayAdProvider,
  createOnePlayPlatformGateway,
  type OnePlayEnvironment,
  type OnePlaySdk,
} from './oneplay.js';
import type { AdPresentationEvent } from '@mpgd/platform/ads';

function fixture() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const values = new Map<string, string>();
  const info: OnePlayEnvironment = {
    playerId: 'platform-player',
    locale: 'ko-KR',
    ringerSilent: false,
    safeArea: { top: 24, right: 0, bottom: 16, left: 0 },
  };
  const sdk: OnePlaySdk = {
    initializeAsync: vi.fn(async () => info),
    setLoadingProgress: vi.fn(),
    startGameAsync: vi.fn(async () => ({})),
    on(event: string, callback: (event: never) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
    },
    off(event, callback) {
      listeners.get(event)?.delete(callback);
    },
    onBackPressed: vi.fn(),
    ads: {
      isSupported: vi.fn(() => true),
      loadRewarded: vi.fn(),
      loadInterstitial: vi.fn(),
      isReadyAsync: vi.fn(async () => true),
      showRewardedAsync: vi.fn(async () => ({ status: 'rewarded' as const })),
      showInterstitialAsync: vi.fn(async () => ({ status: 'completed' as const })),
    },
  };
  return {
    sdk,
    values,
    info,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
    emit(event: string, payload: unknown = {}) {
      for (const callback of [...listeners.get(event) ?? []]) {
        callback(payload as never);
      }
    },
    listeners,
  };
}
const placementIds = {
  STAGE_END_INTERSTITIAL: { format: 'interstitial', platformId: 'issued-interstitial' },
} as const;
const show = {
  format: 'interstitial',
  placementId: 'STAGE_END_INTERSTITIAL',
  invocationId: 'invocation',
  idempotencyKey: 'request',
} as const;

describe('ONE play H5 adapter', () => {
  it('preserves a newer ringer observation delivered during initialization', async () => {
    const f = fixture();
    f.sdk.initializeAsync = async () => { f.emit('resume', { ringerSilent: true }); return f.info; };
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    expect(gateway.gameSettings?.getAudioMuted()).toBe(true);
  });
  it('initializes before capability detection, exposes platform asserted identity and host settings', async () => {
    const f = fixture();
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage, placementIds });
    expect(f.sdk.initializeAsync).toHaveBeenCalledOnce();
    expect(await gateway.identity.getSession?.()).toEqual({
      playerId: 'platform-player',
      identityLevel: 'platform-anonymous',
      trustLevel: 'platform-asserted',
    });
    expect(gateway.gameSettings?.getLocale?.()).toBe('ko-KR');
    expect(gateway.viewport?.getState().safeAreaInsets).toEqual(f.info.safeArea);
    expect(await gateway.getCapabilities()).toMatchObject({
      interstitialAds: true,
      rewardedAds: false,
      nativeIap: false,
      cloudSave: false,
    });
    expect(await gateway.presentation?.getLaunchIntent()).toEqual({ entry: 'free-play' });
  });
  it('retains an early pause, applies ringer changes independently and never resumes an exited document', async () => {
    const f = fixture();
    f.sdk.initializeAsync = async () => { f.emit('pause', { reason: 'background' }); return f.info; };
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    const paused = vi.fn();
    const resumed = vi.fn();
    const exit = vi.fn();
    const mute = vi.fn();
    gateway.lifecycle.onPause(paused);
    gateway.lifecycle.onResume(resumed);
    gateway.lifecycle.onExit?.(exit);
    gateway.gameSettings?.onAudioMuteChange(mute);
    expect(paused).toHaveBeenCalledOnce();
    f.emit('resume', { ringerSilent: true });
    expect(mute).toHaveBeenLastCalledWith(true);
    expect(gateway.gameSettings?.getAudioMuted()).toBe(true);
    f.emit('exit');
    f.emit('exit');
    f.emit('resume', { ringerSilent: false });
    expect(exit).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledOnce();
    await expect(gateway.gameLoading?.complete()).rejects.toThrow('terminated');
    await gateway.lifecycle.dispose?.();
    expect([...f.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
  it('shares synchronous and async checkpoint keys, isolates platform players, and preserves previous writes on serialization failure', async () => {
    const f = fixture();
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    gateway.storage.saveSync?.({ key: 'run', value: { elapsedMs: 45 } });
    expect(await gateway.storage.load({ key: 'run' })).toEqual({ value: { elapsedMs: 45 } });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => gateway.storage.saveSync?.({ key: 'run', value: cyclic })).toThrow();
    expect(await gateway.storage.load({ key: 'run' })).toEqual({ value: { elapsedMs: 45 } });
    expect([...f.values.keys()]).toEqual(['mpgd:oneplay:platform-player:run']);
  });
  it('awaits a single start acknowledgement and permits retry after rejection', async () => {
    const f = fixture();
    f.sdk.startGameAsync = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({});
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    const start = gateway.gameLoading!.complete();
    expect(gateway.gameLoading!.complete()).toBe(start);
    await expect(start).rejects.toThrow('timeout');
    await gateway.gameLoading!.complete();
    expect(f.sdk.startGameAsync).toHaveBeenCalledTimes(2);
  });
  it('keeps ordinary browser gameplay available while platform monetization is unsupported', async () => {
    const f = fixture();
    f.sdk.initializeAsync = async () => ({ err: 'Platform Not Supported' });
    const gateway = await createOnePlayPlatformGateway({ sdk: f.sdk, storage: f.storage });
    expect(gateway.gameLoading).toBeUndefined();
    expect(await gateway.identity.getSession?.()).toMatchObject({ trustLevel: 'local' });
    expect(await gateway.getCapabilities()).toMatchObject({
      nativeIap: false,
      rewardedAds: false,
      interstitialAds: false,
    });
    expect(await gateway.ads.showInterstitial?.({ placementId: 'STAGE_END_INTERSTITIAL' })).toEqual(
      { status: 'unavailable' },
    );
    expect([...f.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await gateway.lifecycle.dispose?.();
  });
  it('maps terminal outcomes, deduplicates invocations and broadcasts identical ordered events', async () => {
    const f = fixture();
    const provider = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
    const events: AdPresentationEvent[] = [];
    const second: AdPresentationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    provider.subscribe((event) => second.push(event));
    const first = provider.show(show);
    expect(provider.show(show)).toBe(first);
    await expect(first).resolves.toMatchObject({ presentation: 'closed', outcome: 'shown', eligibility: 'not-applicable' });
    expect(events.map(({ type }) => type)).toEqual(['requested', 'closed']);
    expect(events).toEqual(second);
    expect(f.sdk.ads.showInterstitialAsync).toHaveBeenCalledOnce();
    expect(() => provider.show({ ...show, placementId: 'another' })).toThrow('identity changed');
  });
  it.each(['timeout', 'network_error', 'internal_error'])(
    'quarantines %s even after the SDK has synthesized resume and rejects another gateway request',
    async (reason) => {
      const f = fixture();
      f.sdk.ads.showInterstitialAsync = async () => { f.emit('resume'); return { status: 'failed', reason }; };
      const provider = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
      await expect(provider.show(show)).resolves.toMatchObject({ outcome: 'pending', presentation: 'unknown' });
      const another = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
      expect(await another.getAvailability(show)).toEqual({
        state: 'temporarily-unavailable',
        reason: 'busy',
      });
    },
  );
  it('treats no fill as no presentation without any reward and frees its native owner', async () => {
    const f = fixture();
    f.sdk.ads.showInterstitialAsync = async () => ({ status: 'failed', reason: 'no_fill' });
    const provider = createOnePlayAdProvider({ sdk: f.sdk, placementIds });
    expect(await provider.show(show)).toMatchObject({
      outcome: 'unavailable',
      presentation: 'not-started',
      reason: 'no-fill',
    });
    expect(await provider.getAvailability(show)).toEqual({ state: 'available' });
  });
});
