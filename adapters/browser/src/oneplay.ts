import {
  createUnsupportedCapabilities,
  type LifecycleAdapter,
  type NativeBackButtonEvent,
  type PlatformGateway,
  type StorageAdapter,
} from '@mpgd/platform';
import { toAdAdapter } from '@mpgd/platform/ads';
import { createBrowserPlatformGateway, type BrowserPlatformGatewayOptions } from './index.js';
import { createOnePlayAdProvider } from './oneplay-ads.js';
import {
  loadOnePlaySdk,
  waitForOnePlay,
  type OnePlayEnvironment,
  type OnePlaySdk,
} from './oneplay-sdk.js';
export {
  loadOnePlaySdk,
  onePlaySdkUrl,
  type OnePlayEnvironment,
  type OnePlaySdk,
} from './oneplay-sdk.js';
export { createOnePlayAdProvider } from './oneplay-ads.js';

export interface OnePlayGatewayOptions {
  readonly sdk?: OnePlaySdk;
  readonly loadSdk?: () => Promise<OnePlaySdk>;
  readonly storage?: BrowserPlatformGatewayOptions['storage'];
  readonly document?: Document;
  readonly placementIds?: Readonly<Record<string, { readonly format: 'rewarded' | 'interstitial'; readonly platformId: string }>>;
  readonly onError?: (error: unknown) => void;
}
export async function createOnePlayPlatformGateway(options: OnePlayGatewayOptions = {}): Promise<PlatformGateway> {
  let sdk: OnePlaySdk | undefined;
  let environment: OnePlayEnvironment | undefined;
  let paused = false;
  let exited = false;
  let disposed = false;
  let muted = false;
  let observedMute: boolean | undefined;
  const pauses = new Set<() => void>();
  const resumes = new Set<() => void>();
  const exits = new Set<() => void>();
  const audio = new Set<(muted: boolean) => void>();
  const back = new Set<(event: NativeBackButtonEvent) => boolean | Promise<boolean>>();
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch { /* Diagnostic only. */ }
  };
  const deliver = (listeners: Set<() => void>) => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
  };
  const pause = () => {
    if (!disposed && !paused) {
      paused = true;
      deliver(pauses);
    }
  };
  const resume = (event: { readonly ringerSilent?: boolean }) => {
    if (disposed || exited) {
      return;
    }
    if (typeof event.ringerSilent === 'boolean') {
      observedMute = event.ringerSilent;
    }
    if (typeof event.ringerSilent === 'boolean' && muted !== event.ringerSilent) {
      muted = event.ringerSilent;
      for (const listener of [...audio]) {
        try {
          listener(muted);
        } catch (error) {
          report(error);
        }
      }
    }
    paused = false;
    deliver(resumes);
  };
  const exit = () => {
    if (!disposed && !exited) {
      exited = true;
      pause();
      deliver(exits);
    }
  };
  const detach = () => {
    sdk?.off('pause', pause);
    sdk?.off('resume', resume);
    sdk?.off('exit', exit);
  };
  try {
    sdk = options.sdk ?? await waitForOnePlay((options.loadSdk ?? loadOnePlaySdk)());
    // Register before initialization; retain events until the game runtime subscribes.
    sdk.on('pause', pause);
    sdk.on('resume', resume);
    sdk.on('exit', exit);
    const info = await waitForOnePlay(sdk.initializeAsync());
    if ('err' in info || !validEnvironment(info)) {
      throw new Error('ONE play environment is unavailable.');
    }
    environment = info;
    muted = observedMute ?? info.ringerSilent;
    sdk.onBackPressed(() => {
      if (disposed || exited) {
        return false;
      }
      for (const handler of [...back].reverse()) {
        try {
          const result = handler({ canGoBack: false });
          if (result === true) {
            return true;
          }
          if (result instanceof Promise) {
            void result.catch(report);
          }
        } catch (error) {
          report(error);
        }
      }
      return false;
    });
  } catch (error) {
    detach();
    sdk = undefined;
    environment = undefined;
    muted = false;
    paused = (options.document ?? globalThis.document)?.hidden === true;
    report(error);
  }
  if (exited) {
    throw new Error('ONE play document terminated during initialization.');
  }
  const host = sdk;
  const ready = environment;
  const lifecycle: LifecycleAdapter = {
    onPause(callback) {
      pauses.add(callback);
      if (paused || exited) {
        callback();
      }
      return () => {
        pauses.delete(callback);
      };
    },
    onResume(callback) {
      resumes.add(callback);
      return () => {
        resumes.delete(callback);
      };
    },
    onExit(callback) {
      exits.add(callback);
      if (exited) {
        callback();
      }
      return () => {
        exits.delete(callback);
      };
    },
    onBackButton(handler) {
      back.add(handler);
      return () => {
        back.delete(handler);
      };
    },
    async dispose() {
      if (!disposed) {
        disposed = true;
        detach();
        pauses.clear();
        resumes.clear();
        exits.clear();
        back.clear();
        audio.clear();
      }
    },
  };
  const browser = createBrowserPlatformGateway({
    lifecycle,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  });
  const storageKey = (key: string) => `oneplay:${encodeURIComponent(ready?.playerId ?? 'guest')}:${key}`;
  const storage: StorageAdapter = {
    load: (input) => browser.storage.load({ key: storageKey(input.key) }),
    save: (input) => browser.storage.save({ ...input, key: storageKey(input.key) }),
    saveSync({ key, value }) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new TypeError('Checkpoint must be JSON serializable.');
      }
      const destination = options.storage ?? globalThis.localStorage;
      destination.setItem(`mpgd:${storageKey(key)}`, encoded);
    },
  };
  // Browser fallback owns DOM events, while an initialized host owns native events.
  if (host === undefined) {
    const document = options.document ?? globalThis.document;
    const changed = () => {
      if (document?.hidden) {
        pause();
      } else {
        resume({});
      }
    };
    document?.addEventListener('visibilitychange', changed);
    const dispose = lifecycle.dispose;
    lifecycle.dispose = async () => {
      document?.removeEventListener('visibilitychange', changed);
      await dispose?.();
    };
  }
  const placementIds = options.placementIds ?? {};
  const ads = toAdAdapter(
    createOnePlayAdProvider({ ...(host === undefined ? {} : { sdk: host }), placementIds }),
  );
  let complete: Promise<void> | undefined;
  return {
    ...browser, target: 'oneplay', lifecycle, storage, ads,
    ...(host === undefined || ready === undefined ? {} : {
      identity: {
        getPlayer: async () => ({ playerId: ready.playerId }),
        getSession: async () => ({ playerId: ready.playerId, identityLevel: 'platform-anonymous', trustLevel: 'platform-asserted' } as const),
      },
      gameLoading: {
        setProgress(progress: number) { if (!disposed && !exited) { host.setLoadingProgress(progress); } },
        complete() {
          if (disposed || exited) { return Promise.reject(new Error('ONE play document has terminated.')); }
          if (complete === undefined) {
            const attempt = Promise.resolve().then(async () => {
              const result = await host.startGameAsync();
              if (disposed || exited || typeof result === 'object' && result !== null && 'err' in result) { throw new Error('ONE play game start was not acknowledged.'); }
            });
            complete = attempt;
            void attempt.catch(() => { if (complete === attempt) { complete = undefined; } });
          }
          return complete;
        },
      },
      gameSettings: {
        getLocale: () => ready.locale,
        getAudioMuted: () => muted,
        onAudioMuteChange(callback: (muted: boolean) => void) { audio.add(callback); return () => { audio.delete(callback); }; },
      },
      viewport: {
        getState() {
          const view = options.document?.defaultView ?? globalThis.window;
          const zero = { top: 0, right: 0, bottom: 0, left: 0 };
          return { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0, safeAreaInsets: ready.safeArea, systemBarInsets: zero, keyboardInsets: zero, occupiedSurfaces: [] };
        },
        onChange(callback) {
          const view = options.document?.defaultView ?? globalThis.window;
          const listener = () => callback(this.getState());
          view?.addEventListener('resize', listener);
          return () => view?.removeEventListener('resize', listener);
        },
      },
    }),
    async getCapabilities() {
      const interstitialAds = host?.ads.isSupported('interstitial') === true && Object.values(placementIds).some((placement) => placement.format === 'interstitial' && placement.platformId.trim() !== '');
      return { ...createUnsupportedCapabilities(), nativeAds: interstitialAds, interstitialAds, localizedContent: true,
        providerAvailability: { interstitialAds: host === undefined ? 'unsupported' : interstitialAds ? 'available' : 'configuration-required' } };
    },
    presentation: { getLaunchIntent: async () => ({ entry: 'free-play' }), requestGameSurface: async () => 'already-fullscreen' },
    sharing: {}, leaderboard: { submitScore: async () => ({ submitted: false }), open: async () => {} },
  };
}
function validEnvironment(info: unknown): info is OnePlayEnvironment {
  if (typeof info !== 'object' || info === null) {
    return false;
  }
  const environment = info as OnePlayEnvironment;
  return typeof environment.playerId === 'string' && environment.playerId.trim() !== ''
    && typeof environment.locale === 'string' && environment.locale.trim() !== '' && typeof environment.ringerSilent === 'boolean'
    && environment.safeArea !== undefined && ['top', 'right', 'bottom', 'left'].every((edge) => {
      const value = environment.safeArea[edge as keyof OnePlayEnvironment['safeArea']];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    });
}
