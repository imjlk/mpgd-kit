import type { BridgeMethod, BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type {
  IdentitySession,
  IdentityUpgradeResult,
  InboundShare,
  LaunchIntent,
  NotificationSubscriptionResult,
  NotificationSubscriptionStatus,
  PlatformCapabilities,
  PlatformGateway,
  PresentationResult,
  ShareResult,
} from '@mpgd/platform';

export interface GamePlatformBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

export function createAitPlatformGateway(input: {
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: GamePlatformBridge;
  readonly fallbackBridge?: GamePlatformBridge;
}): PlatformGateway {
  async function request<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    const bridge = input.bridge ?? getBridge() ?? input.fallbackBridge;

    if (bridge === undefined) {
      throw new Error('AIT bridge is not installed.');
    }

    const response = await bridge.request({
      id: crypto.randomUUID(),
      method,
      payload,
      meta: {
        target: 'ait',
        appVersion: input.appVersion,
        buildId: input.buildId,
        sentAt: new Date().toISOString(),
      },
    });

    if (!response.ok) {
      throw new Error(response.error.message);
    }

    return response.data as TData;
  }

  return {
    target: 'ait',
    async getCapabilities() {
      return { ...await request<PlatformCapabilities>('runtime.getCapabilities', {}) };
    },
    identity: {
      getPlayer: () => request('identity.getPlayer', {}),
      getSession: () => request<IdentitySession>('identity.getSession', {}),
      requestUpgrade: (payload) =>
        request<IdentityUpgradeResult>('identity.requestUpgrade', payload),
    },
    presentation: {
      getLaunchIntent: () => request<LaunchIntent>('presentation.getLaunchIntent', {}),
      requestGameSurface: (payload) =>
        request<PresentationResult>('presentation.requestGameSurface', payload),
    },
    sharing: {
      share: (payload) => request<ShareResult>('share.share', payload),
      readInboundShare: () => request<InboundShare | null>('share.readInboundShare', {}),
    },
    notifications: {
      getStatus: (topic) =>
        request<NotificationSubscriptionStatus>('notifications.getStatus', { topic }),
      requestSubscription: (topic) =>
        request<NotificationSubscriptionResult>('notifications.requestSubscription', { topic }),
    },
    commerce: {
      getProducts: () => request('commerce.getProducts', {}),
      purchase: (payload) => request('commerce.purchase', payload),
      restore: () => request('commerce.restore', {}),
      getEntitlements: () => request('commerce.getEntitlements', {}),
    },
    ads: {
      preload: (payload) => request('ads.preload', payload),
      showRewarded: (payload) => request('ads.showRewarded', payload),
      showInterstitial: (payload) => request('ads.showInterstitial', payload),
    },
    leaderboard: {
      submitScore: (payload) => request('leaderboard.submitScore', payload),
      open: (payload) => request('leaderboard.open', payload ?? {}),
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load(payload) {
        const value = await request<unknown | null>('storage.load', payload);

        return value === null ? null : { value };
      },
      save: (payload) => request('storage.save', payload),
    },
  };
}

function getBridge(): GamePlatformBridge | undefined {
  return (globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge }).__GAME_PLATFORM_BRIDGE__;
}

export function createAitSandboxBridge(): GamePlatformBridge {
  const storage = new Map<string, unknown>();

  return {
    async request(input) {
      switch (input.method) {
        case 'runtime.getCapabilities':
          return ok(input, {
            nativeIap: true,
            nativeAds: true,
            rewardedAds: true,
            interstitialAds: true,
            nativeLeaderboard: true,
            achievements: false,
            cloudSave: false,
            socialShare: true,
            haptics: true,
            localizedContent: true,
          });

        case 'identity.getPlayer':
          return ok(input, {
            playerId: 'ait-sandbox-player',
            displayName: 'AIT Sandbox Player',
          });

        case 'identity.getSession':
          return ok(input, {
            identityLevel: 'platform-anonymous',
            playerId: 'ait-sandbox-player',
            trustLevel: 'platform-asserted',
          });

        case 'identity.requestUpgrade':
          return ok(input, {
            status: 'unavailable',
            reloadExpected: false,
          });

        case 'presentation.getLaunchIntent':
          return ok(input, {
            entry: 'home',
          });

        case 'presentation.requestGameSurface':
          return ok(input, 'already-fullscreen');

        case 'share.share':
          return ok(input, {
            status: 'shared',
          });

        case 'share.readInboundShare':
          return ok(input, null);

        case 'notifications.getStatus':
          return ok(input, 'configuration-required');

        case 'notifications.requestSubscription':
          return ok(input, 'unavailable');

        case 'commerce.getProducts':
          return ok(input, [
            {
              id: 'COINS_100',
              type: 'consumable',
              title: '100 Coins',
              description: 'Adds 100 sandbox coins.',
              price: {
                formatted: 'KRW 1,100',
                currencyCode: 'KRW',
              },
            },
          ]);

        case 'commerce.purchase':
          return ok(input, {
            status: 'completed',
            transactionId: `ait-sandbox-${input.id}`,
            entitlementIds: ['COINS_100'],
          });

        case 'commerce.restore':
          return ok(input, {
            restoredEntitlements: [],
          });

        case 'commerce.getEntitlements':
          return ok(input, []);

        case 'ads.preload':
          return ok(input, {});

        case 'ads.showRewarded':
          return ok(input, {
            status: 'completed',
            rewardGranted: true,
            ledgerEntryId: `ait-sandbox-reward-${input.id}`,
          });

        case 'ads.showInterstitial':
          return ok(input, {
            status: 'shown',
          });

        case 'leaderboard.submitScore':
          return ok(input, {
            submitted: true,
          });

        case 'leaderboard.open':
          return ok(input, {});

        case 'storage.load': {
          const payload = input.payload as { readonly key?: string };
          return ok(input, payload.key === undefined ? null : (storage.get(payload.key) ?? null));
        }

        case 'storage.save': {
          const payload = input.payload as { readonly key?: string; readonly value?: unknown };

          if (payload.key !== undefined) {
            storage.set(payload.key, payload.value);
          }

          return ok(input, {});
        }

        default:
          return {
            id: input.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED_METHOD',
              message: `Unsupported AIT sandbox method: ${input.method}`,
              retryable: false,
            },
          };
      }
    },
  };
}

function ok(input: BridgeRequest, data: unknown): BridgeResponse {
  return {
    id: input.id,
    ok: true,
    data,
  };
}
