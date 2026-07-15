import { createVerse8PlatformGateway } from '@mpgd/adapter-verse8';
import type { AdPlacements } from '@mpgd/catalog';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(_runtime: RuntimeConfig): Promise<PlatformGateway> {
  const adPlacements = adPlacementsJson as AdPlacements;
  const placementIds = new Map(
    adPlacements.placements.flatMap((placement) => {
      const platformPlacementId = placement.platformPlacementIds.verse8;

      return platformPlacementId === undefined
        ? []
        : [[placement.id, platformPlacementId] as const];
    }),
  );

  return createVerse8PlatformGateway({
    resolveAdPlacementId(placementId) {
      return placementIds.get(placementId);
    },
  });
}
