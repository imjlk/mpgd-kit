import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ttsc from '@ttsc/unplugin/vite';
import type { UserConfig } from 'vite';

interface RuntimePlatformTargetMetadata {
  readonly kind: string;
  readonly adapter: string;
  readonly integrations?: Record<string, unknown>;
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

export function createGameViteSharedConfig(
  input: CreateGameViteSharedConfigInput,
): UserConfig {
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

  return {
    base: './',
    plugins: [
      ttsc({
        project: input.project,
        plugins: false,
      }),
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
        platformTarget === undefined ? 'undefined' : JSON.stringify(platformTarget),
      __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? '0.0.0-dev'),
      __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? 'local'),
      __SOURCE_GIT_SHA__: JSON.stringify(process.env.MPGD_SOURCE_GIT_SHA ?? 'uncommitted'),
      __DEBUG_BUILD__: JSON.stringify(!isProduction),
    },
  };
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

  return {
    kind: target.kind,
    adapter: target.adapter,
    ...(target.integrations === undefined ? {} : { integrations: target.integrations }),
  };
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
