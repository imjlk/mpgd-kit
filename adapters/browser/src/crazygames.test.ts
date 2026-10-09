import { describe, expect, it, vi } from 'vitest';
import {
  createCrazyGamesAdProvider,
  createCrazyGamesPlatformGateway,
  loadCrazyGamesSdk,
  type CrazyGamesAdCallbacks,
  type CrazyGamesSdk,
} from './crazygames.js';
import type { AdPresentationEvent } from '@mpgd/platform/ads';

function fixture(environment: CrazyGamesSdk['environment'] = 'crazygames') {
  let callbacks: CrazyGamesAdCallbacks | undefined;
  const sdk: CrazyGamesSdk = {
    environment,
    init: vi.fn(async () => {}),
    game: {
      loadingStart: vi.fn(),
      loadingStop: vi.fn(),
      gameplayStart: vi.fn(),
      gameplayStop: vi.fn(),
      settings: { muteAudio: false },
      addSettingsChangeListener: vi.fn(),
      removeSettingsChangeListener: vi.fn(),
    },
    ad: {
      requestAd: vi.fn((_type, supplied) => {
        callbacks = supplied;
      }),
    },
  };
  return {
    sdk,
    callbacks: () => {
      if (callbacks === undefined) {
        throw new Error('No native request.');
      }
      return callbacks;
    },
  };
}
const input = {
  format: 'interstitial',
  placementId: 'STAGE_END_INTERSTITIAL',
  invocationId: 'show-1',
  idempotencyKey: 'show-1',
} as const;

describe('CrazyGames interstitial adapter', () => {
  it.each(['error', 'timeout', 'append'] as const)('retries a failed SDK %s without retaining scripts or rejected load promises', async (failure) => {
    vi.useFakeTimers();
    try {
      const view: { CrazyGames?: { SDK: CrazyGamesSdk } } = {};
      const scripts: { src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null; remove: ReturnType<typeof vi.fn> }[] = [];
      const document = {
        defaultView: view,
        createElement() { return { src: '', async: false, onload: null, onerror: null, remove: vi.fn() }; },
        head: { appendChild(script: typeof scripts[number]) { scripts.push(script); if (failure === 'append' && scripts.length === 1) { throw new Error('append failed'); } } },
      } as unknown as Document;
      const first = loadCrazyGamesSdk(document);
      expect(loadCrazyGamesSdk(document)).toBe(first);
      const rejected = expect(first).rejects.toThrow(/could|timed/u);
      if (failure === 'error') { scripts[0]?.onerror?.(); }
      if (failure === 'timeout') { await vi.advanceTimersByTimeAsync(5000); }
      await rejected;
      expect(scripts[0]?.remove).toHaveBeenCalledTimes(1);
      const retry = loadCrazyGamesSdk(document);
      expect(retry).not.toBe(first);
      view.CrazyGames = { SDK: fixture().sdk };
      scripts[1]?.onload?.();
      await expect(retry).resolves.toBe(view.CrazyGames.SDK);
      expect(scripts).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it('reads the environment only after initialization', async () => {
    const f = fixture();
    let initialized = false;
    vi.mocked(f.sdk.init).mockImplementation(async () => { initialized = true; });
    Object.defineProperty(f.sdk, 'environment', { get() {
      if (!initialized) { throw new Error('SDK is not initialized.'); }
      return 'crazygames';
    } });
    const gateway = await createCrazyGamesPlatformGateway({ sdk: f.sdk, launch: 'full' });
    await expect(gateway.getCapabilities()).resolves.toMatchObject({ interstitialAds: true });
  });
  it('initializes once and keeps basic launch, rewards and purchases disabled', async () => {
    const f = fixture();
    const basic = await createCrazyGamesPlatformGateway({ sdk: f.sdk });
    const full = await createCrazyGamesPlatformGateway({ sdk: f.sdk, launch: 'full' });
    expect(f.sdk.init).toHaveBeenCalledTimes(1);
    await expect(basic.ads.provider?.show(input)).resolves.toMatchObject({ outcome: 'unavailable', reason: 'policy-disabled', presentation: 'not-started' });
    await expect(full.ads.showRewarded({ placementId: input.placementId, idempotencyKey: 'reward' })).resolves.toMatchObject({ rewardGranted: false });
    await expect(full.getCapabilities()).resolves.toMatchObject({ interstitialAds: true, rewardedAds: false, nativeIap: false, cloudSave: false });
    await expect(full.presentation?.getLaunchIntent()).resolves.toEqual({ entry: 'free-play' });
    expect(f.sdk.ad.requestAd).not.toHaveBeenCalled();
    full.gameActivity?.setLoading(true);
    full.gameActivity?.setLoading(true);
    full.gameActivity?.setLoading(false);
    full.gameActivity?.setGameplayActive(true);
    full.gameActivity?.setGameplayActive(false);
    expect(f.sdk.game.loadingStart).toHaveBeenCalledTimes(1);
    expect(f.sdk.game.gameplayStart).toHaveBeenCalledTimes(1);
    const muted = vi.fn();
    const unsubscribe = full.gameSettings?.onAudioMuteChange(muted);
    const listener = vi.mocked(f.sdk.game.addSettingsChangeListener).mock.calls[0]?.[0];
    listener?.({ muteAudio: true });
    expect(muted).toHaveBeenCalledWith(true);
    unsubscribe?.();
    expect(f.sdk.game.removeSettingsChangeListener).toHaveBeenCalledWith(listener);
  });

  it.each(['local', 'crazygames'] as const)('maps %s midgame callbacks to one monotonic observation per subscriber', async (environment) => {
    const f = fixture(environment);
    const provider = createCrazyGamesAdProvider({ sdk: f.sdk, launch: 'full', placementIds: [input.placementId] });
    const first: AdPresentationEvent[] = [];
    const second: AdPresentationEvent[] = [];
    provider.subscribe((event) => first.push(event));
    provider.subscribe((event) => second.push(event));
    const result = provider.show(input);
    expect(provider.show(input)).toBe(result);
    expect(f.sdk.ad.requestAd).toHaveBeenCalledTimes(1);
    expect(f.sdk.ad.requestAd).toHaveBeenCalledWith('midgame', expect.any(Object));
    f.callbacks().adStarted();
    f.callbacks().adStarted();
    f.callbacks().adFinished();
    f.callbacks().adStarted();
    await expect(result).resolves.toMatchObject({ outcome: 'shown', presentation: 'closed', eligibility: 'not-applicable' });
    expect(first.map((event) => [event.type, event.sequence])).toEqual([['requested', 1], ['started', 2], ['closed', 3]]);
    expect(first).toEqual(second);
    expect(() => provider.show({ ...input, idempotencyKey: 'changed' })).toThrow('identity changed');
    await expect(provider.show({ ...input, invocationId: 'unknown-placement', placementId: 'UNKNOWN' })).resolves.toMatchObject({ reason: 'configuration-required' });
  });

  it.each(['unfilled', 'adblock', 'adCooldown', 'adsDisabledBasicLaunch'])('releases native ownership after %s before start', async (code) => {
    const f = fixture();
    const provider = createCrazyGamesAdProvider({ sdk: f.sdk, launch: 'full' });
    const result = provider.show(input);
    f.callbacks().adError({ code });
    await expect(result).resolves.toMatchObject({ outcome: 'unavailable', presentation: 'not-started' });
    await expect(provider.getAvailability(input)).resolves.toEqual({ state: 'available' });
  });

  it.each(['other', 'unfilled'])('treats %s adError after start as terminal without releasing a subsequent owner', async (code) => {
    const f = fixture();
    const first = createCrazyGamesAdProvider({ sdk: f.sdk, launch: 'full' });
    const second = createCrazyGamesAdProvider({ sdk: f.sdk, launch: 'full' });
    const events: AdPresentationEvent[] = [];
    first.subscribe((event) => events.push(event));
    const result = first.show(input);
    const callbacks = f.callbacks();
    callbacks.adStarted();
    callbacks.adError({ code });
    await expect(result).resolves.toMatchObject({ outcome: 'failed', presentation: 'closed' });
    await expect(second.getAvailability(input)).resolves.toEqual({ state: 'available' });
    expect(events.at(-1)?.type).toBe('closed');
    const next = second.show({ ...input, invocationId: 'show-2' });
    callbacks.adFinished();
    await expect(second.getAvailability(input)).resolves.toMatchObject({ reason: 'busy' });
    f.callbacks().adFinished();
    await expect(next).resolves.toMatchObject({ presentation: 'closed' });
  });

  it('handles the documented other error before start without waiting for adFinished', async () => {
    const f = fixture();
    const provider = createCrazyGamesAdProvider({ sdk: f.sdk, launch: 'full' });
    const result = provider.show(input);
    f.callbacks().adError({ code: 'other' });
    await expect(result).resolves.toMatchObject({ outcome: 'failed', presentation: 'closed', reason: 'transient-failure' });
    await expect(provider.getAvailability(input)).resolves.toEqual({ state: 'available' });
    expect(provider.presentationAudio).toBe('started');
  });

  it('treats thrown SDK calls as unknown rather than guessing closure', async () => {
    const f = fixture();
    let callback: CrazyGamesAdCallbacks | undefined;
    vi.mocked(f.sdk.ad.requestAd).mockImplementation((_type, supplied) => { callback = supplied; throw new Error('bridge lost'); });
    const provider = createCrazyGamesAdProvider({ sdk: f.sdk, launch: 'full' });
    await expect(provider.show(input)).resolves.toMatchObject({ presentation: 'unknown' });
    await expect(provider.getAvailability(input)).resolves.toMatchObject({ reason: 'busy' });
    callback?.adError({ code: 'other' });
    await expect(provider.getAvailability(input)).resolves.toEqual({ state: 'available' });
  });

  it('keeps blocked and disabled SDKs playable with monetization unavailable', async () => {
    const error = vi.fn();
    const blocked = await createCrazyGamesPlatformGateway({ launch: 'full', loadSdk: async () => { throw new Error('blocked'); }, onError: error });
    const f = fixture('disabled');
    const disabled = await createCrazyGamesPlatformGateway({ sdk: f.sdk, launch: 'full' });
    for (const gateway of [blocked, disabled]) {
      await expect(gateway.getCapabilities()).resolves.toMatchObject({ interstitialAds: false });
      await expect(gateway.presentation?.getLaunchIntent()).resolves.toMatchObject({ entry: 'free-play' });
      expect(gateway.gameActivity).toBeUndefined();
      await expect(gateway.ads.provider?.show(input)).resolves.toMatchObject({ presentation: 'not-started' });
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(f.sdk.ad.requestAd).not.toHaveBeenCalled();
  });
});
