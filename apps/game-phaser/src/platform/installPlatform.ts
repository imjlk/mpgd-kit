import type { AdPlacements } from '@mpgd/ad-placements';
import adPlacementsJson from '@mpgd/ad-placements/placements.json';
import type { PlatformGateway } from '@mpgd/platform-contract';
import {
  getTargetPolicy,
  policyTargetForPlatform,
  withPolicyEnforcement,
  type PolicyMatrix,
} from '@mpgd/policy-matrix';
import policyMatrixJson from '@mpgd/policy-matrix/policy.json';

import type { RuntimeConfig } from './runtimeDetector';

const policyMatrix = policyMatrixJson as PolicyMatrix;
const adPlacements = adPlacementsJson as AdPlacements;
const adPlacementTypes = new Map<string, 'rewarded' | 'interstitial'>(
  adPlacements.placements.map((placement) => [placement.id, placement.type]),
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
      const { createAitPlatformGateway } = await import('@mpgd/adapter-ait');
      gateway = createAitPlatformGateway({
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
      });
      break;
    }

    default: {
      const { createBrowserPlatformGateway } = await import('@mpgd/adapter-browser');
      gateway = createBrowserPlatformGateway();
    }
  }

  return withPolicyEnforcement(
    gateway,
    getTargetPolicy(policyMatrix, policyTargetForPlatform(runtime.target)),
    {
      resolveAdPlacementType(placementId) {
        return adPlacementTypes.get(placementId);
      },
    },
  );
}
