import type { AdPlacements } from '@mpgd/ad-placements';
import adPlacementsJson from '@mpgd/ad-placements/placements.json';
import type { PlatformGateway } from '@mpgd/platform-contract';
import type { ProductCatalog } from '@mpgd/product-catalog';
import productCatalogJson from '@mpgd/product-catalog/catalog.json';
import {
  createEffectiveTargetConfig,
  getTargetConfig,
  targetConfigKeyForPlatform,
  withTargetAvailability,
  type TargetConfigMatrix,
} from '@mpgd/target-config';
import targetConfigMatrixJson from '@mpgd/target-config/targets.json';

import type { RuntimeConfig } from './runtimeDetector';

const targetConfigMatrix = targetConfigMatrixJson as TargetConfigMatrix;
const adPlacements = adPlacementsJson as AdPlacements;
const productCatalog = productCatalogJson as ProductCatalog;
const targetAdPlacements = adPlacements.placements.map((placement) => ({
  id: placement.id,
  type: placement.type,
}));
const adPlacementTypes = new Map<string, 'rewarded' | 'interstitial'>(
  targetAdPlacements.map((placement) => [placement.id, placement.type]),
);

export async function installPlatform(runtime: RuntimeConfig): Promise<PlatformGateway> {
  let gateway: PlatformGateway;

  switch (runtime.target) {
    case 'android':
    case 'ios': {
      const { createCapacitorPlatformGateway } = await import('@mpgd/adapter-capacitor');
      gateway = createCapacitorPlatformGateway({
        target: runtime.target,
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
      });
      break;
    }

    case 'ait': {
      const { createAitPlatformGateway, createAitSandboxBridge } = await import(
        '@mpgd/adapter-ait'
      );
      gateway = createAitPlatformGateway({
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
        ...(runtime.debug ? { fallbackBridge: createAitSandboxBridge() } : {}),
      });
      break;
    }

    default: {
      const { createBrowserPlatformGateway } = await import('@mpgd/adapter-browser');
      gateway = createBrowserPlatformGateway();
    }
  }

  const configTarget = targetConfigKeyForPlatform(runtime.target);
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
