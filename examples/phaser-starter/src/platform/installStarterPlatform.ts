import type { AdPlacements } from '@mpgd/ad-placements';
import adPlacementsJson from '@mpgd/ad-placements/placements.json';
import { createBrowserPlatformGateway } from '@mpgd/adapter-browser';
import type { ProductCatalog } from '@mpgd/product-catalog';
import productCatalogJson from '@mpgd/product-catalog/catalog.json';
import {
  createEffectiveTargetConfig,
  getTargetConfig,
  targetConfigKeyForPlatform,
  withTargetAvailability,
  type TargetConfigMatrix,
  type TargetConfiguredGateway,
} from '@mpgd/target-config';
import targetConfigMatrixJson from '@mpgd/target-config/targets.json';

const targetConfigMatrix = targetConfigMatrixJson as TargetConfigMatrix;
const productCatalog = productCatalogJson as ProductCatalog;
const adPlacements = adPlacementsJson as AdPlacements;
const targetAdPlacements = adPlacements.placements.map((placement) => ({
  id: placement.id,
  type: placement.type,
}));
const adPlacementTypes = new Map<string, 'rewarded' | 'interstitial'>(
  targetAdPlacements.map((placement) => [placement.id, placement.type]),
);

export function installStarterPlatform(): TargetConfiguredGateway {
  const gateway = createBrowserPlatformGateway();
  const configTarget = targetConfigKeyForPlatform(gateway.target);
  const targetConfig = getTargetConfig(targetConfigMatrix, configTarget);
  const effectiveConfig = createEffectiveTargetConfig({
    target: configTarget,
    targetConfigVersion: targetConfigMatrix.version,
    config: targetConfig,
    catalog: productCatalog,
    adPlacements,
  });

  return withTargetAvailability(gateway, targetConfig, {
    configTarget,
    effectiveConfig,
    adPlacements: targetAdPlacements,
    resolveAdPlacementType(placementId) {
      return adPlacementTypes.get(placementId);
    },
  });
}
