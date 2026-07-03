import {
  isMinVersionSupported,
  openGameCenterLeaderboard,
  submitGameCenterLeaderBoardScore,
} from '@apps-in-toss/web-framework';

import type { BridgeRequest, BridgeResponse } from './bridgeTypes';

const storage = new Map<string, unknown>();

export function installAitBridge(): void {
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

        case 'identity.getPlayer':
          return {
            id: request.id,
            ok: true,
            data: {
              playerId: 'ait-local-player',
              displayName: 'AIT Local Player',
            },
          };

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

          return {
            id: request.id,
            ok: true,
            data: payload.key === undefined ? null : (storage.get(payload.key) ?? null),
          };
        }

        case 'storage.save': {
          const payload = request.payload as { readonly key?: string; readonly value?: unknown };

          if (payload.key !== undefined) {
            storage.set(payload.key, payload.value);
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

function isGameCenterSupported(): boolean {
  return isMinVersionSupported({
    android: '5.221.0',
    ios: '5.221.0',
  });
}
