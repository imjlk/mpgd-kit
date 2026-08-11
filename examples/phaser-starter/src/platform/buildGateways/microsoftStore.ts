import { createMicrosoftStoreCommerceAdapter, withMicrosoftStoreCommerceAdapter } from '@mpgd/adapter-microsoft-store';
import { createBrowserPlatformGateway } from '@mpgd/adapter-browser';
import type { PlatformGateway } from '@mpgd/platform';

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

export function createPlatformGateway(): PlatformGateway {
  return withMicrosoftStoreCommerceAdapter(base, commerce);
}
