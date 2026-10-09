import { createOnePlayPlatformGateway } from '@mpgd/adapter-browser/oneplay';
import { resolveAdPlacementPlatformId, type AdPlacements } from '@mpgd/catalog';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import type { PlatformGateway } from '@mpgd/platform';
import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  const placementIds = Object.fromEntries(
    (adPlacementsJson as AdPlacements).placements.flatMap((placement) => {
      const platformId = resolveAdPlacementPlatformId(placement, runtime.configTarget);
      return placement.type !== 'banner' && platformId !== undefined
        ? [[placement.id, { format: placement.type, platformId }]]
        : [];
    }),
  );
  return createOnePlayPlatformGateway({ placementIds });
}
