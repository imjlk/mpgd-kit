import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import type { PlatformGateway } from '@mpgd/platform';
import productCatalogJson from '@mpgd/catalog/catalog.json';
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

const devvitSandboxBuildId = 'devvit-sandbox';
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

export async function installStarterPlatform(
  runtime: RuntimeConfig,
): Promise<TargetConfiguredGateway> {
  const gateway = await createPlatformGateway(runtime);
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

async function createPlatformGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  try {
    switch (runtime.target) {
    case 'android':
    case 'ios': {
      const { createCapacitorPlatformGateway } = await import('@mpgd/adapter-capacitor');
      return createCapacitorPlatformGateway({
        target: runtime.target,
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
      });
    }

    case 'ait': {
      const { createAitPlatformGateway, createAitSandboxBridge } = await import(
        '@mpgd/adapter-ait'
      );
      return createAitPlatformGateway({
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
        ...(runtime.debug ? { fallbackBridge: createAitSandboxBridge() } : {}),
      });
    }

    case 'reddit': {
      const { createDevvitPlatformGateway, createDevvitSandboxBridge } = await import(
        '@mpgd/adapter-devvit'
      );
      return createDevvitPlatformGateway({
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
        ...(shouldUseDevvitSandbox(runtime) ? { fallbackBridge: createDevvitSandboxBridge() } : {}),
      });
    }

    default: {
      const { createBrowserPlatformGateway } = await import('@mpgd/adapter-browser');
      return createBrowserPlatformGateway();
    }
  }
  } catch (error) {
    throw new Error(
      `Failed to initialize platform gateway for target "${runtime.target}": ${formatError(error)}`,
    );
  }
}

function shouldUseDevvitSandbox(runtime: RuntimeConfig): boolean {
  return runtime.debug && runtime.buildId === devvitSandboxBuildId;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
