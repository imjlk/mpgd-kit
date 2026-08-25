import type { TargetConfig } from '@mpgd/target-config';

import { isCliEntrypoint, readJsonFile } from './io';
import {
  assertPlatformTargetsConfigShape,
  platformTargetsFilePath,
} from './target/platform-targets';
import {
  defaultTargetConfigMatrixFile,
  loadTargetConfigMatrix,
} from './target/target-config-matrix';

export function validateTargetConfigMatrixFile(
  path = defaultTargetConfigMatrixFile,
  targetsPath = platformTargetsFilePath(),
) {
  const configMatrix = loadTargetConfigMatrix(path);
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
    // bannerAds is optional in legacy matrices; normalize absence to false.
    [
      'monetization.bannerAds',
      config.monetization.bannerAds === true,
      config.features.bannerAds === true,
    ],
    ['monetization.rewardedAds', config.monetization.rewardedAds, config.features.rewardedAds],
    [
      'monetization.interstitialAds',
      config.monetization.interstitialAds,
      config.features.interstitialAds,
    ],
    ['capabilities.localization', config.capabilities.localization, config.features.localization],
  ].filter(([, sectionValue, featureValue]) => sectionValue !== featureValue);

  // A target may expose a Game Services leaderboard without a native platform
  // leaderboard. Native support still implies that the feature must be enabled.
  if (config.leaderboard.native && !config.features.leaderboard) {
    mismatches.push(['leaderboard.native', config.leaderboard.native, config.features.leaderboard]);
  }

  if (mismatches.length > 0) {
    const names = mismatches.map(([name]) => name).join(', ');
    throw new Error(`Target ${target} has feature availability mismatches: ${names}`);
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
