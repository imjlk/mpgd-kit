import type { AdAdapter } from '@mpgd/platform';

/**
 * An ad adapter that never shows an ad and never reports a granted reward.
 * Browser-based gateways (web preview, Microsoft Store PWA) have no ad SDK, so
 * they must not hand consumers a grant-shaped `RewardedAdResult`.
 */
export function createUnavailableAdAdapter(): AdAdapter {
  return {
    async preload() {},
    async showRewarded() {
      return {
        status: 'unavailable',
        rewardGranted: false,
      };
    },
    async showInterstitial() {
      return {
        status: 'unavailable',
      };
    },
  };
}
