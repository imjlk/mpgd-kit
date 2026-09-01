import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ttsc from '@ttsc/unplugin/vite';
import type { PluginOption } from 'vite';

import {
  assertRuntimeTargetConfigMatrix,
  type TargetConfigMatrix,
} from './vite.runtime-target-config';

interface RuntimePlatformTargetMetadata {
  readonly kind: string;
  readonly adapter: string;
  readonly authoritativeGameServices?: boolean;
  readonly integrations?: Record<string, unknown>;
  readonly remoteAssetOrigins?: readonly string[];
}

const devvitSandboxBuildId = 'devvit-sandbox';

export interface CreateGameViteSharedConfigInput {
  readonly appTarget?: string;
  readonly configTarget?: string;
  readonly gameRoot: string;
  readonly mode: string;
  readonly platformTargetsFile?: string;
  readonly project: string;
  readonly productCatalogFile?: string;
  readonly adPlacementsFile?: string;
}

/** Vite-major-neutral subset shared by every generated target wrapper. */
export interface GameViteSharedConfig<SharedPluginOption> {
  readonly base: string;
  readonly plugins: SharedPluginOption[];
  readonly resolve: {
    readonly alias: Record<string, string>;
  };
  readonly define: Record<string, string>;
}

export function createGameViteSharedConfig<SharedPluginOption = PluginOption>(
  input: CreateGameViteSharedConfigInput,
): GameViteSharedConfig<SharedPluginOption> {
  const isProduction = input.mode === 'production';
  const appTarget = input.appTarget ?? process.env.APP_TARGET ?? 'browser';
  const configTarget = input.configTarget ?? process.env.MPGD_CONFIG_TARGET ?? '';
  const platformTarget = readRuntimePlatformTarget(
    input.platformTargetsFile ?? process.env.MPGD_PLATFORM_TARGETS_FILE,
    configTarget,
  );
  const buildGatewayModule = resolveBuildGatewayModule({
    target: appTarget,
    debug: !isProduction,
    buildId: process.env.BUILD_ID ?? 'local',
  });
  const runtimeTargetConfigMatrix = readRuntimeTargetConfigMatrix(
    process.env.MPGD_TARGET_CONFIG_MATRIX_FILE,
  );

  return {
    base: './',
    plugins: [
      // The unplugin runtime is Vite-compatible, but its recursive generic
      // plugin type can exceed TypeScript's comparison depth in a monorepo.
      ttsc({
        project: input.project,
        plugins: false,
      }) as unknown as SharedPluginOption,
    ],
    resolve: {
      alias: {
        ...createCatalogAliases({
          gameRoot: input.gameRoot,
          productCatalogFile: input.productCatalogFile,
          adPlacementsFile: input.adPlacementsFile,
        }),
        '#mpgd-platform-gateway': resolve(input.gameRoot, buildGatewayModule),
      },
    },
    define: {
      __APP_TARGET__: JSON.stringify(appTarget),
      __MPGD_CONFIG_TARGET__: JSON.stringify(configTarget),
      __MPGD_PLATFORM_TARGET__:
        platformTarget === undefined
          ? 'undefined'
          : JSON.stringify(toEffectivePlatformTargetMetadata(platformTarget)),
      __MPGD_MINIGAME_REMOTE_ASSET_ORIGINS__: JSON.stringify(
        platformTarget?.remoteAssetOrigins ?? [],
      ),
      __MPGD_TARGET_CONFIG_MATRIX__:
        runtimeTargetConfigMatrix === undefined
          ? 'undefined'
          : JSON.stringify(runtimeTargetConfigMatrix),
      __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? '0.0.0-dev'),
      __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? 'local'),
      __SOURCE_GIT_SHA__: JSON.stringify(process.env.MPGD_SOURCE_GIT_SHA ?? 'uncommitted'),
      __DEBUG_BUILD__: JSON.stringify(!isProduction),
    },
  };
}

function readRuntimeTargetConfigMatrix(
  source: string | undefined,
): TargetConfigMatrix | undefined {
  const matrixFile = source?.trim();
  if (matrixFile === undefined || matrixFile.length === 0) {
    return undefined;
  }

  const resolvedMatrixFile = resolve(matrixFile);

  try {
    return assertRuntimeTargetConfigMatrix(
      JSON.parse(readFileSync(resolvedMatrixFile, 'utf8')) as unknown,
    );
  } catch (error) {
    throw new Error(
      `Failed to read or validate MPGD_TARGET_CONFIG_MATRIX_FILE at ${resolvedMatrixFile}: ${formatError(error)}`,
    );
  }
}

export function resolveBuildGatewayModule(input: {
  readonly target: string;
  readonly debug: boolean;
  readonly buildId: string;
}): string {
  switch (input.target) {
    case 'android':
      return 'src/platform/buildGateways/capacitorAndroid.ts';
    case 'ios':
      return 'src/platform/buildGateways/capacitorIos.ts';
    case 'ait':
      return input.debug
        ? 'src/platform/buildGateways/aitSandbox.ts'
        : 'src/platform/buildGateways/ait.ts';
    case 'reddit':
      return input.debug && input.buildId === devvitSandboxBuildId
        ? 'src/platform/buildGateways/redditSandbox.ts'
        : 'src/platform/buildGateways/reddit.ts';
    case 'verse8':
      return 'src/platform/buildGateways/verse8.ts';
    case 'microsoft-store':
      return 'src/platform/buildGateways/microsoftStore.ts';
    case 'telegram':
    case 'tauri':
      throw new Error(
        `Direct APP_TARGET=${input.target} builds are unavailable until its native platform gateway is installed.`,
      );
    case 'wechat':
      return 'src/platform/buildGateways/wechat.ts';
    case 'tiktok':
      throw new Error(
        `Direct APP_TARGET=${input.target} builds are unavailable until the native mini-game gateway and artifact emitter are installed.`,
      );
    default:
      return 'src/platform/buildGateways/browser.ts';
  }
}

function createCatalogAliases(input: {
  readonly gameRoot: string;
  readonly productCatalogFile: string | undefined;
  readonly adPlacementsFile: string | undefined;
}): Record<string, string> {
  const productCatalogFile = readConfiguredPath(
    input.productCatalogFile ?? process.env.MPGD_PRODUCT_CATALOG_FILE,
  );
  const adPlacementsFile = readConfiguredPath(
    input.adPlacementsFile ?? process.env.MPGD_AD_PLACEMENTS_FILE,
  );

  if ((productCatalogFile === undefined) !== (adPlacementsFile === undefined)) {
    throw new Error(
      'productCatalogFile and adPlacementsFile '
      + '(MPGD_PRODUCT_CATALOG_FILE / MPGD_AD_PLACEMENTS_FILE) must be configured together.',
    );
  }

  if (productCatalogFile === undefined || adPlacementsFile === undefined) {
    return {};
  }

  const catalogBaseDir = resolveCatalogBaseDir(
    productCatalogFile,
    adPlacementsFile,
    input.gameRoot,
  );

  return {
    '@mpgd/catalog/catalog.json': resolve(catalogBaseDir, productCatalogFile),
    '@mpgd/catalog/placements.json': resolve(catalogBaseDir, adPlacementsFile),
  };
}

function readConfiguredPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function readRuntimePlatformTarget(
  targetsFileInput: string | undefined,
  configTarget: string,
): RuntimePlatformTargetMetadata | undefined {
  const targetsFile = readConfiguredPath(targetsFileInput);

  if (targetsFile === undefined || configTarget.length === 0) {
    return undefined;
  }

  const resolvedTargetsFile = resolve(targetsFile);
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(resolvedTargetsFile, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to read or parse MPGD_PLATFORM_TARGETS_FILE at ${resolvedTargetsFile}: ${formatError(error)}`,
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.targets)) {
    throw new Error('MPGD_PLATFORM_TARGETS_FILE must contain a targets object.');
  }

  const target = parsed.targets[configTarget];

  if (!isRecord(target)) {
    throw new Error(`Missing platform target metadata for ${configTarget}.`);
  }

  if (typeof target.kind !== 'string' || typeof target.adapter !== 'string') {
    throw new Error(`Platform target ${configTarget} must define kind and adapter.`);
  }

  if (target.integrations !== undefined && !isRecord(target.integrations)) {
    throw new Error(`Platform target ${configTarget} integrations must be an object.`);
  }

  if (
    target.authoritativeGameServices !== undefined
    && typeof target.authoritativeGameServices !== 'boolean'
  ) {
    throw new Error(
      `Platform target ${configTarget} authoritativeGameServices must be a boolean.`,
    );
  }
  const remoteAssetOrigins = readMiniGameRemoteAssetOrigins(
    target.remoteAssetOrigins,
    configTarget,
  );

  return {
    kind: target.kind,
    adapter: target.adapter,
    ...(target.authoritativeGameServices === undefined
      ? {}
      : { authoritativeGameServices: target.authoritativeGameServices }),
    ...(target.integrations === undefined ? {} : { integrations: target.integrations }),
    ...(remoteAssetOrigins === undefined ? {} : { remoteAssetOrigins }),
  };
}

function toEffectivePlatformTargetMetadata(
  input: RuntimePlatformTargetMetadata,
): Omit<RuntimePlatformTargetMetadata, 'remoteAssetOrigins'> {
  return {
    kind: input.kind,
    adapter: input.adapter,
    ...(input.authoritativeGameServices === undefined
      ? {}
      : { authoritativeGameServices: input.authoritativeGameServices }),
    ...(input.integrations === undefined ? {} : { integrations: input.integrations }),
  };
}

function readMiniGameRemoteAssetOrigins(
  input: unknown,
  target: string,
): readonly string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new Error(`Platform target ${target} remoteAssetOrigins must be an array.`);
  }

  const origins = new Set<string>();

  for (const [index, origin] of input.entries()) {
    if (typeof origin !== 'string') {
      throw new Error(
        `Platform target ${target} remoteAssetOrigins[${String(index)}] must be a string.`,
      );
    }

    let normalized: string;

    try {
      normalized = normalizeRuntimeCompatibleMiniGameHttpsOrigin(origin);
    } catch {
      throw new Error(
        `Platform target ${target} remoteAssetOrigins[${String(index)}] must be an exact HTTPS origin.`,
      );
    }

    if (
      normalized !== origin
      || origins.has(origin)
    ) {
      throw new Error(
        `Platform target ${target} remoteAssetOrigins[${String(index)}] must be a unique exact HTTPS origin.`,
      );
    }
    origins.add(origin);
  }

  return [...origins];
}

// This file is also copied into the public starter, which intentionally has no private runtime
// dependency. Platform-target validation uses the runtime parser directly; this mirrors its exact
// ASCII authority grammar as a template-local defense in depth.
function normalizeRuntimeCompatibleMiniGameHttpsOrigin(value: string): string {
  const match = /^https:\/\/([A-Za-z\d](?:[A-Za-z\d.-]*[A-Za-z\d])?)(?::(\d{1,5}))?$/u.exec(
    value,
  );

  if (match === null) {
    throw new TypeError('Mini-game remote origin is invalid.');
  }
  const hostname = (match[1] ?? '').toLowerCase();
  const labels = hostname.split('.');

  if (
    hostname.length === 0
    || hostname.length > 253
    || hostname.includes('..')
    || labels.some((label) => (
      label.length === 0
      || label.length > 63
      || label.startsWith('-')
      || label.endsWith('-')
    ))
  ) {
    throw new TypeError('Mini-game remote origin is invalid.');
  }

  const portText = match[2];

  if (portText === undefined) {
    return `https://${hostname}`;
  }
  const port = Number(portText);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError('Mini-game remote origin is invalid.');
  }

  return `https://${hostname}${port === 443 ? '' : `:${String(port)}`}`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCatalogBaseDir(path: string, pairedPath: string, gameRoot: string): string {
  const candidates = [
    gameRoot,
    process.cwd(),
    readConfiguredPath(process.env.INIT_CWD),
    readConfiguredPath(process.env.PWD),
  ];

  for (const candidate of candidates) {
    if (
      candidate !== undefined
      && existsSync(resolve(candidate, path))
      && existsSync(resolve(candidate, pairedPath))
    ) {
      return candidate;
    }
  }

  throw new Error(
    `Could not locate catalog files (${path}, ${pairedPath}) in any expected directory; `
      + `checked: ${candidates.filter((candidate) => candidate !== undefined).join(', ')}.`,
  );
}
