import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import typia from 'typia';

import {
  assertTargetIntegrationRuntimeBounds,
  type ReleaseProfile,
  type TargetConfig,
  type TargetConfigMatrix,
  type TargetRuntimeKind,
} from '@mpgd/target-config';

import { targetConfigExtensionsFileEnv } from '../../packages/cli/src/target-config-env';
import { assertDeploymentTargetName } from '../../packages/cli/src/target-name';
import { readJsonFile } from '../io';

export const defaultTargetConfigMatrixFile = 'packages/target-config/targets.json';
export { targetConfigExtensionsFileEnv };

interface TargetConfigExtensions {
  readonly schemaVersion: 1;
  readonly targets: Readonly<Record<string, TargetConfig>>;
}

const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();
const assertTargetConfigExtensions = typia.createAssert<TargetConfigExtensions>();
const supportedCustomTargetRuntimes = new Set<TargetRuntimeKind>([
  'web',
  'verse8-web',
  'web-preview',
]);
const webMonetizationFeatures = ['iap', 'bannerAds', 'rewardedAds', 'interstitialAds'] as const;
const releaseProfileByRuntime = {
  web: 'web',
  'web-preview': 'web-preview',
  'microsoft-store-pwa': 'microsoft-store',
  'capacitor-android': 'google-play',
  'capacitor-ios': 'app-store',
  'apps-in-toss': 'apps-in-toss',
  'devvit-web': 'devvit',
  'verse8-web': 'verse8',
} as const satisfies Record<TargetRuntimeKind, ReleaseProfile>;

export function loadTargetConfigMatrix(
  baseFile = defaultTargetConfigMatrixFile,
  extensionsFile = process.env[targetConfigExtensionsFileEnv],
): TargetConfigMatrix {
  const base = assertTargetConfigMatrix(readJsonFile(baseFile));

  if (extensionsFile === undefined || extensionsFile.trim().length === 0) {
    return base;
  }

  const normalizedExtensionsFile = extensionsFile.trim();
  const fileContent = readFileSync(normalizedExtensionsFile);
  const extensions = assertTargetConfigExtensions(
    JSON.parse(fileContent.toString('utf8')) as unknown,
  );
  const collisions = Object.keys(extensions.targets).filter(
    (target) => base.targets[target] !== undefined,
  );

  if (collisions.length > 0) {
    throw new Error(
      `Target config extensions cannot replace built-in targets: ${collisions.join(', ')}`,
    );
  }

  for (const [target, config] of Object.entries(extensions.targets)) {
    assertDeploymentTargetName(target);
    assertCustomTargetPolicy(target, config);
  }

  const digest = createHash('sha256').update(fileContent).digest('hex').slice(0, 16);

  return {
    version: `${base.version}+extensions.${digest}`,
    targets: {
      ...base.targets,
      ...extensions.targets,
    },
  };
}

function assertCustomTargetPolicy(target: string, config: TargetConfig): void {
  if (
    config.runtime === 'microsoft-store-pwa'
    || config.release.profile === 'microsoft-store'
  ) {
    throw new Error(
      `Target config extension ${target} cannot use the reserved Microsoft Store PWA runtime or release profile.`,
    );
  }

  if (!supportedCustomTargetRuntimes.has(config.runtime)) {
    throw new Error(
      `Target config extension ${target} cannot use non-web runtime ${config.runtime}.`,
    );
  }

  const expectedReleaseProfile = releaseProfileByRuntime[config.runtime];

  if (config.release.profile !== expectedReleaseProfile) {
    throw new Error(
      `Target config extension ${target} runtime ${config.runtime} requires release profile ${expectedReleaseProfile}; received ${config.release.profile}.`,
    );
  }

  if (config.capabilities.storage !== 'local') {
    throw new Error(
      `Target config extension ${target} runtime ${config.runtime} requires local storage; received ${config.capabilities.storage}.`,
    );
  }

  if (config.runtime === 'web') {
    for (const feature of webMonetizationFeatures) {
      if (config.features[feature] !== config.monetization[feature]) {
        throw new Error(
          `Target config extension ${target} must configure matching features.${feature} and monetization.${feature} values for web runtime.`,
        );
      }
    }
  }

  assertTargetIntegrationRuntimeBounds(
    config.runtime,
    config.integrations,
    `Target config extension ${target}`,
  );

  const unsupportedFeature = getUnsupportedCustomWebFeature(config);

  if (unsupportedFeature !== undefined) {
    throw new Error(
      `Target config extension ${target} cannot enable ${unsupportedFeature} for ${config.runtime} runtime.`,
    );
  }
}

function getUnsupportedCustomWebFeature(
  config: TargetConfig,
):
  | 'banner ads'
  | 'in-app purchases'
  | 'interstitial ads'
  | 'leaderboard'
  | 'rewarded ads'
  | undefined {
  if (
    config.runtime === 'web-preview'
    && (config.features.bannerAds === true || config.monetization.bannerAds === true)
  ) {
    return 'banner ads';
  }

  if (
    config.runtime === 'web-preview'
    && (config.features.iap || config.monetization.iap)
  ) {
    return 'in-app purchases';
  }

  if (
    config.runtime === 'web-preview'
    && (config.features.rewardedAds || config.monetization.rewardedAds)
  ) {
    return 'rewarded ads';
  }

  if (
    config.runtime === 'web-preview'
    && (config.features.interstitialAds || config.monetization.interstitialAds)
  ) {
    return 'interstitial ads';
  }

  if (
    config.runtime !== 'web'
    && (config.features.leaderboard || config.leaderboard.native)
  ) {
    return 'leaderboard';
  }

  return undefined;
}
