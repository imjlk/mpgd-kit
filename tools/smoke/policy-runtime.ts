import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import type { AdPlacements } from '../../packages/ad-placements/src/index';
import {
  getTargetPolicy,
  isPolicyEnforcedGateway,
  policyTargetForPlatform,
  withPolicyEnforcement,
  type PolicyMatrix,
} from '../../packages/policy-matrix/src/runtime';
import { readJsonFile } from '../io';

const policyMatrix = readJsonFile('packages/policy-matrix/policy.json') as PolicyMatrix;
const adPlacements = readJsonFile('packages/ad-placements/placements.json') as AdPlacements;
const policyTarget = policyTargetForPlatform('browser');
const policy = getTargetPolicy(policyMatrix, policyTarget);
const gateway = withPolicyEnforcement(createBrowserPlatformGateway(), policy, {
  policyTarget,
  adPlacements: adPlacements.placements.map((placement) => ({
    id: placement.id,
    type: placement.type,
  })),
  resolveAdPlacementType(placementId) {
    return adPlacements.placements.find((placement) => placement.id === placementId)?.type;
  },
});

assertEqual(isPolicyEnforcedGateway(gateway), true, 'gateway should expose policy runtime');

const runtime = await gateway.getPolicyRuntime();

assertEqual(runtime.policyTarget, 'web-preview', 'browser should map to web-preview policy');
assertEqual(runtime.features.iap.reason, 'policy-disabled', 'IAP should be policy-disabled');
assertEqual(
  runtime.features.rewardedAds.reason,
  'policy-disabled',
  'rewarded ads should be policy-disabled',
);
assertEqual(
  runtime.features.interstitialAds.reason,
  'policy-disabled',
  'interstitial ads should be policy-disabled',
);
assertEqual(
  runtime.features.leaderboard.reason,
  'policy-disabled',
  'leaderboard should be policy-disabled',
);
assertEqual(runtime.capabilities.rewardedAds, false, 'rewarded capability should be clamped');
assertEqual(
  runtime.adPlacements.every((placement) => !placement.enabled),
  true,
  'all web-preview ad placements should be disabled',
);
assertDeepEqual(await gateway.commerce.getProducts(), [], 'IAP products should be hidden');
assertDeepEqual(
  await gateway.ads.showRewarded({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'policy-smoke-reward',
  }),
  {
    status: 'unavailable',
    rewardGranted: false,
  },
  'rewarded ad should be unavailable',
);
assertDeepEqual(
  await gateway.leaderboard.submitScore({
    leaderboardId: 'default',
    score: 1,
    runId: 'policy-smoke',
    submittedAt: new Date().toISOString(),
  }),
  {
    submitted: false,
  },
  'leaderboard submit should be disabled',
);

console.log(`Policy runtime smoke passed: ${runtime.policyTarget}`);

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
