import {
  getTossShareLink,
  getUserKeyForGame,
  isMinVersionSupported,
  loadFullScreenAd,
  openGameCenterLeaderboard,
  share,
  showFullScreenAd,
  Storage,
  submitGameCenterLeaderBoardScore,
} from '@apps-in-toss/web-framework';

import {
  assertBridgeRequest,
  bridgeStorageLoadProtocol,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import type { LaunchEntry, LaunchIntent, ShareResult } from '@mpgd/platform';

import type { GamePlatformBridge } from './index.js';
import { dispatchAitLifecycleEvent } from './lifecycle.js';

const defaultAdTimeoutMs = 60_000;
const defaultAdLoadQueueTimeoutMs = 5_000;
const defaultAdDisplayStartTimeoutMs = 60_000;
const defaultAdMaximumDisplayMs = 30 * 60_000;
const invalidBridgeRequestId = 'ait-invalid-request';
const rewardedAdEvidenceSchema = 'apps-in-toss.rewarded-ad.callback.v1';
const launchEntries = new Set<LaunchEntry>([
  'home',
  'daily',
  'practice',
  'free-play',
  'continue',
  'leaderboard',
  'friend-challenge',
]);

export type AitIdentityProvider = () => Promise<unknown>;

export interface AitHostDependencies {
  readonly identityProvider: AitIdentityProvider;
  readonly storage: Pick<typeof Storage, 'getItem' | 'setItem'>;
  readonly getTossShareLink: typeof getTossShareLink;
  readonly share: typeof share;
  readonly isMinVersionSupported: typeof isMinVersionSupported;
  readonly loadFullScreenAd: typeof loadFullScreenAd;
  readonly showFullScreenAd: typeof showFullScreenAd;
  readonly openGameCenterLeaderboard: typeof openGameCenterLeaderboard;
  readonly submitGameCenterLeaderBoardScore: typeof submitGameCenterLeaderBoardScore;
}

export interface InstallAitHostBridgeOptions {
  readonly appName?: string;
  readonly adGroupIds?: Readonly<Record<string, string>>;
  readonly adPlacementTypes?: Readonly<Record<string, 'rewarded' | 'interstitial'>>;
  /** Maximum total wait for the native show request before display is observed. */
  readonly adTimeoutMs?: number;
  /** Maximum wait to acquire the process-wide native full-screen load slot. */
  readonly adLoadQueueTimeoutMs?: number;
  /** Upper bound for the requested-to-display portion of the total show timeout. */
  readonly adDisplayStartTimeoutMs?: number;
  /** Last-resort cleanup when the native SDK omits its terminal display callback. */
  readonly adMaximumDisplayMs?: number;
  readonly dependencies?: Partial<AitHostDependencies>;
}

const defaultDependencies: AitHostDependencies = {
  identityProvider: getUserKeyForGame,
  storage: Storage,
  getTossShareLink,
  share,
  isMinVersionSupported,
  loadFullScreenAd,
  showFullScreenAd,
  openGameCenterLeaderboard,
  submitGameCenterLeaderBoardScore,
};

export function installAitHostBridge(options: InstallAitHostBridgeOptions = {}): GamePlatformBridge {
  const bridge = createAitHostBridge(options);
  (globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge }).__GAME_PLATFORM_BRIDGE__ = bridge;
  return bridge;
}

export function createAitHostBridge(
  options: InstallAitHostBridgeOptions = {},
): GamePlatformBridge {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const appName = normalizeAppName(options.appName ?? 'mpgd-kit');
  const adGroupIds = normalizeAdGroupIds(options.adGroupIds);
  const adPlacementTypes = normalizeAdPlacementTypes(options.adPlacementTypes);
  const loadedAdGroupIds = new Set<string>();
  const loadingAdGroups = new Map<string, Promise<void>>();
  const activeAdGroupIds = new Set<string>();
  let warnedUnsupportedAdPreload = false;
  const adTimeoutMs = normalizeTimeout(options.adTimeoutMs);
  const adLoadQueueTimeoutMs = normalizeLoadQueueTimeout(options.adLoadQueueTimeoutMs);
  const adDisplayStartTimeoutMs = normalizeDisplayStartTimeout(options.adDisplayStartTimeoutMs);
  const adMaximumDisplayMs = normalizeMaximumDisplayTimeout(options.adMaximumDisplayMs);
  const adLoadCoordinator: AitAdLoadCoordinator = {
    active: undefined,
    waitTimeoutMs: adLoadQueueTimeoutMs,
  };

  return {
    async request(input) {
      try {
        return await handleRequest(parseBridgeRequest(input));
      } catch (error) {
        return createBridgeError(
          readBridgeRequestId(input),
          'AIT_BRIDGE_REQUEST_FAILED',
          errorMessage(error),
          true,
        );
      }
    },
  };

  async function handleRequest(request: BridgeRequest): Promise<BridgeResponse> {
    switch (request.method) {
      case 'runtime.getCapabilities': {
        const adsSupported = areFullScreenAdsSupported(dependencies);
        const rewardedAds = adsSupported
          && hasConfiguredAdType(adGroupIds, adPlacementTypes, 'rewarded');
        const interstitialAds = adsSupported
          && hasConfiguredAdType(adGroupIds, adPlacementTypes, 'interstitial');

        return ok(request, {
          nativeIap: false,
          nativeAds: rewardedAds || interstitialAds,
          rewardedAds,
          interstitialAds,
          nativeLeaderboard: isGameCenterSupported(dependencies),
          achievements: false,
          cloudSave: false,
          socialShare: true,
          haptics: false,
          localizedContent: true,
        });
      }

      case 'identity.getPlayer': {
        const player = await resolveAitIdentity(dependencies.identityProvider);
        return player === null
          ? createBridgeError(
              request.id,
              'AIT_IDENTITY_UNAVAILABLE',
              'AIT user identity is unavailable.',
            )
          : ok(request, player);
      }

      case 'identity.getSession': {
        const player = await resolveAitIdentity(dependencies.identityProvider);
        return ok(
          request,
          player === null
            ? { identityLevel: 'guest', trustLevel: 'local' }
            : {
                identityLevel: 'platform-anonymous',
                playerId: player.playerId,
                trustLevel: 'platform-asserted',
              },
        );
      }

      case 'identity.requestUpgrade':
        return ok(request, { status: 'unavailable', reloadExpected: false });

      case 'presentation.getLaunchIntent':
        return ok(request, getLaunchIntent());

      case 'presentation.requestGameSurface':
        return ok(request, 'already-fullscreen');

      case 'share.share':
        return ok(request, await shareIntent(request.payload, {
          appName,
          getTossShareLink: dependencies.getTossShareLink,
          share: dependencies.share,
        }));

      case 'share.readInboundShare':
        return ok(request, readInboundShare());

      case 'notifications.getStatus':
        return ok(request, 'unsupported');

      case 'notifications.requestSubscription':
        return ok(request, 'unavailable');

      // IAP must be installed with game-owned server verification. Never return demo grants.
      case 'commerce.getProducts':
        return ok(request, []);

      case 'commerce.purchase':
        return ok(request, { status: 'failed', entitlementIds: [] });

      case 'commerce.restore':
        return ok(request, { restoredEntitlements: [] });

      case 'commerce.getEntitlements':
        return ok(request, []);

      case 'ads.preload': {
        const placementId = readPlacementId(request.payload);
        const adGroupId = adGroupIds.get(placementId);
        const placementType = adPlacementTypes.get(placementId);

        if (adGroupId === undefined || placementType === undefined) {
          return createBridgeError(
            request.id,
            'AIT_AD_UNAVAILABLE',
            `AIT ad placement is unavailable: ${placementId}`,
          );
        }

        if (!isCapabilitySupported(() => dependencies.loadFullScreenAd.isSupported())) {
          if (!warnedUnsupportedAdPreload) {
            warnedUnsupportedAdPreload = true;
            console.warn(
              'AIT full-screen ads are not supported; configured preload is a no-op.',
              placementId,
            );
          }
          return ok(request, {});
        }

        await preloadAdGroupWithDiagnostics(
          dependencies,
          adGroupId,
          loadedAdGroupIds,
          loadingAdGroups,
          adLoadCoordinator,
          adTimeoutMs,
          placementType,
        );
        return ok(request, {});
      }

      case 'ads.showRewarded': {
        const placementId = readPlacementId(request.payload);
        const adGroupId = adGroupIds.get(placementId);

        if (
          adGroupId === undefined
          || adPlacementTypes.get(placementId) !== 'rewarded'
          || !areFullScreenAdsSupported(dependencies)
        ) {
          return ok(request, { status: 'unavailable', rewardGranted: false });
        }

        const shown = await withLoadedAdSlot(
          dependencies,
          adGroupId,
          loadedAdGroupIds,
          loadingAdGroups,
          adLoadCoordinator,
          activeAdGroupIds,
          adTimeoutMs,
          'rewarded',
          async () => {
            const correlationId = readIdempotencyKey(request.payload, request.id);
            const result = await showRewardedAd(
              dependencies,
              adGroupId,
              adTimeoutMs,
              adDisplayStartTimeoutMs,
              adMaximumDisplayMs,
            );

            return result.rewardGranted
              ? {
                  ...result,
                  // game-services forwards this as platformImpressionId and compares it
                  // with the native callback correlationId during authority verification.
                  ledgerEntryId: correlationId,
                  evidence: {
                    schema: rewardedAdEvidenceSchema,
                    payload: {
                      event: 'user-earned-reward',
                      correlationId,
                      placementId: adGroupId,
                    },
                  },
                }
              : result;
          },
        );
        if (!shown.acquired) {
          return ok(request, { status: 'unavailable', rewardGranted: false });
        }
        return ok(request, shown.value);
      }

      case 'ads.showInterstitial': {
        const placementId = readPlacementId(request.payload);
        const adGroupId = adGroupIds.get(placementId);

        if (
          adGroupId === undefined
          || adPlacementTypes.get(placementId) !== 'interstitial'
          || !areFullScreenAdsSupported(dependencies)
        ) {
          return ok(request, { status: 'unavailable' });
        }

        const showInterstitial = () => showInterstitialAd(
          dependencies,
          adGroupId,
          adTimeoutMs,
          adDisplayStartTimeoutMs,
          adMaximumDisplayMs,
        );
        const shown = await withLoadedAdSlot(
          dependencies,
          adGroupId,
          loadedAdGroupIds,
          loadingAdGroups,
          adLoadCoordinator,
          activeAdGroupIds,
          adTimeoutMs,
          'interstitial',
          showInterstitial,
        );
        return ok(request, shown.acquired ? shown.value : { status: 'unavailable' });
      }

      case 'leaderboard.submitScore': {
        if (!isGameCenterSupported(dependencies)) {
          return ok(request, { submitted: false });
        }

        const score = readFiniteScore(request.payload);
        const result = await dependencies.submitGameCenterLeaderBoardScore({
          score: String(score),
        });
        return ok(request, { submitted: result?.statusCode === 'SUCCESS' });
      }

      case 'leaderboard.open': {
        if (!isGameCenterSupported(dependencies)) {
          return ok(request, {});
        }

        dispatchAitLifecycleEvent('pause');
        try {
          await dependencies.openGameCenterLeaderboard();
        } finally {
          dispatchAitLifecycleEvent('resume');
        }
        return ok(request, {});
      }

      case 'storage.load': {
        const key = readStorageKey(request.payload);
        const serialized = await dependencies.storage.getItem(key);
        return ok(request, decodeStoredValue(serialized));
      }

      case 'storage.save': {
        const key = readStorageKey(request.payload);
        const value = readPayloadRecord(request.payload).value;
        const serialized = JSON.stringify(value);

        if (serialized === undefined) {
          throw new TypeError('Storage values must be JSON-serializable.');
        }

        await dependencies.storage.setItem(key, serialized);
        return ok(request, {});
      }

      default:
        return createBridgeError(
          request.id,
          'UNSUPPORTED_METHOD',
          `Unsupported AIT bridge method: ${request.method}`,
        );
    }
  }
}

interface AitShareDependencies {
  readonly appName: string;
  readonly getTossShareLink: typeof getTossShareLink;
  readonly share: typeof share;
}

export async function shareIntent(
  payload: unknown,
  dependencies: AitShareDependencies,
): Promise<ShareResult> {
  const intent = readPayloadRecord(payload);

  if (typeof intent.text !== 'string' || typeof intent.deepLink !== 'string') {
    return { status: 'unavailable' };
  }

  const deepLink = toAitDeepLink(intent.deepLink, dependencies.appName);

  if (deepLink === undefined) {
    return { status: 'unavailable' };
  }

  try {
    const tossLink = await dependencies.getTossShareLink(
      deepLink,
      typeof intent.previewImageUrl === 'string' && intent.previewImageUrl.startsWith('https://')
        ? intent.previewImageUrl
        : undefined,
    );
    await dependencies.share({ message: `${intent.text}\n${tossLink}` });
    return { status: 'shared', completion: 'presented' };
  } catch (error) {
    return isAbortError(error) ? { status: 'cancelled' } : { status: 'unavailable' };
  }
}

async function resolveAitIdentity(
  provider: AitIdentityProvider,
): Promise<{ readonly playerId: string } | null> {
  let result: unknown;

  try {
    result = await provider();
  } catch {
    return null;
  }

  if (!isRecord(result) || result.type !== 'HASH') {
    return null;
  }

  const hash = typeof result.hash === 'string' ? result.hash.trim() : '';
  return hash.length === 0 ? null : { playerId: hash };
}

async function preloadAdGroup(
  dependencies: AitHostDependencies,
  adGroupId: string,
  loaded: Set<string>,
  loading: Map<string, Promise<void>>,
  coordinator: AitAdLoadCoordinator,
  timeoutMs: number,
): Promise<void> {
  if (loaded.has(adGroupId)) {
    return;
  }

  const existing = loading.get(adGroupId);
  if (existing !== undefined) {
    await existing;
    return;
  }

  const startNativeLoad = (): Promise<void> => new Promise<void>((resolve, reject) => {
    let cleanup = (): void => {};
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      cleanup();
      if (error === undefined) {
        loaded.add(adGroupId);
        resolve();
      } else {
        reject(error);
      }
    };
    const timer = globalThis.setTimeout(
      () => finish(new Error(`Timed out loading AIT ad group ${adGroupId}.`)),
      timeoutMs,
    );

    try {
      const unregister = dependencies.loadFullScreenAd({
        options: { adGroupId },
        onEvent: (event) => {
          if (event.type === 'loaded') {
            finish();
          }
        },
        onError: finish,
      });
      cleanup = unregister;
      if (settled) {
        cleanup();
      }
    } catch (error) {
      finish(error);
    }
  });
  const pending = runSerializedAdLoad(coordinator, adGroupId, startNativeLoad);
  loading.set(adGroupId, pending);

  try {
    await pending;
  } finally {
    // Clean up this load attempt. The identity check also protects a future retry
    // implementation from deleting a replacement promise.
    if (loading.get(adGroupId) === pending) {
      loading.delete(adGroupId);
    }
  }
}

interface AitAdLoadCoordinator {
  active: { readonly promise: Promise<void> } | undefined;
  readonly waitTimeoutMs: number;
}

async function runSerializedAdLoad(
  coordinator: AitAdLoadCoordinator,
  adGroupId: string,
  startNativeLoad: () => Promise<void>,
): Promise<void> {
  const waitDeadline = Date.now() + coordinator.waitTimeoutMs;

  while (coordinator.active !== undefined) {
    const remainingWaitMs = waitDeadline - Date.now();
    if (remainingWaitMs <= 0) {
      throw new Error(
        `Timed out waiting for the AIT ad load slot: ${adGroupId} (queue deadline exceeded).`,
      );
    }
    await waitForAdLoadSettlement(coordinator.active.promise, remainingWaitMs, adGroupId);
  }

  // Some deployed Toss runtimes lose callbacks when different groups begin
  // loading together. Acquire the process-wide native boundary synchronously;
  // the actual native load still receives its complete timeout budget.
  const pending = startNativeLoad();
  coordinator.active = { promise: pending };
  try {
    await pending;
  } finally {
    if (coordinator.active?.promise === pending) {
      coordinator.active = undefined;
    }
  }
}

function waitForAdLoadSettlement(
  active: Promise<void>,
  timeoutMs: number,
  adGroupId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const timer = globalThis.setTimeout(
      () => finish(new Error(
        `Timed out waiting for the AIT ad load slot: ${adGroupId} (active load wait expired).`,
      )),
      timeoutMs,
    );
    void active.then(
      () => finish(),
      () => finish(),
    );
  });
}

async function acquireLoadedAdSlot(
  dependencies: AitHostDependencies,
  adGroupId: string,
  loaded: Set<string>,
  loading: Map<string, Promise<void>>,
  coordinator: AitAdLoadCoordinator,
  active: Set<string>,
  timeoutMs: number,
  placementType: 'rewarded' | 'interstitial',
): Promise<boolean> {
  if (active.has(adGroupId)) {
    return false;
  }

  const loadedSuccessfully = await preloadAdGroupWithDiagnostics(
    dependencies,
    adGroupId,
    loaded,
    loading,
    coordinator,
    timeoutMs,
    placementType,
  );
  if (!loadedSuccessfully) {
    return false;
  }

  // Re-check after the asynchronous load so concurrent callers cannot consume
  // or display the same native ad slot twice.
  if (active.has(adGroupId) || !consumeLoadedAd(adGroupId, loaded)) {
    return false;
  }

  active.add(adGroupId);
  return true;
}

async function preloadAdGroupWithDiagnostics(
  dependencies: AitHostDependencies,
  adGroupId: string,
  loaded: Set<string>,
  loading: Map<string, Promise<void>>,
  coordinator: AitAdLoadCoordinator,
  timeoutMs: number,
  placementType: 'rewarded' | 'interstitial',
): Promise<boolean> {
  // The first caller enters preloadAdGroup synchronously and publishes its promise
  // before yielding. Remember that ownership so concurrent waiters do not emit the
  // same diagnostic for one native load failure.
  const ownsLoadAttempt = !loaded.has(adGroupId) && !loading.has(adGroupId);

  try {
    await preloadAdGroup(dependencies, adGroupId, loaded, loading, coordinator, timeoutMs);
    return true;
  } catch (error) {
    // Preloading is opportunistic. A later show request may retry, so keep
    // gameplay available while retaining one diagnostic per native attempt.
    if (ownsLoadAttempt) {
      console.warn(`Failed to preload ${placementType} AIT ad group.`, adGroupId, error);
    }
    return false;
  }
}

type LoadedAdSlotResult<Value> =
  | { readonly acquired: false }
  | { readonly acquired: true; readonly value: Value };

async function withLoadedAdSlot<Value>(
  dependencies: AitHostDependencies,
  adGroupId: string,
  loaded: Set<string>,
  loading: Map<string, Promise<void>>,
  coordinator: AitAdLoadCoordinator,
  active: Set<string>,
  timeoutMs: number,
  placementType: 'rewarded' | 'interstitial',
  display: () => Promise<Value>,
): Promise<LoadedAdSlotResult<Value>> {
  const acquired = await acquireLoadedAdSlot(
    dependencies,
    adGroupId,
    loaded,
    loading,
    coordinator,
    active,
    timeoutMs,
    placementType,
  );
  if (!acquired) {
    return { acquired: false };
  }

  try {
    return { acquired: true, value: await display() };
  } finally {
    active.delete(adGroupId);
  }
}

async function showRewardedAd(
  dependencies: AitHostDependencies,
  adGroupId: string,
  timeoutMs: number,
  displayStartTimeoutMs: number,
  maximumDisplayMs: number,
): Promise<{ readonly status: 'completed' | 'skipped' | 'failed'; readonly rewardGranted: boolean }> {
  let rewardGranted = false;
  const status = await showAd(
    dependencies,
    adGroupId,
    timeoutMs,
    displayStartTimeoutMs,
    maximumDisplayMs,
    (eventType) => {
      if (eventType === 'userEarnedReward') {
        rewardGranted = true;
      }
    },
  );
  let resultStatus: 'completed' | 'skipped' | 'failed';

  if (status === 'shown' && rewardGranted) {
    resultStatus = 'completed';
  } else if (status === 'failed') {
    resultStatus = 'failed';
  } else {
    resultStatus = 'skipped';
  }

  return {
    status: resultStatus,
    rewardGranted,
  };
}

async function showInterstitialAd(
  dependencies: AitHostDependencies,
  adGroupId: string,
  timeoutMs: number,
  displayStartTimeoutMs: number,
  maximumDisplayMs: number,
): Promise<{ readonly status: 'shown' | 'skipped' }> {
  const status = await showAd(
    dependencies,
    adGroupId,
    timeoutMs,
    displayStartTimeoutMs,
    maximumDisplayMs,
  );
  return { status: status === 'failed' ? 'skipped' : status };
}

function showAd(
  dependencies: AitHostDependencies,
  adGroupId: string,
  timeoutMs: number,
  displayStartTimeoutMs: number,
  maximumDisplayMs: number,
  observe?: (eventType: string) => void,
): Promise<'shown' | 'failed'> {
  dispatchAitLifecycleEvent('pause');

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let cleanup = (): void => {};
    let settled = false;
    let maximumDisplayTimeoutArmed = false;
    let adTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const clearAdTimer = (): void => {
      if (adTimer !== undefined) {
        globalThis.clearTimeout(adTimer);
        adTimer = undefined;
      }
    };
    const finish = (status: 'shown' | 'failed'): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAdTimer();
      cleanup();
      dispatchAitLifecycleEvent('resume');
      resolve(status);
    };
    const armDisplayStartTimeout = (): void => {
      clearAdTimer();
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const remainingMs = Math.max(0, timeoutMs - elapsedMs);
      adTimer = globalThis.setTimeout(
        () => finish('failed'),
        Math.min(displayStartTimeoutMs, remainingMs),
      );
    };
    const armMaximumDisplayTimeout = (): void => {
      if (maximumDisplayTimeoutArmed) {
        return;
      }
      maximumDisplayTimeoutArmed = true;
      clearAdTimer();
      adTimer = globalThis.setTimeout(() => {
        console.warn(
          'AIT full-screen ad omitted its terminal callback; recovering the game lifecycle.',
          adGroupId,
        );
        finish('shown');
      }, maximumDisplayMs);
    };
    const failShow = (error?: unknown): void => {
      if (settled) {
        return;
      }
      console.warn(
        'Failed to show AIT full-screen ad.',
        adGroupId,
        error ?? 'unknown native error',
      );
      finish('failed');
    };
    adTimer = globalThis.setTimeout(() => finish('failed'), timeoutMs);

    try {
      const unregister = dependencies.showFullScreenAd({
        options: { adGroupId },
        onEvent: (event) => {
          observe?.(event.type);
          switch (event.type) {
            case 'requested':
              armDisplayStartTimeout();
              break;
            case 'show':
            case 'impression':
            case 'clicked':
            case 'userEarnedReward':
              // Native terminal callbacks remain authoritative. A long, one-shot
              // recovery timeout prevents a broken SDK callback from deadlocking
              // the game forever without treating ordinary end-card dwell as failure.
              armMaximumDisplayTimeout();
              break;
            case 'dismissed':
              finish('shown');
              break;
            case 'failedToShow':
              finish('failed');
              break;
          }
        },
        onError: failShow,
      });
      cleanup = unregister;
      if (settled) {
        cleanup();
      }
    } catch (error) {
      failShow(error);
    }
  });
}

function getLaunchIntent(): LaunchIntent {
  const params = inboundSearchParams();
  const challengeToken = nonEmptyParam(params.get('challengeToken'));
  const puzzleId = nonEmptyParam(params.get('puzzleId'));
  const requestedEntry = nonEmptyParam(params.get('entry'));
  let entry: LaunchEntry;

  if (requestedEntry !== undefined && launchEntries.has(requestedEntry as LaunchEntry)) {
    entry = requestedEntry as LaunchEntry;
  } else if (challengeToken === undefined) {
    entry = 'home';
  } else {
    entry = 'friend-challenge';
  }

  return {
    entry,
    ...(puzzleId === undefined ? {} : { puzzleId }),
    ...(challengeToken === undefined ? {} : { referralToken: challengeToken }),
  };
}

function readInboundShare(): { readonly puzzleId?: string; readonly challengeToken?: string } | null {
  const params = inboundSearchParams();
  const puzzleId = nonEmptyParam(params.get('puzzleId'));
  const challengeToken = nonEmptyParam(params.get('challengeToken'));
  return puzzleId === undefined && challengeToken === undefined
    ? null
    : {
        ...(puzzleId === undefined ? {} : { puzzleId }),
        ...(challengeToken === undefined ? {} : { challengeToken }),
      };
}

function inboundSearchParams(): URLSearchParams {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const nested = params.get('queryParams');

  if (nested !== null) {
    try {
      const parsed = JSON.parse(nested) as unknown;
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && !params.has(key)) {
            params.set(key, value);
          }
        }
      }
    } catch {
      // Deep-link payloads are untrusted; malformed nested query data is ignored.
    }
  }

  return params;
}

function toAitDeepLink(input: string, appName: string): string | undefined {
  if (input.startsWith('//')) {
    return undefined;
  }

  if (input.startsWith('/')) {
    const baseUrl = new URL('https://mpgd.invalid');
    const parsed = new URL(input, baseUrl);
    return parsed.origin === baseUrl.origin
      ? `intoss://${appName}${parsed.pathname}${parsed.search}${parsed.hash}`
      : undefined;
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'intoss:') {
      return parsed.hostname === appName ? input : undefined;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? `intoss://${appName}${parsed.pathname}${parsed.search}${parsed.hash}`
      : undefined;
  } catch {
    return undefined;
  }
}

function isGameCenterSupported(dependencies: AitHostDependencies): boolean {
  return dependencies.isMinVersionSupported({ android: '5.221.0', ios: '5.221.0' });
}

function areFullScreenAdsSupported(dependencies: AitHostDependencies): boolean {
  return isCapabilitySupported(() => dependencies.loadFullScreenAd.isSupported())
    && isCapabilitySupported(() => dependencies.showFullScreenAd.isSupported());
}

function isCapabilitySupported(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch (error) {
    // Older hosts and local wrappers may not expose a native support constant yet.
    // Missing capability metadata must disable the feature instead of blocking startup.
    console.debug('AIT capability support check failed; disabling the feature.', error);
    return false;
  }
}

function normalizeAdGroupIds(
  input: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(input ?? {})
      .map(([placementId, adGroupId]) => [placementId.trim(), adGroupId.trim()] as const)
      .filter(([placementId, adGroupId]) => placementId.length > 0 && adGroupId.length > 0),
  );
}

function consumeLoadedAd(adGroupId: string, loaded: Set<string>): boolean {
  if (!loaded.has(adGroupId)) {
    return false;
  }

  loaded.delete(adGroupId);
  return true;
}

function decodeStoredValue(serialized: string | null): BridgeStorageLoadData {
  if (serialized === null) {
    return { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false };
  }

  try {
    return {
      __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
      found: true,
      value: JSON.parse(serialized) as unknown,
    };
  } catch {
    // Malformed native state is treated as absent so the game can recover with
    // its versioned defaults instead of entering a permanent load-error loop.
    return { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false };
  }
}

function hasConfiguredAdType(
  adGroupIds: ReadonlyMap<string, string>,
  adPlacementTypes: ReadonlyMap<string, 'rewarded' | 'interstitial'>,
  type: 'rewarded' | 'interstitial',
): boolean {
  return [...adGroupIds.keys()].some((placementId) => adPlacementTypes.get(placementId) === type);
}

function normalizeAdPlacementTypes(
  input: Readonly<Record<string, 'rewarded' | 'interstitial'>> | undefined,
): ReadonlyMap<string, 'rewarded' | 'interstitial'> {
  return new Map(
    Object.entries(input ?? {})
      .map(([placementId, type]) => [placementId.trim(), type] as const)
      .filter(([placementId]) => placementId.length > 0),
  );
}

function normalizeAppName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9-]+$/u.test(normalized)) {
    throw new Error('AIT appName must contain only letters, numbers, and hyphens.');
  }
  return normalized;
}

function normalizeTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultAdTimeoutMs,
    'AIT ad timeout must be a positive finite number.',
  );
}

function normalizeLoadQueueTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultAdLoadQueueTimeoutMs,
    'AIT ad load queue timeout must be a positive finite number.',
  );
}

function normalizeDisplayStartTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultAdDisplayStartTimeoutMs,
    'AIT ad display start timeout must be a positive finite number.',
  );
}

function normalizeMaximumDisplayTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultAdMaximumDisplayMs,
    'AIT ad maximum display timeout must be a positive finite number.',
  );
}

function normalizePositiveTimeout(
  value: number | undefined,
  defaultValue: number,
  message: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}

function readStorageKey(payload: unknown): string {
  const key = readPayloadRecord(payload).key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('AIT storage key must be a non-empty string.');
  }
  return key;
}

function readPlacementId(payload: unknown): string {
  const placementId = readPayloadRecord(payload).placementId;
  if (typeof placementId !== 'string' || placementId.length === 0) {
    throw new TypeError('AIT ad placementId must be a non-empty string.');
  }
  return placementId;
}

function readIdempotencyKey(payload: unknown, fallback: string): string {
  const value = readPayloadRecord(payload).idempotencyKey;
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readFiniteScore(payload: unknown): number {
  const score = readPayloadRecord(payload).score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new TypeError('AIT leaderboard score must be a finite number.');
  }
  return score;
}

function readPayloadRecord(payload: unknown): Readonly<Record<string, unknown>> {
  return isRecord(payload) ? payload : {};
}

function parseBridgeRequest(input: unknown): BridgeRequest {
  // The production host deliberately accepts only the current bridge protocol.
  // Legacy partial requests are rejected rather than silently inventing metadata.
  return assertBridgeRequest(input);
}

function readBridgeRequestId(input: unknown): string {
  if (!isRecord(input) || typeof input.id !== 'string' || input.id.length === 0) {
    return invalidBridgeRequestId;
  }
  return input.id;
}

function ok(request: BridgeRequest, data: unknown): BridgeResponse {
  return { id: request.id, ok: true, data };
}

function createBridgeError(
  id: string,
  code: string,
  message: string,
  retryable = false,
): BridgeResponse {
  return { id, ok: false, error: { code, message, retryable } };
}

function nonEmptyParam(value: string | null): string | undefined {
  return value === null || value.length === 0 ? undefined : value;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
