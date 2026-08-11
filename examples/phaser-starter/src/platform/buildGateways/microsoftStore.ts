import { createBrowserPlatformGateway } from '@mpgd/adapter-browser';
import {
  createMicrosoftStoreCommerceAdapter,
  withMicrosoftStoreCommerceAdapter,
} from '@mpgd/adapter-browser/microsoft-store';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

const browser = createBrowserPlatformGateway();
const base: PlatformGateway = { ...browser, target: 'microsoft-store' };
const commerce = createMicrosoftStoreCommerceAdapter({
  getRecoveryScope: () => 'configuration-required',
  products: [],
  authority: {
    async getAvailability() {
      return 'configuration-required';
    },
    async claimRecoveryOwnership() {
      return false;
    },
    async hasRecoveryOwnership() {
      return false;
    },
    async verifyAndGrant() {
      return { status: 'failed' };
    },
    async getEntitlements() {
      return [];
    },
  },
});

/** Configure Store products, authenticated recovery scope, and authority before checkout. */
export async function createBuildGateway(_runtime: RuntimeConfig): Promise<PlatformGateway> {
  return withMicrosoftStoreCommerceAdapter(base, commerce);
}
