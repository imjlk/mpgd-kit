import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { assertReleaseManifest, type ReleaseManifest } from '@mpgd/release-manifest';

import { readJsonFile } from '../io';
import {
  assertEmbeddedTargetConfig,
  embeddedTargetConfigFileName,
  readEmbeddedTargetConfigFromDirectory,
  readEmbeddedTargetConfigFromFile,
  readEmbeddedTargetConfigFromZip,
  type EmbeddedTargetConfigEvidence,
} from './embedded-target-config';

interface SmokePlatformTargetConfig {
  readonly kind: 'web' | 'capacitor-android' | 'capacitor-ios' | 'apps-in-toss' | 'devvit-web';
  readonly gameApp: string;
  readonly adapter: string;
  readonly output?: string;
  readonly shellApp?: string;
  readonly wrapperApp?: string;
  readonly webDir?: string;
  readonly artifact?: string;
}

interface SmokePlatformTargetsConfig {
  readonly targets: Record<string, SmokePlatformTargetConfig>;
}

const platformTargetsFileEnv = 'MPGD_PLATFORM_TARGETS_FILE';
const releaseManifestFileEnv = 'MPGD_RELEASE_MANIFEST_FILE';

const loadedPlatformTargets = loadSmokePlatformTargetsConfig();
const configuredTargets = Object.keys(loadedPlatformTargets.config.targets);
const knownTargets = new Set<string>(configuredTargets);

export function verifyTargetArtifacts(targets: readonly string[] = configuredTargets): void {
  const manifest = readSmokeReleaseManifest(releaseManifestPath(loadedPlatformTargets.baseDir));

  for (const target of targets) {
    const entry = manifest.targets[target];
    const targetConfig = loadedPlatformTargets.config.targets[target];

    if (entry === undefined) {
      throw new Error(`Missing release manifest target: ${target}`);
    }

    if (targetConfig === undefined) {
      throw new Error(`Missing platform target config: ${target}`);
    }

    if (entry.artifact.length === 0) {
      throw new Error(`Release manifest target ${target} has an empty artifact path.`);
    }

    const artifactPath = resolveArtifactPath(entry.artifact);
    const effectiveConfigPath = resolveArtifactPath(entry.effectiveConfig.path);

    assertPathInsideTargetBase(artifactPath, `${target} artifact`);
    assertPathExists(artifactPath, `${target} artifact`);
    assertPathExists(effectiveConfigPath, `${target} effective target config`);

    for (const requiredFile of requiredFilesForTarget(targetConfig, artifactPath)) {
      assertFileExists(requiredFile, `${target} required file`);
    }

    for (const extraArtifact of extraRequiredArtifactsForTarget(targetConfig, artifactPath)) {
      assertFileExists(extraArtifact, `${target} required artifact`);
    }

    assertEmbeddedTargetConfig(
      readEmbeddedTargetConfigFromFile(
        effectiveConfigPath,
        `${target} effective target config artifact`,
      ),
      {
        target,
        digest: entry.effectiveConfig.digest,
      },
    );
    assertEmbeddedTargetConfig(
      readReleaseEmbeddedTargetConfig(target, targetConfig, artifactPath),
      {
        target,
        digest: entry.effectiveConfig.digest,
      },
    );
  }

  console.log(`Target smoke passed: ${targets.join(', ')}`);
}

function readReleaseEmbeddedTargetConfig(
  target: string,
  targetConfig: SmokePlatformTargetConfig,
  artifactPath: string,
): EmbeddedTargetConfigEvidence {
  switch (targetConfig.kind) {
    case 'web':
      return readEmbeddedTargetConfigFromFile(
        `${artifactPath}/${embeddedTargetConfigFileName}`,
        'web-preview artifact',
      );
    case 'capacitor-android':
      return readEmbeddedTargetConfigFromZip(artifactPath, `${target} release AAB`);
    case 'capacitor-ios':
      return readEmbeddedTargetConfigFromDirectory(artifactPath, `${target} native artifact`);
    case 'apps-in-toss':
      if (artifactPath.endsWith('.ait')) {
        return readEmbeddedTargetConfigFromZip(artifactPath, `${target} release artifact`);
      }

      return readEmbeddedTargetConfigFromDirectory(artifactPath, `${target} release artifact`);
    case 'devvit-web':
      return readEmbeddedTargetConfigFromDirectory(
        `${artifactPath}/client`,
        `${target} Devvit client artifact`,
      );
  }
}

function extraRequiredArtifactsForTarget(
  targetConfig: SmokePlatformTargetConfig,
  artifactPath: string,
): readonly string[] {
  if (targetConfig.kind !== 'devvit-web') {
    return [];
  }

  return [`${artifactPath}/server/index.cjs`];
}

function requiredFilesForTarget(
  targetConfig: SmokePlatformTargetConfig,
  artifactPath: string,
): readonly string[] {
  switch (targetConfig.kind) {
    case 'web':
      return [`${artifactPath}/index.html`];
    case 'apps-in-toss':
      if (artifactPath.endsWith('.ait')) {
        return [];
      }

      return [`${artifactPath}/index.html`];
    case 'devvit-web':
      return [`${artifactPath}/client/index.html`];
    case 'capacitor-android':
    case 'capacitor-ios':
      return [];
  }
}

function resolveArtifactPath(path: string): string {
  return resolveFromPlatformTargetsBase(loadedPlatformTargets.baseDir, path);
}

function assertPathExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }

  const stat = statSync(path);

  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`${label} is not a file or directory: ${path}`);
  }
}

function assertPathInsideTargetBase(path: string, label: string): void {
  const relativePath = relative(loadedPlatformTargets.baseDir, path);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`${label} must stay under the target config dir: ${path}`);
  }
}

function assertFileExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }

  const stat = statSync(path);

  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
}

function loadSmokePlatformTargetsConfig(): {
  readonly baseDir: string;
  readonly config: SmokePlatformTargetsConfig;
} {
  const path = platformTargetsFilePath();
  const config = readJsonFile(path) as SmokePlatformTargetsConfig;

  assertRecord(config, 'platform targets config');
  assertRecord(config.targets, 'platform targets');

  for (const [target, targetConfig] of Object.entries(config.targets)) {
    assertRecord(targetConfig, `platform target ${target}`);
    assertTargetKind(targetConfig.kind, target);
    assertString(targetConfig.gameApp, `${target}.gameApp`);
    assertString(targetConfig.adapter, `${target}.adapter`);
  }

  return {
    baseDir: dirname(path),
    config,
  };
}

function readSmokeReleaseManifest(path: string): ReleaseManifest {
  return assertReleaseManifest(readJsonFile(path));
}

function platformTargetsFilePath(): string {
  return resolve(process.env[platformTargetsFileEnv] ?? 'platform.targets.json');
}

function releaseManifestPath(baseDir: string): string {
  return resolveFromPlatformTargetsBase(
    baseDir,
    process.env[releaseManifestFileEnv] ?? 'artifacts/release-manifest.json',
  );
}

function resolveFromPlatformTargetsBase(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertTargetKind(
  input: unknown,
  target: string,
): asserts input is SmokePlatformTargetConfig['kind'] {
  if (
    input !== 'web'
    && input !== 'capacitor-android'
    && input !== 'capacitor-ios'
    && input !== 'apps-in-toss'
    && input !== 'devvit-web'
  ) {
    throw new Error(`Target ${target} has unsupported kind: ${String(input)}`);
  }
}

function readRequestedTargets(args: readonly string[]): readonly string[] {
  if (args.length === 0) {
    return configuredTargets;
  }

  return args.map((target) => {
    if (!knownTargets.has(target)) {
      throw new Error(`Unknown target smoke target: ${target}`);
    }

    return target;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyTargetArtifacts(readRequestedTargets(process.argv.slice(2)));
}
