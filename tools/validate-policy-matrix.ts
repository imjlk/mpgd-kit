import typia from 'typia';

import type { PolicyMatrix } from '@mpgd/policy-matrix';

import { isCliEntrypoint, readJsonFile } from './io';

const assertPolicyMatrix = typia.createAssert<PolicyMatrix>();

export function validatePolicyMatrixFile(path = 'packages/policy-matrix/policy.json') {
  const policy = assertPolicyMatrix(readJsonFile(path));

  for (const [target, entry] of Object.entries(policy.targets)) {
    if (!entry.iap && (entry.rewardedAds || entry.interstitialAds)) {
      throw new Error(`Target ${target} enables ads while iap is disabled; review policy.`);
    }
  }

  return policy;
}

if (isCliEntrypoint(import.meta.url)) {
  const policy = validatePolicyMatrixFile();
  console.log(`Policy matrix ${policy.version}: ${Object.keys(policy.targets).length} targets`);
}
