import {
  getAnonymousKey,
  getTossShareLink,
  isMinVersionSupported,
  loadFullScreenAd,
  openGameCenterLeaderboard,
  share,
  showFullScreenAd,
  Storage,
  submitGameCenterLeaderBoardScore,
} from '@apps-in-toss/web-framework';

import {
  bridgeStorageLoadProtocol,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import type { LaunchEntry, LaunchIntent, ShareResult } from '@mpgd/platform';

import type { GamePlatformBridge } from './index.js';
import { dispatchAitLifecycleEvent } from './lifecycle.js';

const defaultAdTimeoutMs = 60_000;
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
  readonly adTimeoutMs?: number;
  readonly dependencies?: Partial<AitHostDependencies>;
}

const defaultDependencies: AitHostDependencies = {
  identityProvider: getAnonymousKey,
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
  const adTimeoutMs = normalizeTimeout(options.adTimeoutMs);

  return {
    async request(input) {
      try {
        return await handleRequest(parseBridgeRequest(input));
      } catch (error) {
        return createBridgeError(
          input.id,
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
        const adsSupported = dependencies.loadFullScreenAd.isSupported()
          && dependencies.showFullScreenAd.isSupported();
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

        if (
          adGroupId === undefined
          || adPlacementTypes.get(placementId) === undefined
          || !dependencies.loadFullScreenAd.isSupported()
        ) {
          return createBridgeError(
            request.id,
            'AIT_AD_UNAVAILABLE',
            `AIT ad placement is unavailable: ${placementId}`,
          );
        }

        await preloadAdGroup(dependencies, adGroupId, loadedAdGroupIds, adTimeoutMs);
        return ok(request, {});
      }

      case 'ads.showRewarded': {
        const placementId = readPlacementId(request.payload);
        const adGroupId = adGroupIds.get(placementId);

        if (
          adGroupId === undefined
          || adPlacementTypes.get(placementId) !== 'rewarded'
          || !dependencies.showFullScreenAd.isSupported()
          || !consumeLoadedAd(adGroupId, loadedAdGroupIds)
        ) {
          return ok(request, { status: 'unavailable', rewardGranted: false });
        }

        const correlationId = readIdempotencyKey(request.payload, request.id);
        const result = await showRewardedAd(dependencies, adGroupId, adTimeoutMs);

        return ok(
          request,
          result.rewardGranted
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
            : result,
        );
      }

      case 'ads.showInterstitial': {
        const placementId = readPlacementId(request.payload);
        const adGroupId = adGroupIds.get(placementId);

        if (
          adGroupId === undefined
          || adPlacementTypes.get(placementId) !== 'interstitial'
          || !dependencies.showFullScreenAd.isSupported()
          || !consumeLoadedAd(adGroupId, loadedAdGroupIds)
        ) {
          return ok(request, { status: 'unavailable' });
        }

        return ok(request, await showInterstitialAd(dependencies, adGroupId, adTimeoutMs));
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
  timeoutMs: number,
): Promise<void> {
  if (loaded.has(adGroupId)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let cleanup = (): void => {};
    const finish = once((error?: unknown) => {
      globalThis.clearTimeout(timer);
      cleanup();
      if (error === undefined) {
        loaded.add(adGroupId);
        resolve();
      } else {
        reject(error);
      }
    });
    const timer = globalThis.setTimeout(
      () => finish(new Error(`Timed out loading AIT ad group ${adGroupId}.`)),
      timeoutMs,
    );

    cleanup = dependencies.loadFullScreenAd({
      options: { adGroupId },
      onEvent: (event) => {
        if (event.type === 'loaded') {
          finish();
        }
      },
      onError: finish,
    });
  });
}

async function showRewardedAd(
  dependencies: AitHostDependencies,
  adGroupId: string,
  timeoutMs: number,
): Promise<{ readonly status: 'completed' | 'skipped' | 'failed'; readonly rewardGranted: boolean }> {
  let rewardGranted = false;
  const status = await showAd(dependencies, adGroupId, timeoutMs, (eventType) => {
    if (eventType === 'userEarnedReward') {
      rewardGranted = true;
    }
  });
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
): Promise<{ readonly status: 'shown' | 'skipped' | 'unavailable' }> {
  const status = await showAd(dependencies, adGroupId, timeoutMs);
  return { status: status === 'failed' ? 'skipped' : status };
}

function showAd(
  dependencies: AitHostDependencies,
  adGroupId: string,
  timeoutMs: number,
  observe?: (eventType: string) => void,
): Promise<'shown' | 'failed'> {
  dispatchAitLifecycleEvent('pause');

  return new Promise((resolve) => {
    let cleanup = (): void => {};
    const finish = once((status: 'shown' | 'failed') => {
      globalThis.clearTimeout(timer);
      cleanup();
      dispatchAitLifecycleEvent('resume');
      resolve(status);
    });
    const timer = globalThis.setTimeout(() => finish('failed'), timeoutMs);

    cleanup = dependencies.showFullScreenAd({
      options: { adGroupId },
      onEvent: (event) => {
        observe?.(event.type);
        if (event.type === 'dismissed') {
          finish('shown');
        } else if (event.type === 'failedToShow') {
          finish('failed');
        }
      },
      onError: () => finish('failed'),
    });
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
  if (value === undefined) {
    return defaultAdTimeoutMs;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('AIT ad timeout must be a positive finite number.');
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

function parseBridgeRequest(input: BridgeRequest): BridgeRequest {
  if (typeof input.id !== 'string' || input.id.length === 0 || typeof input.method !== 'string') {
    throw new TypeError('Bridge request id and method are required.');
  }
  return input;
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

function once<Arguments extends readonly unknown[]>(
  callback: (...args: Arguments) => void,
): (...args: Arguments) => void {
  let called = false;
  return (...args) => {
    if (!called) {
      called = true;
      callback(...args);
    }
  };
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
