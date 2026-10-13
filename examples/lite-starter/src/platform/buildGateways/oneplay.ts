import {
  createOnePlayPlatformGateway,
  type OnePlayGatewayOptions,
} from '@mpgd/adapter-browser/oneplay';
import {
  resolveAdPlacementPlatformId,
  resolveProductPlatformId,
  type AdPlacements,
  type ProductCatalog,
} from '@mpgd/catalog';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import type { PlatformGateway } from '@mpgd/platform';
import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(runtime: RuntimeConfig, ports: Pick<OnePlayGatewayOptions, 'rewardRequests' | 'commerceServer'> = {}): Promise<PlatformGateway> {
  const placementIds = Object.fromEntries(
    (adPlacementsJson as AdPlacements).placements.flatMap((placement) => {
      const platformId = resolveAdPlacementPlatformId(placement, runtime.configTarget);
      return placement.type !== 'banner' && platformId !== undefined
        ? [[placement.id, { format: placement.type, platformId }]]
        : [];
    }),
  );
  const products = (productCatalogJson as ProductCatalog).products.flatMap((product) => {
    const platformId = resolveProductPlatformId(product, runtime.configTarget);
    return product.type !== 'subscription' && platformId !== undefined
      ? [{ id: product.id, platformId, type: product.type }]
      : [];
  });
  return createOnePlayPlatformGateway({ ...ports, placementIds, products });
}
