import { createBrowserPlatformGateway } from '@mpgd/adapter-browser';
import {
  createMicrosoftStoreCommerceProvider,
  withMicrosoftStoreCommerceProvider,
  type MicrosoftStoreCommerceProduct,
} from '@mpgd/adapter-browser/microsoft-store';
import { resolveProductPlatformId, type ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

const productCatalog = productCatalogJson as ProductCatalog;
const browser = createBrowserPlatformGateway();
const base: PlatformGateway = { ...browser, target: 'microsoft-store' };

/**
 * Microsoft Store products from the catalog: the Partner Center add-on
 * product id is `platformProductIds['microsoft-store']`, and the Digital
 * Goods API currently sells consumables only. Title, description, and price
 * are replaced by the Store's own details when the catalog loads.
 */
function resolveMicrosoftStoreProducts(target: string): readonly MicrosoftStoreCommerceProduct[] {
  return productCatalog.products.flatMap((product) => {
    const inAppOfferToken = resolveProductPlatformId(product, target);
    return inAppOfferToken === undefined || product.type !== 'consumable'
      ? []
      : [
          {
            info: {
              id: product.id,
              type: product.type,
              title: product.id,
              description: '',
              price: { formatted: '', currencyCode: 'USD' },
            },
            inAppOfferToken,
          },
        ];
  });
}

/**
 * Commerce over the Digital Goods path (`createMicrosoftStoreCommerceProvider`)
 * installed as `gateway.commerce` with its capability block. The purchase authority stays
 * `configuration-required` until the game points it at its backend: the
 * authority's ledger entry is the only settlement, and the reconciler still
 * verifies it through game-services before anything is granted.
 */
export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  const commerce = createMicrosoftStoreCommerceProvider({
    getRecoveryScope: () => 'configuration-required',
    products: resolveMicrosoftStoreProducts(runtime.configTarget),
    authority: {
      async getAvailability() {
        return 'configuration-required';
      },
      async claimRecoveryOwnership() {
        return { status: 'denied' } as const;
      },
      async hasRecoveryOwnership() {
        return { status: 'denied' } as const;
      },
      async verifyAndGrant() {
        return { status: 'failed' };
      },
    },
  });
  return withMicrosoftStoreCommerceProvider(base, commerce);
}
