import { createBuildGateway } from '#mpgd-platform-gateway';

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import {
  createEffectiveTargetConfig,
  getTargetConfig,
  targetConfigKeyForPlatform,
  withTargetAvailability,
  type TargetConfigMatrix,
  type TargetConfiguredGateway,
} from '@mpgd/target-config';
import targetConfigMatrixJson from '@mpgd/target-config/targets.json';

import type { RuntimeConfig } from './runtimeDetector';

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

export async function installPlatform(runtime: RuntimeConfig): Promise<TargetConfiguredGateway> {
  const gateway = await createBuildGateway(runtime);
  const configTarget = runtime.configTarget || targetConfigKeyForPlatform(runtime.target);
  const targetConfig = getTargetConfig(targetConfigMatrix, configTarget);
  const effectiveConfig = createEffectiveTargetConfig({
    target: configTarget,
    targetConfigVersion: targetConfigMatrix.version,
    config: targetConfig,
    catalog: productCatalog,
    adPlacements,
    ...(__MPGD_PLATFORM_TARGET__ === undefined
      ? {}
      : { platformTarget: __MPGD_PLATFORM_TARGET__ }),
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
