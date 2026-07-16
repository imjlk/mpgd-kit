import {
  getTossShareLink,
  getUserKeyForGame,
  isMinVersionSupported,
  openGameCenterLeaderboard,
  share,
  submitGameCenterLeaderBoardScore,
} from '@apps-in-toss/web-framework';

// The AIT packager treats workspace dependencies as runtime packages. Keep this
// shared contract as a source-only type import so it is erased before packaging.
import type {
  LaunchEntry,
  LaunchIntent,
  ShareResult,
} from '../../../packages/platform/src/index';

declare const __MPGD_AIT_APP_NAME__: string;

import {
  resolveAitGameIdentity,
  type AitGameUserKeyProvider,
} from './aitIdentity';
import {
  bridgeStorageLoadProtocol,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from './bridgeTypes';

const storage = new Map<string, unknown>();
const launchEntries = new Set<LaunchEntry>([
  'home',
  'daily',
  'practice',
  'free-play',
  'continue',
  'leaderboard',
  'friend-challenge',
]);
const defaultAitShareDependencies: AitShareDependencies = {
  appName: typeof __MPGD_AIT_APP_NAME__ === 'string' ? __MPGD_AIT_APP_NAME__ : 'mpgd-kit',
  getTossShareLink,
  share,
};

export interface AitShareDependencies {
  readonly appName: string;
  readonly getTossShareLink: typeof getTossShareLink;
  readonly share: typeof share;
}

export interface InstallAitBridgeOptions {
  readonly getUserKeyForGame?: AitGameUserKeyProvider;
}

export function installAitBridge(options: InstallAitBridgeOptions = {}): void {
  const gameUserKeyProvider = options.getUserKeyForGame ?? getUserKeyForGame;
  const globalBridgeHost = globalThis as {
    __GAME_PLATFORM_BRIDGE__?: {
      request(input: unknown): Promise<BridgeResponse>;
    };
  };

  globalBridgeHost.__GAME_PLATFORM_BRIDGE__ = {
    async request(input: unknown): Promise<BridgeResponse> {
      const request = parseBridgeRequest(input);

      switch (request.method) {
        case 'runtime.getCapabilities':
          return {
            id: request.id,
            ok: true,
            data: {
              nativeIap: true,
              nativeAds: true,
              rewardedAds: true,
              interstitialAds: true,
              nativeLeaderboard: isGameCenterSupported(),
              achievements: false,
              cloudSave: false,
              socialShare: true,
              haptics: true,
              localizedContent: true,
            },
          };

        case 'identity.getPlayer': {
          const identity = await resolveAitGameIdentity(gameUserKeyProvider);

          if (!identity.ok) {
            return {
              id: request.id,
              ok: false,
              error: identity.error,
            };
          }

          return {
            id: request.id,
            ok: true,
            data: identity.player,
          };
        }

        case 'identity.getSession':
          return ok(request, await getIdentitySession(gameUserKeyProvider));

        case 'identity.requestUpgrade':
          return ok(request, {
            status: 'unavailable',
            reloadExpected: false,
          });

        case 'presentation.getLaunchIntent':
          return ok(request, getLaunchIntent());

        case 'presentation.requestGameSurface':
          return ok(request, 'already-fullscreen');

        case 'share.share':
          return ok(request, await shareIntent(request.payload));

        case 'share.readInboundShare':
          return ok(request, readInboundShare());

        case 'notifications.getStatus':
          return ok(request, 'configuration-required');

        case 'notifications.requestSubscription':
          return ok(request, 'unavailable');

        case 'commerce.getProducts':
          return {
            id: request.id,
            ok: true,
            data: [
              {
                id: 'COINS_100',
                type: 'consumable',
                title: '100 Coins',
                description: 'Adds 100 demo coins.',
                price: {
                  formatted: '₩1,100',
                  currencyCode: 'KRW',
                },
              },
            ],
          };

        case 'commerce.purchase':
          return {
            id: request.id,
            ok: true,
            data: {
              status: 'completed',
              transactionId: `ait-mock-${request.id}`,
              entitlementIds: ['COINS_100'],
            },
          };

        case 'commerce.restore':
          return {
            id: request.id,
            ok: true,
            data: {
              restoredEntitlements: [],
            },
          };

        case 'commerce.getEntitlements':
          return {
            id: request.id,
            ok: true,
            data: [],
          };

        case 'ads.preload':
          return {
            id: request.id,
            ok: true,
            data: {},
          };

        case 'ads.showRewarded':
          return {
            id: request.id,
            ok: true,
            data: {
              status: 'completed',
              rewardGranted: true,
              ledgerEntryId: `ait-reward-${request.id}`,
            },
          };

        case 'ads.showInterstitial':
          return {
            id: request.id,
            ok: true,
            data: {
              status: 'shown',
            },
          };

        case 'leaderboard.submitScore': {
          const payload = request.payload as { readonly score: number };
          const result = await submitGameCenterLeaderBoardScore({
            score: String(payload.score),
          });

          return {
            id: request.id,
            ok: true,
            data: {
              submitted: result?.statusCode === 'SUCCESS',
            },
          };
        }

        case 'leaderboard.open':
          await openGameCenterLeaderboard();
          return {
            id: request.id,
            ok: true,
            data: {},
          };

        case 'storage.load': {
          const payload = request.payload as { readonly key?: string };
          const value = payload.key === undefined ? undefined : storage.get(payload.key);

          return {
            id: request.id,
            ok: true,
            data:
              value === undefined
                ? ({
                    __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
                    found: false,
                  } satisfies BridgeStorageLoadData)
                : ({
                    __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
                    found: true,
                    value: cloneJsonValue(value),
                  } satisfies BridgeStorageLoadData),
          };
        }

        case 'storage.save': {
          const payload = request.payload as { readonly key?: string; readonly value?: unknown };

          if (payload.key !== undefined) {
            storage.set(payload.key, cloneJsonValue(payload.value));
          }

          return {
            id: request.id,
            ok: true,
            data: {},
          };
        }

        default:
          return createBridgeError(
            request.id,
            'UNSUPPORTED_METHOD',
            `Unsupported AIT bridge method: ${request.method}`,
          );
      }
    },
  };
}

function cloneJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new TypeError('Storage values must be JSON-serializable.');
  }

  return JSON.parse(serialized) as unknown;
}

function parseBridgeRequest(input: unknown): BridgeRequest {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Bridge request must be an object.');
  }

  const request = input as Partial<BridgeRequest>;

  if (typeof request.id !== 'string' || typeof request.method !== 'string') {
    throw new TypeError('Bridge request id and method are required.');
  }

  return request as BridgeRequest;
}

function createBridgeError(
  id: string,
  code: string,
  message: string,
  retryable = false,
): BridgeResponse {
  return {
    id,
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
  };
}

function ok(request: BridgeRequest, data: unknown): BridgeResponse {
  return {
    id: request.id,
    ok: true,
    data,
  };
}

async function getIdentitySession(
  gameUserKeyProvider: AitGameUserKeyProvider,
): Promise<{
  readonly identityLevel: 'guest' | 'platform-anonymous';
  readonly playerId?: string;
  readonly trustLevel: 'local' | 'platform-asserted';
}> {
  const identity = await resolveAitGameIdentity(gameUserKeyProvider);

  if (!identity.ok) {
    return {
      identityLevel: 'guest',
      trustLevel: 'local',
    };
  }

  return {
    identityLevel: 'platform-anonymous',
    playerId: identity.player.playerId,
    trustLevel: 'platform-asserted',
  };
}

function getLaunchIntent(): LaunchIntent {
  const params = inboundSearchParams();
  const challengeToken = nonEmptyParam(params.get('challengeToken'));
  const puzzleId = nonEmptyParam(params.get('puzzleId'));
  const requestedEntry = nonEmptyParam(params.get('entry'));
  let entry: LaunchEntry;

  if (
    requestedEntry !== undefined
    && launchEntries.has(requestedEntry as LaunchEntry)
  ) {
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

export async function shareIntent(
  payload: unknown,
  dependencies: AitShareDependencies = defaultAitShareDependencies,
): Promise<ShareResult> {
  if (typeof payload !== 'object' || payload === null) {
    return { status: 'unavailable' };
  }

  const intent = payload as {
    readonly text?: unknown;
    readonly deepLink?: unknown;
    readonly previewImageUrl?: unknown;
  };

  if (typeof intent.text !== 'string' || typeof intent.deepLink !== 'string') {
    return { status: 'unavailable' };
  }

  const aitDeepLink = toAitDeepLink(intent.deepLink, dependencies.appName);

  if (aitDeepLink === undefined) {
    return { status: 'unavailable' };
  }

  try {
    const tossLink = await dependencies.getTossShareLink(
      aitDeepLink,
      typeof intent.previewImageUrl === 'string' && intent.previewImageUrl.startsWith('https://')
        ? intent.previewImageUrl
        : undefined,
    );
    await dependencies.share({ message: `${intent.text}\n${tossLink}` });
    return { status: 'shared' };
  } catch (error) {
    if (isAbortError(error)) {
      return { status: 'cancelled' };
    }

    console.warn('AIT share failed; returning unavailable.', error);
    return { status: 'unavailable' };
  }
}

function readInboundShare(): {
  readonly puzzleId?: string;
  readonly challengeToken?: string;
} | null {
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

  if (nested === null) {
    return params;
  }

  try {
    const parsed = JSON.parse(nested) as unknown;

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && !params.has(key)) {
          params.set(key, value);
        }
      }
    }
  } catch {
    // Deep-link payloads are untrusted; malformed nested query data is ignored.
  }

  return params;
}

function nonEmptyParam(value: string | null): string | undefined {
  return value === null || value.length === 0 ? undefined : value;
}

function toAitDeepLink(input: string, appNameInput: string): string | undefined {
  const appName = appNameInput.trim();

  if (!/^[A-Za-z0-9-]+$/u.test(appName)) {
    return undefined;
  }

  if (input.startsWith('//')) {
    return undefined;
  }

  if (input.startsWith('/')) {
    const baseUrl = new URL('https://mpgd.invalid');
    const parsed = new URL(input, baseUrl);

    if (parsed.origin !== baseUrl.origin) {
      return undefined;
    }

    return `intoss://${appName}${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  let parsed: URL;

  try {
    parsed = new URL(input);
  } catch {
    return undefined;
  }

  if (parsed.protocol === 'intoss:') {
    return parsed.hostname === appName ? input : undefined;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }

  return `intoss://${appName}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function isAbortError(error: unknown): boolean {
  try {
    return (
      typeof error === 'object'
      && error !== null
      && 'name' in error
      && error.name === 'AbortError'
    );
  } catch {
    return false;
  }
}

function isGameCenterSupported(): boolean {
  return isMinVersionSupported({
    android: '5.221.0',
    ios: '5.221.0',
  });
}
