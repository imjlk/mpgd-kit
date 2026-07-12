import { dirname, isAbsolute, resolve } from 'node:path';

import {
  integrationAvailabilityStates,
  presentationModes,
  targetIntegrations,
  type IntegrationAvailabilityState,
  type PresentationMode,
} from '../../packages/target-config/src/runtime';
import { readJsonFile } from '../io';
import {
  assertPlatformTargetsConfig,
  type PlatformTargetConfig,
  type PlatformTargetsConfig,
} from './schemas';

export const platformTargetsFileEnv = 'MPGD_PLATFORM_TARGETS_FILE';
export const releaseManifestFileEnv = 'MPGD_RELEASE_MANIFEST_FILE';
export const effectiveTargetConfigOutputDirEnv = 'MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR';

const targetIntegrationConfigKeys = new Set<string>([...targetIntegrations, 'presentationMode']);
const integrationAvailabilityStateSet = new Set<IntegrationAvailabilityState>(
  integrationAvailabilityStates,
);
const presentationModeSet = new Set<PresentationMode>(presentationModes);

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

export function assertPlatformTargetsConfigShape(input: unknown): PlatformTargetsConfig {
  assertRecord(input, 'platform targets config');
  const targets = input.targets;
  assertRecord(targets, 'platform targets');

  for (const [target, config] of Object.entries(targets)) {
    assertPlatformTargetConfigShape(config, target);
  }

  return assertPlatformTargetsConfig(input);
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

  for (const key of Object.keys(input)) {
    if (!targetIntegrationConfigKeys.has(key)) {
      throw new Error(`${target}.integrations.${key} is not a recognized integration key.`);
    }
  }

  for (const integration of targetIntegrations) {
    const state = input[integration];

    if (state !== undefined) {
      assertIntegrationAvailabilityState(state, `${target}.integrations.${integration}`);
    }
  }

  const presentationMode = input.presentationMode;

  if (
    presentationMode !== undefined
    && !presentationModeSet.has(presentationMode as PresentationMode)
  ) {
    throw new Error(`${target}.integrations.presentationMode has an unsupported value.`);
  }
}

function assertIntegrationAvailabilityState(input: unknown, label: string): void {
  if (!integrationAvailabilityStateSet.has(input as IntegrationAvailabilityState)) {
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
