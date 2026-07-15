import typia from 'typia';

import type { TargetConfig, TargetConfigMatrix } from '@mpgd/target-config';

import { isCliEntrypoint, readJsonFile } from './io';
import {
  assertPlatformTargetsConfigShape,
  platformTargetsFilePath,
} from './target/platform-targets';

const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();

export function validateTargetConfigMatrixFile(
  path = 'packages/target-config/targets.json',
  targetsPath = platformTargetsFilePath(),
) {
  const configMatrix = assertTargetConfigMatrix(readJsonFile(path));
  const platformTargets = assertPlatformTargetsConfigShape(readJsonFile(targetsPath));
  const targets = readTargetFilterFromEnv('MPGD_TARGET_CONFIG_TARGETS');
  const validationTargets = targets ?? Object.keys(platformTargets.targets);

  for (const target of validationTargets) {
    const config = configMatrix.targets[target];

    if (config === undefined) {
      throw new Error(`Missing target config for target: ${target}`);
    }

    validateTargetConfigConsistency(target, config);
  }

  for (const target of validationTargets) {
    if (platformTargets.targets[target] === undefined) {
      throw new Error(`Target config is not configured in the target build config: ${target}`);
    }
  }

  return configMatrix;
}

function readTargetFilterFromEnv(name: string): readonly string[] | undefined {
  const raw = process.env[name];

  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  return raw
    .split(',')
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
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
