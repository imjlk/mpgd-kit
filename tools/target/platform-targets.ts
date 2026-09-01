import { dirname, isAbsolute, resolve } from 'node:path';

import { assertDeploymentTargetName } from '../../packages/cli/src/target-name';
import {
  integrationAvailabilityStates,
  presentationModes,
  targetIntegrations,
  type IntegrationAvailabilityState,
  type PresentationMode,
} from '../../packages/target-config/src/runtime';
import { readJsonFile } from '../io';
import { miniGameMainPackageLimitBytes } from './minigame-package-budget';
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

export function appTargetForPlatformTarget(
  target: Pick<PlatformTargetConfig, 'adapter' | 'kind'>,
  targetName: string,
): string {
  return target.kind === 'web'
    || target.kind === 'wechat-minigame'
    || target.kind === 'tiktok-minigame'
      ? target.adapter
      : targetName;
}

export function assertPlatformTargetBuildEmitterAvailable(
  target: Pick<PlatformTargetConfig, 'kind'>,
  targetName: string,
): void {
  if (target.kind === 'tiktok-minigame') {
    throw new Error(
      `Mini-game target ${targetName} cannot be built until its native artifact emitter is installed. Configuration validation remains available.`,
    );
  }
}

export function assertPlatformTargetsConfigShape(input: unknown): PlatformTargetsConfig {
  assertRecord(input, 'platform targets config');
  const targets = input.targets;
  assertRecord(targets, 'platform targets');

  for (const [target, config] of Object.entries(targets)) {
    assertDeploymentTargetName(target);
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
  assertOptionalBoolean(input.authoritativeGameServices, `${target}.authoritativeGameServices`);
  assertTargetIntegrations(input.integrations, target);
  assertTargetIcon(input.icon, target);

  if (
    target === 'microsoft-store'
    && (input.kind !== 'web' || input.adapter !== 'microsoft-store')
  ) {
    throw new Error('microsoft-store target must use the web kind and microsoft-store adapter.');
  }
  if (input.adapter === 'microsoft-store' && target !== 'microsoft-store') {
    throw new Error(`Platform target ${target} cannot use the reserved microsoft-store adapter.`);
  }

  switch (input.kind) {
    case 'web':
      assertString(input.output, `${target}.output`);
      assertOptionalBoolean(input.installable, `${target}.installable`);
      assertOptionalString(input.staticDir, `${target}.staticDir`);
      if (target === 'microsoft-store' && input.installable === false) {
        throw new Error('microsoft-store.installable must not be false.');
      }
      break;
    case 'capacitor-android':
    case 'capacitor-ios':
      assertString(input.shellApp, `${target}.shellApp`);
      assertString(input.webDir, `${target}.webDir`);
      assertString(input.artifact, `${target}.artifact`);
      break;
    case 'apps-in-toss':
      assertAppsInTossNavigationBar(input.navigationBar, target);
      assertString(input.wrapperApp, `${target}.wrapperApp`);
      assertString(input.webDir, `${target}.webDir`);
      assertString(input.artifact, `${target}.artifact`);
      break;
    case 'devvit-web':
      assertString(input.wrapperApp, `${target}.wrapperApp`);
      assertString(input.webDir, `${target}.webDir`);
      assertString(input.artifact, `${target}.artifact`);
      break;
    case 'wechat-minigame':
    case 'tiktok-minigame':
      assertMiniGameTarget(input, target);
      break;
  }
}

function assertMiniGameTarget(input: Record<string, unknown>, target: string): void {
  assertString(input.output, `${target}.output`);

  if (input.renderer !== 'canvas') {
    throw new Error(`${target}.renderer must be canvas.`);
  }

  if (input.orientation !== 'portrait' && input.orientation !== 'landscape') {
    throw new Error(`${target}.orientation must be portrait or landscape.`);
  }

  if (input.experimental !== true) {
    throw new Error(`${target}.experimental must be true.`);
  }

  const expectedAdapter = input.kind === 'wechat-minigame' ? 'wechat' : 'tiktok';

  if (input.adapter !== expectedAdapter) {
    throw new Error(`${target}.adapter must be ${expectedAdapter} for ${String(input.kind)}.`);
  }

  assertMiniGameRemoteAssetOrigins(input.remoteAssetOrigins, target);

  assertRecord(input.packageBudget, `${target}.packageBudget`);
  assertPositiveSafeInteger(input.packageBudget.mainBytes, `${target}.packageBudget.mainBytes`);
  assertPositiveSafeInteger(input.packageBudget.totalBytes, `${target}.packageBudget.totalBytes`);

  if (input.packageBudget.mainBytes > input.packageBudget.totalBytes) {
    throw new Error(`${target}.packageBudget.mainBytes must not exceed totalBytes.`);
  }

  if (input.packageBudget.mainBytes > miniGameMainPackageLimitBytes) {
    throw new Error(
      `${target}.packageBudget.mainBytes must not exceed ${String(miniGameMainPackageLimitBytes)} bytes.`,
    );
  }

  if (input.packageBudget.independentSubpackageBytes !== undefined) {
    assertPositiveSafeInteger(
      input.packageBudget.independentSubpackageBytes,
      `${target}.packageBudget.independentSubpackageBytes`,
    );

    if (input.packageBudget.independentSubpackageBytes > input.packageBudget.totalBytes) {
      throw new Error(
        `${target}.packageBudget.independentSubpackageBytes must not exceed totalBytes.`,
      );
    }
  }
}

function assertMiniGameRemoteAssetOrigins(input: unknown, target: string): void {
  if (input === undefined) {
    return;
  }
  if (!Array.isArray(input)) {
    throw new Error(`${target}.remoteAssetOrigins must be an array of exact HTTPS origins.`);
  }

  const origins = new Set<string>();

  for (const [index, origin] of input.entries()) {
    if (typeof origin !== 'string') {
      throw new Error(`${target}.remoteAssetOrigins[${String(index)}] must be a string.`);
    }

    let parsed: URL;

    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        `${target}.remoteAssetOrigins[${String(index)}] must be an exact HTTPS origin.`,
      );
    }

    if (
      parsed.protocol !== 'https:'
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.origin !== origin
    ) {
      throw new Error(
        `${target}.remoteAssetOrigins[${String(index)}] must be an exact HTTPS origin.`,
      );
    }
    if (origins.has(origin)) {
      throw new Error(`${target}.remoteAssetOrigins must not contain duplicate origins.`);
    }
    origins.add(origin);
  }
}

function assertAppsInTossNavigationBar(input: unknown, target: string): void {
  if (input === undefined) {
    return;
  }

  assertRecord(input, `${target}.navigationBar`);
  const booleanKeys = [
    'withBackButton',
    'withHomeButton',
    'withTitle',
    'transparentBackground',
  ] as const;
  const supportedKeys = new Set<string>([...booleanKeys, 'theme']);

  for (const key of Object.keys(input)) {
    if (!supportedKeys.has(key)) {
      throw new Error(`${target}.navigationBar.${key} is not a recognized navigation option.`);
    }
  }

  for (const key of booleanKeys) {
    assertOptionalBoolean(input[key], `${target}.navigationBar.${key}`);
  }

  if (input.theme !== undefined && input.theme !== 'light' && input.theme !== 'dark') {
    throw new Error(`${target}.navigationBar.theme must be light or dark.`);
  }
}

function assertTargetIcon(input: unknown, target: string): void {
  if (input === undefined) {
    return;
  }

  assertRecord(input, `${target}.icon`);
  const supportedKeys = new Set([
    'profile',
    'source',
    'backgroundColor',
    'externalUrl',
    'variants',
  ]);

  for (const key of Object.keys(input)) {
    if (!supportedKeys.has(key)) {
      throw new Error(`${target}.icon.${key} is not a recognized icon override key.`);
    }
  }

  for (const key of ['profile', 'source', 'backgroundColor', 'externalUrl'] as const) {
    if (input[key] !== undefined) {
      assertString(input[key], `${target}.icon.${key}`);
    }
  }

  if (input.variants !== undefined) {
    assertRecord(input.variants, `${target}.icon.variants`);
    const supportedVariants = new Set([
      'maskable',
      'androidForeground',
      'monochrome',
      'background',
    ]);

    for (const [key, value] of Object.entries(input.variants)) {
      if (!supportedVariants.has(key)) {
        throw new Error(`${target}.icon.variants.${key} is not a recognized icon variant.`);
      }

      assertString(value, `${target}.icon.variants.${key}`);
    }
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
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertOptionalString(input: unknown, label: string): void {
  if (input !== undefined) {
    assertString(input, label);
  }
}

function assertOptionalBoolean(input: unknown, label: string): void {
  if (input !== undefined && typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean when provided.`);
  }
}

function assertPositiveSafeInteger(input: unknown, label: string): asserts input is number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertTargetKind(input: unknown, target: string): asserts input is PlatformTargetConfig['kind'] {
  if (
    input !== 'web'
    && input !== 'capacitor-android'
    && input !== 'capacitor-ios'
    && input !== 'apps-in-toss'
    && input !== 'devvit-web'
    && input !== 'wechat-minigame'
    && input !== 'tiktok-minigame'
  ) {
    throw new Error(`Target ${target} has unsupported kind: ${String(input)}`);
  }
}
