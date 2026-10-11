import type { PlatformGateway } from '@mpgd/platform';

import {
  createMicrosoftStoreCommerceEngine,
  type CreateMicrosoftStoreCommerceAdapterInput,
  type MicrosoftStoreCommerceAdapter,
  type MicrosoftStoreCommerceGatewayOptions,
} from './microsoft-store-core.js';
import { createUnavailableAdAdapter } from './unavailable-ads.js';

export {
  microsoftStoreBillingMethod,
  microsoftStoreDigitalGoodsEvidenceSchema,
  type CreateMicrosoftStoreCommerceAdapterInput,
  type MicrosoftStoreCommerceAdapter,
  type MicrosoftStoreCommerceAvailability,
  type MicrosoftStoreCommerceGatewayOptions,
  type MicrosoftStoreCommerceOutcomeCode,
  type MicrosoftStoreCommerceProduct,
  type MicrosoftStoreDigitalGoodsItem,
  type MicrosoftStoreDigitalGoodsPrice,
  type MicrosoftStoreDigitalGoodsPurchase,
  type MicrosoftStoreDigitalGoodsService,
  type MicrosoftStorePaymentRequest,
  type MicrosoftStorePaymentResponse,
  type MicrosoftStorePurchaseAuthority,
  type MicrosoftStorePurchaseAuthorityInput,
  type MicrosoftStorePurchaseAuthorityResult,
  type MicrosoftStoreRecoveryAuthorityInput,
  type MicrosoftStoreRecoveryAuthorityResult,
  type MicrosoftStoreRecoveryIdStorage,
} from './microsoft-store-core.js';
export {
  createMicrosoftStoreCommerceProvider,
  microsoftStoreCommerceErrorCodeMap,
  withMicrosoftStoreCommerceProvider,
  type CreateMicrosoftStoreCommerceProviderInput,
  type MicrosoftStoreCommerceProvider,
} from './microsoft-store-commerce-provider.js';

/**
 * v1 `CommerceAdapter` over the Digital Goods path. The checkout, recovery,
 * and authority flow lives in the shared engine; the commerce v2
 * `createMicrosoftStoreCommerceProvider` runs the same engine.
 */
export function createMicrosoftStoreCommerceAdapter(
  input: CreateMicrosoftStoreCommerceAdapterInput,
): MicrosoftStoreCommerceAdapter {
  const engine = createMicrosoftStoreCommerceEngine(input);

  return {
    getAvailability: engine.getAvailability,
    async getProducts() {
      const catalog = await engine.loadCatalog();
      return catalog.status === 'loaded' ? catalog.entries.map((entry) => entry.info) : [];
    },
    async purchase(request) {
      return (await engine.checkout(request)).result;
    },
    async restore() {
      return (await engine.restore()).result;
    },
    getEntitlements: engine.getEntitlements,
  };
}

export function withMicrosoftStoreCommerceAdapter(
  gateway: PlatformGateway,
  commerce: MicrosoftStoreCommerceAdapter,
  options: MicrosoftStoreCommerceGatewayOptions = {},
): PlatformGateway {
  if (gateway.target !== 'microsoft-store') {
    throw new TypeError(
      'Microsoft Store commerce can only be installed on a microsoft-store gateway.',
    );
  }
  if ('getTargetRuntime' in gateway && typeof gateway.getTargetRuntime === 'function') {
    throw new TypeError(
      'Microsoft Store commerce must be installed before target availability is applied.',
    );
  }

  // Microsoft Store builds reuse the browser gateway as a base. That base has
  // no ad SDK, so its ads surface is replaced wholesale: the Store build must
  // never expose a mock reward that looks like a ledger grant.
  return {
    ...gateway,
    async getCapabilities() {
      const [availability, capabilities] = await Promise.all([
        commerce.getAvailability(),
        gateway.getCapabilities(),
      ]);
      return {
        ...capabilities,
        nativeIap: availability === 'available',
        nativeAds: false,
        rewardedAds: false,
        interstitialAds: false,
        remoteLeaderboard:
          capabilities.remoteLeaderboard || options.remoteLeaderboard === true,
      };
    },
    commerce,
    ads: createUnavailableAdAdapter(),
  };
}
