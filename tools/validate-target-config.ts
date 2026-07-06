import typia from 'typia';

import type { TargetConfig, TargetConfigMatrix } from '@mpgd/target-config';

import { isCliEntrypoint, readJsonFile } from './io';
import { platformTargetsFilePath } from './target/platform-targets';
import { assertPlatformTargetsConfig } from './target/schemas';

const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();

export function validateTargetConfigMatrixFile(
  path = 'packages/target-config/targets.json',
  targetsPath = platformTargetsFilePath(),
) {
  const configMatrix = assertTargetConfigMatrix(readJsonFile(path));
  const platformTargets = assertPlatformTargetsConfig(readJsonFile(targetsPath));

  for (const [target, config] of Object.entries(configMatrix.targets)) {
    validateTargetConfigConsistency(target, config);
  }

  for (const target of Object.keys(platformTargets.targets)) {
    if (configMatrix.targets[target] === undefined) {
      throw new Error(`Missing target config for configured platform target: ${target}`);
    }
  }

  for (const target of Object.keys(configMatrix.targets)) {
    if (platformTargets.targets[target] === undefined) {
      throw new Error(`Target config is not configured in platform.targets.json: ${target}`);
    }
  }

  return configMatrix;
}

function validateTargetConfigConsistency(target: string, config: TargetConfig): void {
  const mismatches = [
    ['monetization.iap', config.monetization.iap, config.features.iap],
    ['monetization.rewardedAds', config.monetization.rewardedAds, config.features.rewardedAds],
    [
      'monetization.interstitialAds',
      config.monetization.interstitialAds,
      config.features.interstitialAds,
    ],
    ['leaderboard.native', config.leaderboard.native, config.features.leaderboard],
    ['capabilities.localization', config.capabilities.localization, config.features.localization],
  ].filter(([, sectionValue, featureValue]) => sectionValue !== featureValue);

  if (mismatches.length > 0) {
    const names = mismatches.map(([name]) => name).join(', ');
    throw new Error(`Target ${target} has feature availability mismatches: ${names}`);
  }

  if (!config.features.iap && (config.features.rewardedAds || config.features.interstitialAds)) {
    throw new Error(`Target ${target} enables ads while iap is disabled; review target config.`);
  }

  if (target === 'ait' && !config.policy.requiresAitReview) {
    throw new Error('AIT target must require AppsInToss review.');
  }

  if (
    (target === 'android' || target === 'ios' || target === 'microsoft-store')
    && !config.policy.requiresStoreReview
  ) {
    throw new Error(`Store target ${target} must require store review.`);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  const configMatrix = validateTargetConfigMatrixFile();
  console.log(
    `Target config ${configMatrix.version}: ${Object.keys(configMatrix.targets).length} targets`,
  );
}
