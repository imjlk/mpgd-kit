import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import type { PlatformGateway } from '@mpgd/platform';
import {
  createEffectiveTargetConfig,
  getTargetConfig,
  targetConfigKeyForPlatform,
  withTargetAvailability,
  type TargetConfigMatrix,
} from '@mpgd/target-config';
import targetConfigMatrixJson from '@mpgd/target-config/targets.json';

import type { RuntimeConfig } from './runtimeDetector';

const devvitSandboxBuildId = 'devvit-sandbox';
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

    case 'reddit': {
      const { createDevvitPlatformGateway, createDevvitSandboxBridge } = await import(
        '@mpgd/adapter-devvit'
      );
      gateway = createDevvitPlatformGateway({
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
        ...(shouldUseDevvitSandbox(runtime) ? { fallbackBridge: createDevvitSandboxBridge() } : {}),
      });
      break;
    }

    default: {
      const { createBrowserPlatformGateway } = await import('@mpgd/adapter-browser');
      gateway = createBrowserPlatformGateway();
    }
  }

  const configTarget = runtime.configTarget || targetConfigKeyForPlatform(runtime.target);
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

function shouldUseDevvitSandbox(runtime: RuntimeConfig): boolean {
  return runtime.debug && runtime.buildId === devvitSandboxBuildId;
}
