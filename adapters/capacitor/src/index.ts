import {
  decodeBridgeStorageLoadData,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { CapacitorGameServices } from '@mpgd/capacitor-game-services';
import type {
  IdentitySession,
  IdentityUpgradeResult,
  InboundShare,
  LaunchIntent,
  NotificationSubscriptionResult,
  NotificationSubscriptionStatus,
  PlatformCapabilities,
  PlatformGateway,
  PlatformTarget,
  PresentationResult,
  ShareResult,
} from '@mpgd/platform';

export interface NativeBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

export function createCapacitorPlatformGateway(input: {
  readonly target: Extract<PlatformTarget, 'android' | 'ios'>;
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: NativeBridge;
}): PlatformGateway {
  const bridge = input.bridge ?? CapacitorGameServices;

  async function request<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    const response = (await bridge.request({
      id: crypto.randomUUID(),
      method,
      payload,
      meta: {
        target: input.target,
        appVersion: input.appVersion,
        buildId: input.buildId,
        sentAt: new Date().toISOString(),
      },
    })) as BridgeResponse<TData>;

    if (!response.ok) {
      throw new Error(response.error.message);
    }

    return response.data;
  }

  return {
    target: input.target,
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
        return decodeBridgeStorageLoadData(await request<unknown>('storage.load', payload));
      },
      save: (payload) => request('storage.save', payload),
    },
  };
}
