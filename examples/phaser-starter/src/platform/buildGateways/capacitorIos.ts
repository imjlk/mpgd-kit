import {
  createCapacitorPlatformGateway,
  type CapacitorServiceProvider,
} from '@mpgd/adapter-capacitor';
import { createCapacitorStoreKitServiceProvider } from '@mpgd/capacitor-storekit';
import type { ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import type { PlatformGateway } from '@mpgd/platform';

import { resolveStoreKitAppAccountToken } from '../commerceAccountBinding';
import { resolveStarterStoreProducts } from '../commerceProducts';
import type { RuntimeConfig } from '../runtimeDetector';

const productCatalog = productCatalogJson as ProductCatalog;

/**
 * iOS gateway with the StoreKit commerce v2 service provider
 * (`@mpgd/capacitor-storekit`) registered for the catalog products that name
 * an App Store product id. The provider serves the `commerce.v2.*` and v1
 * `commerce.*` bridge methods and never grants or finishes on its own: the
 * game-services reconciler verifies the signed transaction through the
 * backend ledger and only then finishes it. A shell built without the native
 * plugin (`mpgd target init capacitor --providers storekit` installs it)
 * still runs; the store then answers `configuration-required`.
 */
export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  let gateway: PlatformGateway | undefined;
  const providers = createStoreProviders(runtime, () => gateway);
  gateway = createCapacitorPlatformGateway({
    target: 'ios',
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
  // StoreKit sells one-time products only (RFC D-02); a subscription stays off the store.
  const products = resolveStarterStoreProducts(productCatalog, runtime.configTarget)
    .filter((product) => product.kind !== 'subscription');
  if (products.length === 0) {
    return [];
  }
  return [
    createCapacitorStoreKitServiceProvider({
      products,
      // Sales switch (none by default): to refuse NEW purchases without
      // touching recovery, add `purchaseGate: async () => ({ allowed })`,
      // `allowed` read from the game's own server flag. A refusal answers
      // ITEM_UNAVAILABLE / PURCHASES_PAUSED before the store opens; paid
      // purchases keep reconciling. See the adapter-capacitor README.
      // The backend's resolveAppAccountToken must derive the same value; see commerceAccountBinding.ts.
      getAppAccountToken: async () => {
        const gateway = resolveGateway();
        if (gateway === undefined) {
          throw new Error('The iOS gateway is not ready for a StoreKit purchase.');
        }
        return resolveStoreKitAppAccountToken(gateway);
      },
    }),
  ];
}
