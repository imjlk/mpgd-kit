/** Official ONE store H5 Game SDK v1.1.0 public surface, without internal bridge actions. */
export const onePlaySdkUrl = 'https://h5sdk.onestore.net/lib/v1.1.0/onestore-h5-sdk.min.js';
export interface OnePlayEnvironment {
  readonly playerId: string;
  readonly locale: string;
  readonly ringerSilent: boolean;
  readonly safeArea: Readonly<{ top: number; right: number; bottom: number; left: number }>;
  readonly err?: never;
}
export interface OnePlayAdResult {
  readonly status: 'rewarded' | 'dismissed' | 'completed' | 'failed';
  readonly requestId?: string;
  readonly reason?: string;
}
export interface OnePlaySdk {
  initializeAsync(): Promise<OnePlayEnvironment | { readonly err: string }>;
  setLoadingProgress(progress: number): void;
  startGameAsync(): Promise<unknown>;
  on(event: 'pause', callback: (event: { readonly reason: string }) => void): void;
  on(event: 'resume', callback: (event: { readonly ringerSilent?: boolean }) => void): void;
  on(event: 'exit', callback: () => void): void;
  off(event: 'pause' | 'resume' | 'exit', callback: (...args: never[]) => void): void;
  onBackPressed(callback: () => boolean): void;
  readonly ads: {
    isSupported(type?: 'rewarded' | 'interstitial'): boolean;
    loadRewarded(input: { readonly placementId: string }): void;
    loadInterstitial(input: { readonly placementId: string }): void;
    isReadyAsync(type: 'rewarded' | 'interstitial', placementId: string): Promise<boolean>;
    showRewardedAsync(input: { readonly placementId: string; readonly requestId: string }): Promise<OnePlayAdResult>;
    showInterstitialAsync(input: { readonly placementId: string }): Promise<OnePlayAdResult>;
  };
}
let loading: Promise<OnePlaySdk> | undefined;
/** The SDK is loaded and created before the gateway starts game initialization. */
export function loadOnePlaySdk(): Promise<OnePlaySdk> {
  if (loading !== undefined) {
    return loading;
  }
  const attempt = waitForOnePlay(import(/* @vite-ignore */ onePlaySdkUrl)).then(
    (module: { createSDK(): OnePlaySdk }) => module.createSDK(),
  );
  loading = attempt;
  void attempt.catch(() => {
    if (loading === attempt) {
      loading = undefined;
    }
  });
  return attempt;
}
export function waitForOnePlay<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ONE play initialization timed out.')), 10000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
