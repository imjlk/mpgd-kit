import { createMicrosoftStoreCommerceAdapter, withMicrosoftStoreCommerceAdapter } from '@mpgd/adapter-microsoft-store';
import { createBrowserPlatformGateway } from '@mpgd/adapter-browser';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

const browser = createBrowserPlatformGateway();
const base: PlatformGateway = { ...browser, target: 'microsoft-store' };
const commerce = createMicrosoftStoreCommerceAdapter({
  products: [],
  authority: {
    async getAvailability() {
      return 'configuration-required';
    },
    async verifyAndGrant() {
      return { status: 'failed' };
    },
    async getEntitlements() {
      return [];
    },
  },
});

/** Configure Store products and a game-owned authority before enabling checkout. */
export async function createBuildGateway(_runtime: RuntimeConfig): Promise<PlatformGateway> {
  return withMicrosoftStoreCommerceAdapter(base, commerce);
}
