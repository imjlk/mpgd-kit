import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import typia from 'typia';

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import type { TargetConfigMatrix } from '@mpgd/target-config';

import {
  assertReleaseManifest,
  type ReleaseManifest,
} from '../../packages/release-manifest/src/index';
import { adPlacementsFilePath, productCatalogFilePath } from '../catalog-paths';
import { isCliEntrypoint, readJsonFile } from '../io';
import { writeEffectiveTargetConfigs } from './effective-config';
import {
  effectiveTargetConfigOutputDir,
  loadPlatformTargetsConfig,
  type LoadedPlatformTargetsConfig,
} from './platform-targets';

const assertProductCatalog = typia.createAssert<ProductCatalog>();
const assertAdPlacements = typia.createAssert<AdPlacements>();
const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();

export interface GenerateReleaseManifestInput {
  readonly target: string;
  readonly profile: string;
  readonly artifact: string;
  readonly iconManifestArtifactPath: string;
  readonly outputPath?: string;
}

export type ReleaseManifestWriter = (
  input: GenerateReleaseManifestInput,
) => ReleaseManifest;

export interface ReleaseProvenance {
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
}

export function resolveReleaseProvenance(): ReleaseProvenance {
  const kitGitSha = resolveKitGitSha();

  return {
    sourceGitSha: getSourceGitSha(kitGitSha),
    kitGitSha,
  };
}

export function createReleaseManifestWriter(
  provenance = resolveReleaseProvenance(),
): ReleaseManifestWriter {
  return (input) => writeReleaseManifestWithProvenance(input, provenance);
}

export function generateReleaseManifest(input: GenerateReleaseManifestInput): ReleaseManifest {
  return generateReleaseManifestWithProvenance(input, resolveReleaseProvenance());
}

function generateReleaseManifestWithProvenance(
  input: GenerateReleaseManifestInput,
  provenance: ReleaseProvenance,
  platformTargets: LoadedPlatformTargetsConfig = loadPlatformTargetsConfig(),
): ReleaseManifest {
  const targetMetadata = readTargetReleaseMetadata(platformTargets.config.targets[input.target]);
  const packageJson = readJsonFile('package.json') as { version?: string };
  const targetConfig = assertTargetConfigMatrix(
    readJsonFile('packages/target-config/targets.json'),
  );
  const catalog = assertProductCatalog(readJsonFile(productCatalogFilePath()));
  const adPlacements = assertAdPlacements(readJsonFile(adPlacementsFilePath()));
  const effectiveConfig = writeEffectiveTargetConfigs({
    targets: [input.target],
    outputDir: effectiveTargetConfigOutputDir(platformTargets.baseDir),
  }).artifacts.find((artifact) => artifact.target === input.target);
  const buildId = process.env.BUILD_ID ?? createBuildId();
  const gameVersion = process.env.APP_VERSION ?? packageJson.version ?? '0.0.0';
  const iconManifest = readIconManifestEvidence(input.iconManifestArtifactPath);

  if (effectiveConfig === undefined) {
    throw new Error(`Failed to generate effective target config for ${input.target}.`);
  }

  return assertReleaseManifest({
    releaseId: `mpgd-${gameVersion}+${buildId}`,
    gitSha: provenance.sourceGitSha,
    kitGitSha: provenance.kitGitSha,
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
        iconManifest,
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

function readIconManifestEvidence(
  artifactPath: string,
): ReleaseManifest['targets'][string]['iconManifest'] {
  const path = readOptionalString(process.env.MPGD_ICON_MANIFEST_PATH);

  if (path === undefined) {
    throw new Error('MPGD_ICON_MANIFEST_PATH is required when generating a release manifest.');
  }

  const bytes = readFileBytes(path);
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid icon manifest: ${path}`);
  }

  const manifest = parsed as Record<string, unknown>;
  const canonicalSource = manifest.canonicalSource;

  if (
    typeof canonicalSource !== 'object'
    || canonicalSource === null
    || Array.isArray(canonicalSource)
  ) {
    throw new Error(`Invalid icon manifest canonicalSource: ${path}`);
  }

  const canonicalSourceRecord = canonicalSource as Record<string, unknown>;

  return {
    path: requirePortableArtifactPath(artifactPath),
    digest: createHash('sha256').update(bytes).digest('hex'),
    sourceSha256: requireManifestString(canonicalSourceRecord, 'sha256', path),
    sharedConfigSha256: requireManifestString(manifest, 'sharedConfigSha256', path),
    renderConfigSha256: requireManifestString(manifest, 'renderConfigSha256', path),
    generatorVersion: requireManifestString(manifest, 'generatorVersion', path),
    targetProfile: requireManifestString(manifest, 'targetProfile', path),
    targetProfileVersion: requireManifestString(manifest, 'targetProfileVersion', path),
  };
}

function requirePortableArtifactPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');

  if (
    normalized.length === 0
    || isAbsolute(path)
    || isAbsolute(normalized)
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid icon manifest artifact path: ${path}`);
  }

  return normalized;
}

function readFileBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`Failed to read icon manifest ${path}: ${formatError(error)}`);
  }
}

function requireManifestString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = record[key];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid icon manifest ${key}: ${path}`);
  }

  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function writeReleaseManifest(input: GenerateReleaseManifestInput): ReleaseManifest {
  return createReleaseManifestWriter()(input);
}

function writeReleaseManifestWithProvenance(
  input: GenerateReleaseManifestInput,
  provenance: ReleaseProvenance,
): ReleaseManifest {
  const outputPath = input.outputPath ?? 'release-output/release-manifest.json';
  const platformTargets = loadPlatformTargetsConfig();
  const nextManifest = generateReleaseManifestWithProvenance(input, provenance, platformTargets);
  const manifest = makeEffectiveConfigPathsPortable(
    mergeManifest(outputPath, nextManifest),
    platformTargets.baseDir,
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

  if (!hasMatchingReleaseContract(previous, nextManifest)) {
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

function hasMatchingReleaseContract(
  previous: ReleaseManifest,
  next: ReleaseManifest,
): boolean {
  return previous.releaseId === next.releaseId
    && previous.gitSha === next.gitSha
    && previous.kitGitSha === next.kitGitSha
    && previous.targetConfigVersion === next.targetConfigVersion
    && previous.catalogVersion === next.catalogVersion
    && previous.adPlacementVersion === next.adPlacementVersion
    && hasMatchingIconContract(previous, next);
}

function hasMatchingIconContract(
  previous: ReleaseManifest,
  next: ReleaseManifest,
): boolean {
  const nextTargetEntry = Object.entries(next.targets)[0];

  if (nextTargetEntry === undefined) {
    return false;
  }

  const [nextTargetName, nextTarget] = nextTargetEntry;
  const nextIconManifest = nextTarget.iconManifest;
  const previousSameTarget = previous.targets[nextTargetName];

  return (
    previousSameTarget === undefined
    || previousSameTarget.iconManifest.renderConfigSha256
      === nextIconManifest.renderConfigSha256
  ) && Object.values(previous.targets).every(
    (target) =>
      target.iconManifest.sourceSha256 === nextIconManifest.sourceSha256
      && target.iconManifest.sharedConfigSha256 === nextIconManifest.sharedConfigSha256
      && target.iconManifest.generatorVersion === nextIconManifest.generatorVersion,
  );
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

function getSourceGitSha(kitGitSha: string): string {
  const configuredGitSha = readOptionalString(process.env.MPGD_SOURCE_GIT_SHA);

  if (configuredGitSha !== undefined) {
    return configuredGitSha;
  }

  return kitGitSha;
}

function resolveKitGitSha(): string {
  const kitRoot = resolveKitRoot();

  assertKitGitTopLevel(kitRoot);
  assertCleanKitWorktree(kitRoot);

  let kitGitSha: string;

  try {
    kitGitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: kitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    throw new Error('Failed to resolve the mpgd-kit Git revision.', { cause: error });
  }

  if (!/^[0-9a-f]{40}$/u.test(kitGitSha)) {
    throw new Error('The mpgd-kit Git revision must be a full 40-character SHA.');
  }

  return kitGitSha;
}

function resolveKitRoot(): string {
  const configuredKitRoot = readOptionalString(process.env.MPGD_KIT_PATH);
  let executionRoot: string;

  try {
    executionRoot = realpathSync(resolve(process.cwd()));
  } catch (error) {
    throw new Error('Failed to resolve the mpgd-kit execution root.', { cause: error });
  }

  if (configuredKitRoot === undefined) {
    return executionRoot;
  }

  let resolvedConfiguredKitRoot: string;

  try {
    resolvedConfiguredKitRoot = realpathSync(resolve(configuredKitRoot));
  } catch (error) {
    throw new Error('Failed to resolve MPGD_KIT_PATH.', { cause: error });
  }

  if (resolvedConfiguredKitRoot !== executionRoot) {
    throw new Error(
      'MPGD_KIT_PATH must match the mpgd-kit execution root. '
      + `Resolved MPGD_KIT_PATH: ${resolvedConfiguredKitRoot}; execution root: ${executionRoot}.`,
    );
  }

  return executionRoot;
}

function assertKitGitTopLevel(kitRoot: string): void {
  let gitTopLevel: string;

  try {
    gitTopLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: kitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    throw new Error('Failed to resolve the mpgd-kit Git checkout root.', { cause: error });
  }

  let resolvedGitTopLevel: string;

  try {
    resolvedGitTopLevel = realpathSync(gitTopLevel);
  } catch (error) {
    throw new Error('Failed to resolve the mpgd-kit Git checkout root path.', { cause: error });
  }

  if (resolvedGitTopLevel !== kitRoot) {
    throw new Error(
      'MPGD_KIT_PATH must point to the root of its own Git checkout. '
      + `Git root: ${resolvedGitTopLevel}; execution root: ${kitRoot}.`,
    );
  }
}

function assertCleanKitWorktree(kitRoot: string): void {
  let worktreeStatus: string;

  try {
    worktreeStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: kitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    throw new Error('Failed to inspect the mpgd-kit Git worktree.', { cause: error });
  }

  if (worktreeStatus.length > 0) {
    throw new Error(
      'The mpgd-kit Git worktree must be clean before generating a release manifest.',
    );
  }
}

if (isCliEntrypoint(import.meta.url)) {
  const [
    target = 'web-preview',
    profile = 'production',
    artifact = 'artifacts/web-preview',
    outputPath,
    iconManifestArtifactPath = process.env.MPGD_ICON_MANIFEST_ARTIFACT_PATH,
  ] = process.argv.slice(2);
  if (iconManifestArtifactPath === undefined) {
    throw new Error(
      'Provide the icon manifest path inside the release artifact as argument 5 '
      + 'or MPGD_ICON_MANIFEST_ARTIFACT_PATH.',
    );
  }
  const input = outputPath === undefined
    ? { target, profile, artifact, iconManifestArtifactPath }
    : { target, profile, artifact, iconManifestArtifactPath, outputPath };
  const manifest = writeReleaseManifest(input);
  console.log(`Release manifest: ${manifest.releaseId}`);
}
