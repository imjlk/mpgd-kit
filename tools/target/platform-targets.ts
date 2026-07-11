import { dirname, isAbsolute, resolve } from 'node:path';

import { readJsonFile } from '../io';
import type { PlatformTargetConfig, PlatformTargetsConfig } from './schemas';

export const platformTargetsFileEnv = 'MPGD_PLATFORM_TARGETS_FILE';
export const releaseManifestFileEnv = 'MPGD_RELEASE_MANIFEST_FILE';
export const effectiveTargetConfigOutputDirEnv = 'MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR';

export interface LoadedPlatformTargetsConfig {
  readonly path: string;
  readonly baseDir: string;
  readonly config: PlatformTargetsConfig;
}

export function platformTargetsFilePath(
  path = process.env[platformTargetsFileEnv] ?? 'mpgd.targets.json',
): string {
  return resolve(path);
}

export function loadPlatformTargetsConfig(
  path = platformTargetsFilePath(),
): LoadedPlatformTargetsConfig {
  const resolvedPath = platformTargetsFilePath(path);

  return {
    path: resolvedPath,
    baseDir: dirname(resolvedPath),
    config: assertPlatformTargetsConfigShape(readJsonFile(resolvedPath)),
  };
}

export function resolveFromPlatformTargetsBase(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

export function releaseManifestPath(baseDir = dirname(platformTargetsFilePath())): string {
  return resolveFromPlatformTargetsBase(
    baseDir,
    process.env[releaseManifestFileEnv] ?? 'artifacts/release-manifest.json',
  );
}

export function effectiveTargetConfigOutputDir(
  baseDir = dirname(platformTargetsFilePath()),
): string {
  return resolveFromPlatformTargetsBase(
    baseDir,
    process.env[effectiveTargetConfigOutputDirEnv] ?? 'artifacts/target-config',
  );
}

function assertPlatformTargetsConfigShape(input: unknown): PlatformTargetsConfig {
  assertRecord(input, 'platform targets config');
  const targets = input.targets;
  assertRecord(targets, 'platform targets');

  for (const [target, config] of Object.entries(targets)) {
    assertPlatformTargetConfigShape(config, target);
  }

  return {
    targets: targets as Record<string, PlatformTargetConfig>,
  };
}

function assertPlatformTargetConfigShape(
  input: unknown,
  target: string,
): asserts input is PlatformTargetConfig {
  assertRecord(input, `platform target ${target}`);
  assertTargetKind(input.kind, target);
  assertString(input.gameApp, `${target}.gameApp`);
  assertString(input.adapter, `${target}.adapter`);
  assertTargetIntegrations(input.integrations, target);

  switch (input.kind) {
    case 'web':
      assertString(input.output, `${target}.output`);
      break;
    case 'capacitor-android':
    case 'capacitor-ios':
      assertString(input.shellApp, `${target}.shellApp`);
      assertString(input.webDir, `${target}.webDir`);
      assertString(input.artifact, `${target}.artifact`);
      break;
    case 'apps-in-toss':
    case 'devvit-web':
      assertString(input.wrapperApp, `${target}.wrapperApp`);
      assertString(input.webDir, `${target}.webDir`);
      assertString(input.artifact, `${target}.artifact`);
      break;
  }
}

function assertTargetIntegrations(input: unknown, target: string): void {
  if (input === undefined) {
    return;
  }

  assertRecord(input, `${target}.integrations`);

  for (const integration of [
    'identityUpgrade',
    'presentation',
    'sharing',
    'inboundShare',
    'notifications',
  ] as const) {
    const state = input[integration];

    if (state !== undefined) {
      assertIntegrationAvailabilityState(state, `${target}.integrations.${integration}`);
    }
  }

  const presentationMode = input.presentationMode;

  if (
    presentationMode !== undefined
    && presentationMode !== 'fullscreen'
    && presentationMode !== 'inline-expanded'
  ) {
    throw new Error(`${target}.integrations.presentationMode has an unsupported value.`);
  }
}

function assertIntegrationAvailabilityState(input: unknown, label: string): void {
  if (
    input !== 'available'
    && input !== 'disabled'
    && input !== 'approval-required'
    && input !== 'configuration-required'
    && input !== 'unsupported'
  ) {
    throw new Error(`${label} has an unsupported value.`);
  }
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

function assertTargetKind(input: unknown, target: string): asserts input is PlatformTargetConfig['kind'] {
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
