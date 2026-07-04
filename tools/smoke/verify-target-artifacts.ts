import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

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

interface SmokeReleaseManifest {
  readonly targets: Record<string, {
    readonly artifact: string;
    readonly effectiveConfig: {
      readonly path: string;
      readonly digest: string;
    };
  }>;
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

    for (const extraArtifact of extraRequiredArtifactsForTarget(target, targetConfig)) {
      assertPathExists(extraArtifact, `${target} required artifact`);
    }

    if (entry.artifact.length === 0) {
      throw new Error(`Release manifest target ${target} has an empty artifact path.`);
    }

    const artifactPath = resolveArtifactPath(entry.artifact);
    assertPathExists(artifactPath, `${target} artifact`);
    assertPathExists(entry.effectiveConfig.path, `${target} effective target config`);

    assertEmbeddedTargetConfig(
      readEmbeddedTargetConfigFromFile(
        entry.effectiveConfig.path,
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
      try {
        return readEmbeddedTargetConfigFromZip(artifactPath, `${target} release artifact`);
      } catch {
        return readEmbeddedTargetConfigFromDirectory(
          resolveTargetPath(requireString(targetConfig.webDir, `${target}.webDir`)),
          `${target} wrapper webDir`,
        );
      }
    case 'devvit-web':
      return readEmbeddedTargetConfigFromDirectory(
        resolveTargetPath(requireString(targetConfig.webDir, `${target}.webDir`)),
        `${target} Devvit client artifact`,
      );
  }
}

function extraRequiredArtifactsForTarget(
  target: string,
  targetConfig: SmokePlatformTargetConfig,
): readonly string[] {
  if (targetConfig.kind !== 'devvit-web') {
    return [];
  }

  return [
    resolveTargetPath(
      `${requireString(targetConfig.wrapperApp, `${target}.wrapperApp`)}/dist/server/index.cjs`,
    ),
  ];
}

function resolveArtifactPath(path: string): string {
  return resolveFromPlatformTargetsBase(loadedPlatformTargets.baseDir, path);
}

function resolveTargetPath(path: string): string {
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

function readSmokeReleaseManifest(path: string): SmokeReleaseManifest {
  const manifest = readJsonFile(path) as SmokeReleaseManifest;

  assertRecord(manifest, 'release manifest');
  assertRecord(manifest.targets, 'release manifest targets');

  for (const [target, entry] of Object.entries(manifest.targets)) {
    assertRecord(entry, `release manifest target ${target}`);
    assertString(entry.artifact, `${target}.artifact`);
    assertRecord(entry.effectiveConfig, `${target}.effectiveConfig`);
    assertString(entry.effectiveConfig.path, `${target}.effectiveConfig.path`);
    assertString(entry.effectiveConfig.digest, `${target}.effectiveConfig.digest`);
  }

  return manifest;
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

function requireString(input: string | undefined, label: string): string {
  if (input === undefined || input.length === 0) {
    throw new Error(`Missing target config value: ${label}`);
  }

  return input;
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
