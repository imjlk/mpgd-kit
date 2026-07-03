import type { BridgeMethod, BridgeRequest, BridgeResponse } from '@mpgd/bridge-protocol';
import type { PlatformGateway } from '@mpgd/platform-contract';

export interface GamePlatformBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

export function createAitPlatformGateway(input: {
  readonly appVersion: string;
  readonly buildId: string;
}): PlatformGateway {
  async function request<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    const bridge = getBridge();

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
      load: (payload) => request('storage.load', payload),
      save: (payload) => request('storage.save', payload),
    },
  };
}

function getBridge(): GamePlatformBridge | undefined {
  return (globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge }).__GAME_PLATFORM_BRIDGE__;
}
