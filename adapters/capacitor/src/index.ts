import type { BridgeMethod, BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import { CapacitorGameServices } from '@mpgd/capacitor-game-services';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform';

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
    getCapabilities: () => request('runtime.getCapabilities', {}),
    identity: {
      getPlayer: () => request('identity.getPlayer', {}),
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
