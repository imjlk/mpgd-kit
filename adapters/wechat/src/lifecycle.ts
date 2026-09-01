import { PlatformOperationError, type LifecycleAdapter } from '@mpgd/platform';

import type { WechatMiniGameApi, WechatMiniGameLifecycleListener } from './api.js';

export function createWechatLifecycleAdapter(api: WechatMiniGameApi): LifecycleAdapter {
  return {
    onPause(callback) {
      return subscribeLifecycle(api.onHide.bind(api), api.offHide.bind(api), callback, 'hide');
    },
    onResume(callback) {
      return subscribeLifecycle(api.onShow.bind(api), api.offShow.bind(api), callback, 'show');
    },
  };
}

function subscribeLifecycle(
  subscribe: (listener: WechatMiniGameLifecycleListener) => void,
  unsubscribe: (listener: WechatMiniGameLifecycleListener) => void,
  callback: () => void,
  event: 'hide' | 'show',
): () => void {
  let active = true;
  const listener = () => {
    if (active) {
      callback();
    }
  };

  try {
    subscribe(listener);
  } catch {
    active = false;

    try {
      unsubscribe(listener);
    } catch {
      // A partially registered native listener remains inert through the active guard.
    }
    throw new PlatformOperationError({
      code: 'WECHAT_LIFECYCLE_SUBSCRIBE_FAILED',
      message: `Failed to subscribe to the WeChat Mini Game ${event} event.`,
      retryable: false,
    });
  }

  return () => {
    if (!active) {
      return;
    }
    active = false;

    try {
      unsubscribe(listener);
    } catch (error) {
      try {
        console.error(`Failed to unsubscribe from the WeChat Mini Game ${event} event.`, error);
      } catch {
        // Cleanup remains terminal when host logging is unavailable.
      }
    }
  };
}
