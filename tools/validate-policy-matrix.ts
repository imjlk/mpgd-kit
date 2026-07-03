import typia from 'typia';

import type { PolicyMatrix } from '@mpgd/policy-matrix';

import { isCliEntrypoint, readJsonFile } from './io';
import { assertPlatformTargetsConfig } from './target/schemas';

const assertPolicyMatrix = typia.createAssert<PolicyMatrix>();

export function validatePolicyMatrixFile(
  path = 'packages/policy-matrix/policy.json',
  targetsPath = 'platform.targets.json',
) {
  const policy = assertPolicyMatrix(readJsonFile(path));
  const targetConfig = assertPlatformTargetsConfig(readJsonFile(targetsPath));

  for (const [target, entry] of Object.entries(policy.targets)) {
    if (!entry.iap && (entry.rewardedAds || entry.interstitialAds)) {
      throw new Error(`Target ${target} enables ads while iap is disabled; review policy.`);
    }
  }

  for (const target of Object.keys(targetConfig.targets)) {
    if (policy.targets[target] === undefined) {
      throw new Error(`Missing policy target for configured platform target: ${target}`);
    }
  }

  for (const target of Object.keys(policy.targets)) {
    if (targetConfig.targets[target] === undefined) {
      throw new Error(`Policy target is not configured in platform.targets.json: ${target}`);
    }
  }

  return policy;
}

if (isCliEntrypoint(import.meta.url)) {
  const policy = validatePolicyMatrixFile();
  console.log(`Policy matrix ${policy.version}: ${Object.keys(policy.targets).length} targets`);
}
