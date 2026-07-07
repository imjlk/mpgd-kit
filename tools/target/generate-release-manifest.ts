import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';

import typia from 'typia';

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import type { ReleaseManifest } from '@mpgd/release-manifest';
import type { TargetConfigMatrix } from '@mpgd/target-config';

import { isCliEntrypoint, readJsonFile } from '../io';
import { writeEffectiveTargetConfigs } from './effective-config';
import { effectiveTargetConfigOutputDir, loadPlatformTargetsConfig } from './platform-targets';

const assertProductCatalog = typia.createAssert<ProductCatalog>();
const assertAdPlacements = typia.createAssert<AdPlacements>();
const assertReleaseManifest = typia.createAssert<ReleaseManifest>();
const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();

export interface GenerateReleaseManifestInput {
  readonly target: string;
  readonly profile: string;
  readonly artifact: string;
  readonly outputPath?: string;
}

export function generateReleaseManifest(input: GenerateReleaseManifestInput): ReleaseManifest {
  const platformTargets = loadPlatformTargetsConfig();
  const targetMetadata = readTargetReleaseMetadata(platformTargets.config.targets[input.target]);
  const packageJson = readJsonFile('package.json') as { version?: string };
  const targetConfig = assertTargetConfigMatrix(
    readJsonFile('packages/target-config/targets.json'),
  );
  const catalog = assertProductCatalog(readJsonFile('packages/catalog/catalog.json'));
  const adPlacements = assertAdPlacements(readJsonFile('packages/catalog/placements.json'));
  const effectiveConfig = writeEffectiveTargetConfigs({
    targets: [input.target],
    outputDir: effectiveTargetConfigOutputDir(platformTargets.baseDir),
  }).artifacts.find((artifact) => artifact.target === input.target);
  const buildId = process.env.BUILD_ID ?? createBuildId();
  const gameVersion = process.env.APP_VERSION ?? packageJson.version ?? '0.0.0';

  if (effectiveConfig === undefined) {
    throw new Error(`Failed to generate effective target config for ${input.target}.`);
  }

  return assertReleaseManifest({
    releaseId: `mpgd-${gameVersion}+${buildId}`,
    gitSha: getGitSha(),
    gameVersion,
    buildId,
    targetConfigVersion: targetConfig.version,
    catalogVersion: catalog.version,
    adPlacementVersion: adPlacements.version,
    targets: {
      [input.target]: {
        artifact: input.artifact,
        profile: input.profile,
        effectiveConfig: {
          path: toPortablePath(platformTargets.baseDir, effectiveConfig.path),
          version: effectiveConfig.version,
          digest: effectiveConfig.digest,
        },
        ...(input.target === 'ait'
          ? {
              appName: readOptionalString(process.env.MPGD_AIT_APP_NAME)
                ?? targetMetadata.appName
                ?? 'mpgd-kit',
              sdkMajor: readSdkMajor(process.env.MPGD_AIT_SDK_MAJOR, targetMetadata.sdkMajor),
            }
          : {}),
      },
    },
  });
}

export function writeReleaseManifest(input: GenerateReleaseManifestInput): ReleaseManifest {
  const outputPath = input.outputPath ?? 'release-output/release-manifest.json';
  const nextManifest = generateReleaseManifest(input);
  const manifest = makeEffectiveConfigPathsPortable(
    mergeManifest(outputPath, nextManifest),
    loadPlatformTargetsConfig().baseDir,
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(`${outputPath}`, `${JSON.stringify(manifest, null, 2)}\n`);

  return manifest;
}

function mergeManifest(outputPath: string, nextManifest: ReleaseManifest): ReleaseManifest {
  if (!existsSync(outputPath)) {
    return nextManifest;
  }

  let previous: ReleaseManifest;

  try {
    previous = assertReleaseManifest(readJsonFile(outputPath));
  } catch {
    return nextManifest;
  }

  if (previous.releaseId !== nextManifest.releaseId) {
    return nextManifest;
  }

  return assertReleaseManifest({
    ...nextManifest,
    targets: {
      ...previous.targets,
      ...nextManifest.targets,
    },
  });
}

function makeEffectiveConfigPathsPortable(
  manifest: ReleaseManifest,
  baseDir: string,
): ReleaseManifest {
  return assertReleaseManifest({
    ...manifest,
    targets: Object.fromEntries(
      Object.entries(manifest.targets).map(([target, entry]) => [
        target,
        {
          ...entry,
          effectiveConfig: {
            ...entry.effectiveConfig,
            path: toPortablePath(baseDir, entry.effectiveConfig.path),
          },
        },
      ]),
    ),
  });
}

function toPortablePath(baseDir: string, path: string): string {
  if (!isAbsolute(path)) {
    return path;
  }

  const relativePath = relative(baseDir, path);

  if (
    relativePath.length > 0
    && !relativePath.startsWith('..')
    && !isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return path;
}

function createBuildId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const time = now.toISOString().slice(11, 19).replaceAll(':', '');
  return `${date}.${time}`;
}

function readTargetReleaseMetadata(input: unknown): {
  readonly appName?: string | undefined;
  readonly sdkMajor?: number | undefined;
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {};
  }

  const metadata = (input as { readonly metadata?: unknown }).metadata;

  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return {};
  }

  return {
    appName: readOptionalString((metadata as { readonly appName?: unknown }).appName),
    sdkMajor: readOptionalNumber((metadata as { readonly sdkMajor?: unknown }).sdkMajor),
  };
}

function readOptionalString(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }

  const trimmed = input.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isInteger(input) ? input : undefined;
}

function readSdkMajor(envValue: string | undefined, metadataValue: number | undefined): number {
  if (envValue !== undefined && envValue.length > 0) {
    const trimmed = envValue.trim();

    if (/^[1-9]\d*$/u.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }

  return metadataValue ?? 2;
}

function getGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'uncommitted';
  }
}

if (isCliEntrypoint(import.meta.url)) {
  const [
    target = 'web-preview',
    profile = 'production',
    artifact = 'artifacts/web-preview',
    outputPath,
  ] = process.argv.slice(2);
  const input =
    outputPath === undefined
      ? { target, profile, artifact }
      : { target, profile, artifact, outputPath };
  const manifest = writeReleaseManifest(input);
  console.log(`Release manifest: ${manifest.releaseId}`);
}
