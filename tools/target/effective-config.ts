import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';

import {
  createEffectiveTargetConfigMatrix,
  type EffectivePlatformTargetMetadata,
  type EffectiveTargetConfig,
  type EffectiveTargetConfigMatrix,
} from '../../packages/target-config/src/effective';
import type { TargetConfigMatrix } from '../../packages/target-config/src/runtime';
import { adPlacementsFilePath, productCatalogFilePath } from '../catalog-paths';
import { readJsonFile } from '../io';
import { loadPlatformTargetsConfig } from './platform-targets';
import type { PlatformTargetConfig, PlatformTargetsConfig } from './schemas';

export interface EffectiveTargetConfigArtifact {
  readonly target: string;
  readonly path: string;
  readonly digest: string;
  readonly version: string;
}

export const embeddedTargetConfigFileName = 'mpgd-effective-target.json';

export interface EffectiveTargetConfigArtifactIndex {
  readonly version: string;
  readonly artifacts: readonly EffectiveTargetConfigArtifact[];
}

export interface WriteEffectiveTargetConfigsOptions {
  readonly targets?: readonly string[];
  readonly outputDir?: string;
}

export function loadEffectiveTargetConfigMatrix(): EffectiveTargetConfigMatrix {
  const configMatrix = readJsonFile('packages/target-config/targets.json') as TargetConfigMatrix;
  const catalog = readJsonFile(productCatalogFilePath()) as ProductCatalog;
  const adPlacements = readJsonFile(adPlacementsFilePath()) as AdPlacements;
  const platformTargets = loadPlatformTargetsConfig().config as PlatformTargetsConfig;
  const configuredTargetEntries = Object.keys(platformTargets.targets).map((target) => {
    const config = configMatrix.targets[target];

    if (config === undefined) {
      throw new Error(`Missing target config for configured platform target: ${target}`);
    }

    return [target, config] as const;
  });

  return createEffectiveTargetConfigMatrix({
    configMatrix: {
      ...configMatrix,
      targets: Object.fromEntries(configuredTargetEntries),
    },
    catalog,
    adPlacements,
    platformTargets: Object.fromEntries(
      Object.entries(platformTargets.targets).map(([target, config]) => [
        target,
        toEffectivePlatformTargetMetadata(config),
      ]),
    ),
  });
}

export function validateEffectiveTargetConfigMatrix(
  matrix = loadEffectiveTargetConfigMatrix(),
  targets: readonly string[] = Object.keys(matrix.targets),
): EffectiveTargetConfigMatrix {
  for (const target of targets) {
    const config = matrix.targets[target];

    if (config === undefined) {
      throw new Error(`Unknown effective target config target: ${target}`);
    }

    validateEffectiveTargetConfig(config);
  }

  return matrix;
}

export function writeEffectiveTargetConfigs(
  options: WriteEffectiveTargetConfigsOptions = {},
): EffectiveTargetConfigArtifactIndex {
  const matrix = loadEffectiveTargetConfigMatrix();
  const outputDir = options.outputDir ?? 'artifacts/target-config';
  const targets = options.targets ?? Object.keys(matrix.targets);

  validateEffectiveTargetConfigMatrix(matrix, targets);

  const artifacts = targets.map((target) => {
    const config = matrix.targets[target];

    if (config === undefined) {
      throw new Error(`Unknown effective target config target: ${target}`);
    }

    return writeEffectiveTargetConfig(target, config, outputDir);
  });
  const indexPath = join(outputDir, 'index.json');
  const previousArtifacts = readExistingArtifactIndex(indexPath, matrix.version).artifacts;
  const artifactsByTarget = new Map(
    previousArtifacts
      .filter((artifact) => matrix.targets[artifact.target] !== undefined)
      .map((artifact) => [artifact.target, artifact]),
  );

  for (const artifact of artifacts) {
    artifactsByTarget.set(artifact.target, artifact);
  }

  const index = {
    version: matrix.version,
    artifacts: [...artifactsByTarget.values()].sort((left, right) =>
      left.target.localeCompare(right.target),
    ),
  } satisfies EffectiveTargetConfigArtifactIndex;
  const indexContent = `${JSON.stringify(index, null, 2)}\n`;

  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, indexContent);

  return index;
}

function readExistingArtifactIndex(
  path: string,
  version: string,
): EffectiveTargetConfigArtifactIndex {
  if (!existsSync(path)) {
    return {
      version,
      artifacts: [],
    };
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as EffectiveTargetConfigArtifactIndex;

  if (parsed.version !== version) {
    return {
      version,
      artifacts: [],
    };
  }

  return parsed;
}

export function digestFile(path: string): string {
  return sha256(readFileSync(path, 'utf8'));
}

function writeEffectiveTargetConfig(
  target: string,
  config: EffectiveTargetConfig,
  outputDir: string,
): EffectiveTargetConfigArtifact {
  const path = join(outputDir, `${target}.json`);
  const content = `${JSON.stringify(config, null, 2)}\n`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);

  return {
    target,
    path,
    digest: sha256(content),
    version: config.version,
  };
}

function validateEffectiveTargetConfig(config: EffectiveTargetConfig): void {
  const expectedPlatformKind = platformKindForRuntime(config.runtime);
  const expectedPlatformAdapter = platformAdapterForRuntime(config.runtime);

  if (config.sources.platformTargetKind !== expectedPlatformKind) {
    throw new Error(
      `Effective target ${config.target} runtime ${config.runtime} does not match platform target kind ${config.sources.platformTargetKind}.`,
    );
  }

  if (config.sources.platformAdapter !== expectedPlatformAdapter) {
    throw new Error(
      `Effective target ${config.target} runtime ${config.runtime} does not match platform adapter ${config.sources.platformAdapter ?? 'undefined'}; expected ${expectedPlatformAdapter}.`,
    );
  }

  for (const product of config.monetization.products) {
    if (!config.features.iap && product.enabled) {
      throw new Error(
        `Effective target ${config.target} enables product ${product.id} while IAP is disabled.`,
      );
    }

    if (
      config.features.iap
      && product.reason === 'missing-platform-id'
      && config.target !== 'reddit'
    ) {
      throw new Error(
        `Effective target ${config.target} is missing a platform product id for ${product.id}.`,
      );
    }
  }

  for (const placement of config.ads.placements) {
    const featureEnabled = isRewardedPlacement(placement)
      ? config.features.rewardedAds
      : config.features.interstitialAds;

    if (!featureEnabled && placement.enabled) {
      throw new Error(
        `Effective target ${config.target} enables placement ${placement.id} while ${placement.type} ads are disabled.`,
      );
    }

    if (featureEnabled && placement.reason === 'missing-platform-id') {
      throw new Error(
        `Effective target ${config.target} is missing a platform placement id for ${placement.id}.`,
      );
    }
  }

  if (config.features.leaderboard && config.leaderboard.defaultLeaderboardId === undefined) {
    throw new Error(`Effective target ${config.target} is missing a default leaderboard id.`);
  }

  if (config.features.localization !== config.localization.enabled) {
    throw new Error(`Effective target ${config.target} has mismatched localization state.`);
  }
}

function toEffectivePlatformTargetMetadata(
  config: PlatformTargetConfig,
): EffectivePlatformTargetMetadata {
  const base = {
    kind: config.kind,
    adapter: config.adapter,
    ...(config.authoritativeGameServices === undefined
      ? {}
      : { authoritativeGameServices: config.authoritativeGameServices }),
    ...(config.integrations === undefined ? {} : { integrations: config.integrations }),
  };

  switch (config.kind) {
    case 'web':
      return {
        ...base,
        output: config.output,
      };
    case 'capacitor-android':
    case 'capacitor-ios':
      return {
        ...base,
        artifact: config.artifact,
        webDir: config.webDir,
      };
    case 'apps-in-toss':
    case 'devvit-web':
      return {
        ...base,
        artifact: config.artifact,
        webDir: config.webDir,
      };
  }
}

function platformKindForRuntime(runtime: EffectiveTargetConfig['runtime']): string {
  switch (runtime) {
    case 'web-preview':
    case 'microsoft-store-pwa':
      return 'web';
    case 'capacitor-android':
      return 'capacitor-android';
    case 'capacitor-ios':
      return 'capacitor-ios';
    case 'apps-in-toss':
      return 'apps-in-toss';
    case 'devvit-web':
      return 'devvit-web';
    case 'verse8-web':
      return 'web';
  }
}

function platformAdapterForRuntime(runtime: EffectiveTargetConfig['runtime']): string {
  switch (runtime) {
    case 'web-preview':
    case 'microsoft-store-pwa':
      return 'browser';
    case 'capacitor-android':
    case 'capacitor-ios':
      return 'capacitor';
    case 'apps-in-toss':
      return 'ait';
    case 'devvit-web':
      return 'devvit';
    case 'verse8-web':
      return 'verse8';
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isRewardedPlacement(
  placement: EffectiveTargetConfig['ads']['placements'][number],
): boolean {
  return placement.type === 'rewarded';
}
