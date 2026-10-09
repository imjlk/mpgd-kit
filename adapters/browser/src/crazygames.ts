import {
  createUnsupportedCapabilities,
  type GameActivityAdapter,
  type LifecycleAdapter,
  type PlatformGateway,
} from '@mpgd/platform';
import {
  adProtocol,
  adProtocolVersion,
  assertAdShowInput,
  toAdAdapter,
  type AdAvailability,
  type AdPlacementInput,
  type AdPresentationEvent,
  type AdProvider,
  type AdReason,
  type AdShowInput,
  type AdShowResult,
} from '@mpgd/platform/ads';
import { createBrowserPlatformGateway, type BrowserPlatformGatewayOptions } from './index.js';

export const crazyGamesSdkUrl = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
export type CrazyGamesLaunch = 'basic' | 'full';
export interface CrazyGamesAdCallbacks {
  adStarted(): void;
  adFinished(): void;
  adError(error: unknown): void;
}
/** The officially documented HTML5 v3 surface; injected ports make SDK tests deterministic. */
export interface CrazyGamesSdk {
  init(): Promise<void>;
  readonly environment: 'local' | 'crazygames' | 'disabled';
  readonly ad: { requestAd(type: 'midgame' | 'rewarded', callbacks: CrazyGamesAdCallbacks): void | Promise<void> };
  readonly game: {
    loadingStart(): void; loadingStop(): void; gameplayStart(): void; gameplayStop(): void;
    readonly settings: { readonly muteAudio: boolean };
    addSettingsChangeListener(listener: (settings: { readonly muteAudio: boolean }) => void): void;
    removeSettingsChangeListener(listener: (settings: { readonly muteAudio: boolean }) => void): void;
  };
}
export interface CrazyGamesGatewayOptions {
  readonly sdk?: CrazyGamesSdk;
  readonly loadSdk?: () => Promise<CrazyGamesSdk>;
  readonly launch?: CrazyGamesLaunch;
  readonly document?: Document;
  readonly storage?: BrowserPlatformGatewayOptions['storage'];
  readonly placementIds?: readonly string[];
  readonly onError?: (error: unknown) => void;
}
const sdkLoads = new WeakMap<Document, Promise<CrazyGamesSdk>>();
const sdkInitialization = new WeakMap<CrazyGamesSdk, Promise<void>>();
const nativeOwners = new WeakMap<CrazyGamesSdk['ad'], object>();

/** Load only the platform-owned SDK. Game code and assets remain bundled and relative. */
export function loadCrazyGamesSdk(document: Document = globalThis.document): Promise<CrazyGamesSdk> {
  const read = () => {
    const view = document.defaultView as (Window & { CrazyGames?: { SDK?: CrazyGamesSdk } }) | null;
    return view?.CrazyGames?.SDK;
  };
  const existing = read();
  if (existing !== undefined) {
    return Promise.resolve(existing);
  }
  const loading = sdkLoads.get(document);
  if (loading !== undefined) {
    return loading;
  }
  const promise = new Promise<CrazyGamesSdk>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = crazyGamesSdkUrl;
    script.async = true;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      const sdk = read();
      if (error !== undefined || sdk === undefined) {
        reject(error ?? new Error('CrazyGames SDK did not expose its v3 API.'));
      } else {
        resolve(sdk);
      }
    };
    const timer = setTimeout(() => finish(new Error('CrazyGames SDK load timed out.')), 5000);
    script.onload = () => finish();
    script.onerror = () => finish(new Error('CrazyGames SDK could not be loaded.'));
    try {
      document.head.appendChild(script);
    } catch {
      finish(new Error('CrazyGames SDK script could not be installed.'));
    }
  });
  sdkLoads.set(document, promise);
  return promise;
}

export async function createCrazyGamesPlatformGateway(options: CrazyGamesGatewayOptions = {}): Promise<PlatformGateway> {
  const launch = options.launch ?? 'basic';
  if (launch !== 'basic' && launch !== 'full') {
    throw new TypeError('CrazyGames launch must be basic or full.');
  }
  let sdk: CrazyGamesSdk | undefined;
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch { /* Diagnostics cannot stop gameplay. */ }
  };
  try {
    sdk = options.sdk ?? await (options.loadSdk ?? (() => loadCrazyGamesSdk(options.document)))();
    let initializing = sdkInitialization.get(sdk);
    if (initializing === undefined) {
      const candidate = sdk;
      initializing = Promise.resolve().then(() => candidate.init());
      sdkInitialization.set(sdk, initializing);
    }
    await waitForInitialization(initializing);
    if (!['local', 'crazygames', 'disabled'].includes(sdk.environment)) {
      throw new TypeError('Unknown CrazyGames SDK environment.');
    }
  } catch (error) {
    sdk = undefined;
    report(error);
  }
  const enabled = sdk !== undefined && sdk.environment !== 'disabled';
  const base = createBrowserPlatformGateway({
    lifecycle: visibilityLifecycle(options.document ?? globalThis.document),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  });
  const provider = createCrazyGamesAdProvider({
    sdk,
    launch,
    placementIds: options.placementIds,
    onError: report,
  });
  let loading: boolean | undefined;
  let active = false;
  const readySdk = sdk;
  const gameActivity: GameActivityAdapter | undefined = enabled && readySdk !== undefined ? {
    handlesFocusChanges: true,
    setLoading(next) {
      if (next === loading) { return; }
      // Commit only after the SDK call succeeds, so a later observation can retry.
      if (next) { readySdk.game.loadingStart(); } else { readySdk.game.loadingStop(); }
      loading = next;
    },
    setGameplayActive(next) {
      if (next === active) { return; }
      if (next) { readySdk.game.gameplayStart(); } else { readySdk.game.gameplayStop(); }
      active = next;
    },
  } : undefined;
  return {
    ...base, target: 'crazygames', ads: toAdAdapter(provider),
    ...(gameActivity === undefined ? {} : { gameActivity }),
    ...(enabled && readySdk !== undefined ? { gameSettings: {
      getAudioMuted: () => readySdk.game.settings.muteAudio,
      onAudioMuteChange(callback: (muted: boolean) => void) {
        const listener = (settings: { readonly muteAudio: boolean }) => callback(settings.muteAudio);
        readySdk.game.addSettingsChangeListener(listener);
        return () => readySdk.game.removeSettingsChangeListener(listener);
      },
    } } : {}),
    async getCapabilities() {
      const adsAvailable = enabled && launch === 'full';
      let adAvailability: 'available' | 'unsupported' | 'configuration-required' = adsAvailable ? 'available' : 'unsupported';
      if (sdk === undefined) { adAvailability = 'configuration-required'; }
      return {
        ...createUnsupportedCapabilities(), nativeAds: adsAvailable, interstitialAds: adsAvailable,
        localizedContent: true,
        providerAvailability: {
          interstitialAds: adAvailability,
        },
      };
    },
    presentation: {
      getLaunchIntent: async () => ({ entry: 'free-play' }),
      requestGameSurface: async () => 'already-fullscreen',
    },
    // Account identity, IAP, rewards and platform leaderboards are not certified by this adapter.
    sharing: {},
    leaderboard: { submitScore: async () => ({ submitted: false }), open: async () => {} },
  };
}

function waitForInitialization(initializing: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('CrazyGames SDK initialization timed out.')),
      5000,
    );
    initializing.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function visibilityLifecycle(document: Document | undefined): LifecycleAdapter {
  const paused = new Set<() => void>();
  const resumed = new Set<() => void>();
  let attached = false;
  const changed = () => {
    for (const callback of document?.hidden ? paused : resumed) {
      callback();
    }
  };
  const subscribe = (listeners: Set<() => void>, callback: () => void) => {
    listeners.add(callback);
    if (!attached && document !== undefined) {
      document.addEventListener('visibilitychange', changed);
      attached = true;
    }
    return () => {
      listeners.delete(callback);
      if (attached && paused.size + resumed.size === 0) {
        document?.removeEventListener('visibilitychange', changed);
        attached = false;
      }
    };
  };
  return {
    onPause: (callback) => subscribe(paused, callback),
    onResume: (callback) => subscribe(resumed, callback),
  };
}

/** Interstitial-only: callbacks are physical observations, never server reward evidence. */
export function createCrazyGamesAdProvider(options: {
  readonly sdk: CrazyGamesSdk | undefined;
  readonly launch: CrazyGamesLaunch;
  readonly placementIds?: readonly string[] | undefined;
  readonly onError?: (error: unknown) => void;
}): AdProvider {
  const sdk = options.sdk;
  const id = 'crazygames-ads';
  const listeners = new Set<(event: AdPresentationEvent) => void>();
  const flights = new Map<string, { input: AdShowInput; promise: Promise<AdShowResult> }>();
  const placements = options.placementIds === undefined ? undefined : new Set(options.placementIds);
  const availability = (input: AdPlacementInput): AdAvailability => {
    if (input.format !== 'interstitial') {
      return { state: 'unsupported', reason: 'unsupported' };
    }
    if (options.launch !== 'full') {
      return { state: 'unsupported', reason: 'policy-disabled' };
    }
    if (sdk === undefined) {
      return {
        state: 'configuration-required',
        reason: 'configuration-required',
      };
    }
    if (sdk.environment === 'disabled') {
      return { state: 'unsupported', reason: 'unsupported' };
    }
    if (placements !== undefined && !placements.has(input.placementId)) {
      return {
        state: 'configuration-required',
        reason: 'configuration-required',
      };
    }
    if (nativeOwners.has(sdk.ad)) {
      return {
        state: 'temporarily-unavailable',
        reason: 'busy',
      };
    }
    return { state: 'available' };
  };
  return {
    id, protocol: adProtocol, protocolVersion: adProtocolVersion, rewardSignal: 'immediate',
    getAvailability: async (input) => availability(input),
    async preload(input) {
      const state = availability(input);
      return state.state === 'available' ? { status: 'deferred' } : { status: 'unavailable', reason: state.reason ?? 'unsupported' };
    },
    show(supplied) {
      const input = assertAdShowInput(supplied);
      const previous = flights.get(input.invocationId);
      if (previous !== undefined) {
        if (JSON.stringify(previous.input) !== JSON.stringify(input)) { throw new TypeError('Advertising invocation identity changed.'); }
        return previous.promise;
      }
      const base = { providerId: id, invocationId: input.invocationId, format: input.format,
        eligibility: input.format === 'interstitial' ? 'not-applicable' : 'not-earned' } as const;
      const state = availability(input);
      if (state.state !== 'available' || sdk === undefined) {
        return Promise.resolve({ ...base, outcome: 'unavailable', presentation: 'not-started', reason: state.reason ?? 'unsupported' });
      }
      let resolve!: (result: AdShowResult) => void;
      const promise = new Promise<AdShowResult>((done) => { resolve = done; });
      flights.set(input.invocationId, { input, promise });
      const owner = {};
      nativeOwners.set(sdk.ad, owner);
      let started = false;
      let terminal = false;
      let sequence = 0;
      const emit = (event: { type: 'requested' | 'started' | 'closed' | 'unknown' } | { type: 'failed'; reason: AdReason }) => {
        const observation = Object.freeze({ providerId: id, invocationId: input.invocationId, sequence: ++sequence, ...event });
        for (const listener of listeners) {
          try { listener(observation); } catch (error) { try { options.onError?.(error); } catch { /* Preserve native ownership. */ } }
        }
      };
      const uncertain = () => {
        if (terminal) { return; }
        emit({ type: 'unknown' });
        resolve({ ...base, outcome: 'pending', presentation: 'unknown', reason: 'outcome-unknown' });
      };
      const close = (reason?: AdReason) => {
        if (terminal) { return; }
        terminal = true;
        if (nativeOwners.get(sdk.ad) === owner) { nativeOwners.delete(sdk.ad); }
        if (reason === undefined) {
          emit({ type: 'closed' });
          resolve({ ...base, outcome: 'shown', presentation: 'closed' });
        } else {
          emit({ type: 'failed', reason });
          resolve({ ...base, outcome: 'unavailable', presentation: 'not-started', reason });
        }
      };
      emit({ type: 'requested' });
      try {
        const result = sdk.ad.requestAd('midgame', {
          adStarted() { if (!terminal && !started) { started = true; emit({ type: 'started' }); } },
          adFinished() { close(); },
          adError(error) {
            const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
            const reason = noStartReason(code);
            if (!started && reason !== undefined) { close(reason); } else { uncertain(); }
          },
        });
        if (result !== undefined) { Promise.resolve(result).catch(uncertain); }
      } catch { uncertain(); }
      return promise;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

function noStartReason(code: unknown): AdReason | undefined {
  switch (code) {
    case 'unfilled':
      return 'no-fill';
    case 'adblock':
      return 'action-required';
    case 'adCooldown':
      return 'busy';
    case 'adsDisabledBasicLaunch':
      return 'policy-disabled';
    default:
      return undefined;
  }
}
