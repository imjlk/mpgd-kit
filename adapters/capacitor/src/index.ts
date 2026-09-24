import { decodeBridgeStorageLoadData, type BridgeMethod } from '@mpgd/bridge';
import { CapacitorGameServices } from '@mpgd/capacitor-game-services';
import {
  PlatformOperationError,
  type IdentitySession,
  type IdentityUpgradeResult,
  type InboundShare,
  type LaunchIntent,
  type NotificationSubscriptionResult,
  type NotificationSubscriptionStatus,
  type PlatformCapabilities,
  type PlatformGateway,
  type PlatformTarget,
  type PresentationResult,
  type ShareResult,
} from '@mpgd/platform';
import {
  assertProviderResponseData,
  createCapacitorProviderRegistry,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';

export {
  createCapacitorProviderRegistry,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createCapacitorPlatformGateway(input: {
  readonly target: Extract<PlatformTarget, 'android' | 'ios'>;
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: NativeBridge;
  readonly providers?: readonly CapacitorServiceProvider[];
}): PlatformGateway {
  const bridge = input.bridge ?? CapacitorGameServices;
  const providers = createCapacitorProviderRegistry(input.providers ?? []);

  async function request<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    const id = crypto.randomUUID();
    let provider = providers.byMethod.get(method);
    if (provider !== undefined) {
      try {
        await providers.assertMethodReady(method);
      } catch (error) {
        // An unconfigured or failed optional identity/push provider must not
        // prevent guest boot or a status query through the base bridge.
        if (
          error instanceof PlatformOperationError
          && (method === 'identity.getPlayer' || method === 'identity.getSession'
            || method === 'notifications.getStatus')
        ) {
          provider = undefined;
        } else {
          throw error;
        }
      }
    }
    const response: unknown = await (provider?.bridge ?? bridge).request({
      id,
      method,
      payload,
      meta: {
        target: input.target,
        appVersion: input.appVersion,
        buildId: input.buildId,
        sentAt: new Date().toISOString(),
      },
    });

    if (!isRecord(response) || response.id !== id || typeof response.ok !== 'boolean') {
      throw new PlatformOperationError({
        code: 'NATIVE_BRIDGE_INVALID_RESPONSE',
        message: `Native bridge returned an invalid response for ${method}.`,
      });
    }

    if (response.ok) {
      if (!Object.hasOwn(response, 'data')) {
        throw new PlatformOperationError({
          code: 'NATIVE_BRIDGE_INVALID_RESPONSE',
          message: `Native bridge omitted response data for ${method}.`,
        });
      }
      if (provider !== undefined) {
        assertProviderResponseData(method, response.data);
      }
      return response.data as TData;
    }

    if (
      !isRecord(response.error)
      || typeof response.error.code !== 'string'
      || typeof response.error.message !== 'string'
      || typeof response.error.retryable !== 'boolean'
    ) {
      throw new PlatformOperationError({
        code: 'NATIVE_BRIDGE_INVALID_RESPONSE',
        message: `Native bridge returned an invalid error for ${method}.`,
      });
    }

    throw new PlatformOperationError(response.error);
  }

  return {
    target: input.target,
    async getCapabilities() {
      const base = await request<PlatformCapabilities>('runtime.getCapabilities', {});
      const states = await providers.getAvailability();
      const rewardedAds = states.rewardedAds === 'available';
      const interstitialAds = states.interstitialAds === 'available';
      const bannerAds = states.bannerAds === 'available';
      return {
        ...base,
        nativeIap: states.nativeIap === 'available',
        subscriptionIap: states.subscriptionIap === 'available',
        nativeAds: rewardedAds || interstitialAds || bannerAds,
        rewardedAds,
        interstitialAds,
        bannerAds,
        nativeLeaderboard: states.nativeLeaderboard === 'available',
        providerAvailability: states,
      };
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
      mountBanner: (payload) => request('ads.mountBanner', payload),
      unmountBanner: (payload) => request('ads.unmountBanner', payload),
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
