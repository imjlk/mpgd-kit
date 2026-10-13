import { createCrazyGamesPlatformGateway } from '@mpgd/adapter-browser/crazygames';
import { resolveAdPlacementPlatformId, type AdPlacements } from '@mpgd/catalog';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import type { PlatformGateway } from '@mpgd/platform';
import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  const placements = (adPlacementsJson as AdPlacements).placements;
  return createCrazyGamesPlatformGateway({
    launch: __MPGD_PLATFORM_TARGET__?.crazyGamesLaunch ?? 'basic',
    placementIds: placements.filter((placement) => placement.type === 'interstitial'
      && resolveAdPlacementPlatformId(placement, runtime.configTarget) !== undefined).map((placement) => placement.id),
  });
}
