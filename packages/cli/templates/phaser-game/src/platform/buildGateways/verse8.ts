import {
  createVerse8CommerceProducts,
  createVerse8PlatformGateway,
  type Verse8CommerceOptions,
} from '@mpgd/adapter-verse8';
import {
  resolveAdPlacementPlatformId,
  type AdPlacements,
  type ProductCatalog,
} from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';
import { resolveStarterVerse8Agent8Client } from '../verse8Agent8Client';

const productCatalog = productCatalogJson as ProductCatalog;

/**
 * Verse8 gateway. VXShop and the commerce v2 provider are installed only when
 * the game provides its authenticated Agent8 client (`verse8Agent8Client.ts`)
 * and the catalog names VXShop product ids (`platformProductIds.verse8`):
 * `vxShop.purchases` reads the purchases the Agent8 server recorded, which is
 * the server-push lookup the reconciler verifies through the backend ledger.
 * The VXShop dialog callback never grants.
 */
export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  const adPlacements = adPlacementsJson as AdPlacements;
  const placementIds = new Map(
    adPlacements.placements.flatMap((placement) => {
      const platformPlacementId = resolveAdPlacementPlatformId(
        placement,
        runtime.configTarget,
      );

      return platformPlacementId === undefined
        ? []
        : [[placement.id, platformPlacementId] as const];
    }),
  );
  const vxShop = createVxShopOptions(runtime);

  return createVerse8PlatformGateway({
    resolveAdPlacementId(placementId) {
      return placementIds.get(placementId);
    },
    ...(vxShop === undefined ? {} : { vxShop }),
  });
}

function createVxShopOptions(runtime: RuntimeConfig): Verse8CommerceOptions | undefined {
  const agent8 = resolveStarterVerse8Agent8Client();
  const products = createVerse8CommerceProducts(productCatalog, runtime.configTarget);
  if (agent8 === undefined || products.length === 0) {
    return undefined;
  }
  return {
    purchaseEventAuthority: 'agent8-server',
    products,
    loadEntitlements: async () => (await agent8.getCommerceSnapshot()).entitlements,
    purchases: {
      listPurchases: () => agent8.listPurchases(),
    },
  };
}
