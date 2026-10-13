import {
  createCapacitorPlatformGateway,
  type CapacitorServiceProvider,
} from '@mpgd/adapter-capacitor';
import {
  createCapacitorPlayBillingServiceProvider,
  type PlayBillingCommerceProductMapping,
} from '@mpgd/capacitor-play-billing';
import type { ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import type { PlatformGateway } from '@mpgd/platform';

import { resolvePlayBillingAccountBinding } from '../commerceAccountBinding';
import { resolveStarterStoreProducts } from '../commerceProducts';
import type { RuntimeConfig } from '../runtimeDetector';

const productCatalog = productCatalogJson as ProductCatalog;

/**
 * Android gateway with the Google Play Billing commerce v2 service provider
 * (`@mpgd/capacitor-play-billing`) registered for the catalog products that
 * name a Play SKU. The provider serves the `commerce.v2.*` and v1 `commerce.*`
 * bridge methods and never grants: the game-services reconciler verifies each
 * purchase through the backend ledger. A shell built without the native
 * plugin (`mpgd target init capacitor --providers play-billing` installs it)
 * still runs; the store then answers `configuration-required`.
 */
export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  let gateway: PlatformGateway | undefined;
  const providers = createStoreProviders(runtime, () => gateway);
  gateway = createCapacitorPlatformGateway({
    target: 'android',
    appVersion: runtime.appVersion,
    buildId: runtime.buildId,
    providers,
  });
  return gateway;
}

function createStoreProviders(
  runtime: RuntimeConfig,
  resolveGateway: () => PlatformGateway | undefined,
): readonly CapacitorServiceProvider[] {
  // Play sells one-time products only (RFC D-02); a subscription stays off the store.
  const products = resolveStarterStoreProducts(productCatalog, runtime.configTarget)
    .flatMap((product): PlayBillingCommerceProductMapping[] =>
      product.kind === 'subscription' ? [] : [{ ...product, kind: product.kind }]);
  if (products.length === 0) {
    return [];
  }
  return [
    createCapacitorPlayBillingServiceProvider({
      products,
      // The backend's resolveObfuscatedAccountId must derive the same value; see commerceAccountBinding.ts.
      accountBinding: async () => {
        const gateway = resolveGateway();
        return gateway === undefined ? undefined : resolvePlayBillingAccountBinding(gateway);
      },
    }),
  ];
}
