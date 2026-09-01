import {
  createUnsupportedCapabilities,
  PlatformOperationError,
  type PlatformGateway,
} from '@mpgd/platform';

import type { WechatMiniGameApi } from './api.js';
import { createWechatLifecycleAdapter } from './lifecycle.js';
import { createWechatSharingAdapter } from './sharing.js';
import { createWechatStorageAdapter } from './storage.js';

export interface CreateWechatPlatformGatewayOptions {
  readonly api: WechatMiniGameApi;
  readonly storageKeyPrefix?: string;
}

export function createWechatPlatformGateway(
  options: CreateWechatPlatformGatewayOptions,
): PlatformGateway {
  const sharing = createWechatSharingAdapter(options.api);

  return {
    target: 'wechat',
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        socialShare: sharing !== undefined,
        localizedContent: true,
      };
    },
    identity: {
      async getPlayer() {
        return null;
      },
      async getSession() {
        return {
          identityLevel: 'guest',
          trustLevel: 'local',
        };
      },
      async requestUpgrade() {
        return { status: 'unavailable', reloadExpected: false };
      },
    },
    presentation: {
      async getLaunchIntent() {
        return { entry: 'home' };
      },
      async requestGameSurface() {
        return 'already-fullscreen';
      },
    },
    ...(sharing === undefined ? {} : { sharing }),
    notifications: {
      async getStatus() {
        return 'unsupported';
      },
      async requestSubscription() {
        return 'unavailable';
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        return { status: 'failed', entitlementIds: [] };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {
        throw unsupported('WECHAT_ADS_DISABLED', 'WeChat ads are disabled for this target.');
      },
      async showRewarded() {
        return { status: 'unavailable', rewardGranted: false };
      },
      async showInterstitial() {
        return { status: 'unavailable' };
      },
    },
    leaderboard: {
      async submitScore() {
        return { submitted: false };
      },
      async open() {
        throw unsupported(
          'WECHAT_LEADERBOARD_DISABLED',
          'WeChat leaderboard is disabled for this target.',
        );
      },
    },
    lifecycle: createWechatLifecycleAdapter(options.api),
    storage: createWechatStorageAdapter(options.api, options.storageKeyPrefix),
  };
}

function unsupported(code: string, message: string): PlatformOperationError {
  return new PlatformOperationError({ code, message, retryable: false });
}
