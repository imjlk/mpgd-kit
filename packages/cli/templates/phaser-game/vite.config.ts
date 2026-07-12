import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

interface RuntimePlatformTargetMetadata {
  readonly kind: string;
  readonly adapter: string;
  readonly integrations?: Record<string, unknown>;
}

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';
  const platformTarget = readRuntimePlatformTarget();

  return {
    base: './',
    plugins: [
      ttsc({
        project: 'tsconfig.json',
        plugins: false,
      }),
    ],
    resolve: {
      alias: createCatalogAliases(),
    },
    define: {
      __APP_TARGET__: JSON.stringify(process.env.APP_TARGET ?? 'browser'),
      __MPGD_CONFIG_TARGET__: JSON.stringify(process.env.MPGD_CONFIG_TARGET ?? ''),
      __MPGD_PLATFORM_TARGET__:
        platformTarget === undefined ? 'undefined' : JSON.stringify(platformTarget),
      __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? '0.0.0-dev'),
      __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? 'local'),
      __SOURCE_GIT_SHA__: JSON.stringify(process.env.MPGD_SOURCE_GIT_SHA ?? 'uncommitted'),
      __DEBUG_BUILD__: JSON.stringify(!isProduction),
    },
    build: {
      target: 'es2022',
      sourcemap: !isProduction,
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          entryFileNames: 'assets/game.js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  };
});

function createCatalogAliases(): Record<string, string> {
  const productCatalogFile = readConfiguredPath(process.env.MPGD_PRODUCT_CATALOG_FILE);
  const adPlacementsFile = readConfiguredPath(process.env.MPGD_AD_PLACEMENTS_FILE);

  if ((productCatalogFile === undefined) !== (adPlacementsFile === undefined)) {
    throw new Error(
      'MPGD_PRODUCT_CATALOG_FILE and MPGD_AD_PLACEMENTS_FILE must be configured together.',
    );
  }

  if (productCatalogFile === undefined || adPlacementsFile === undefined) {
    return {};
  }

  return {
    '@mpgd/catalog/catalog.json': resolveCatalogPath(productCatalogFile, adPlacementsFile),
    '@mpgd/catalog/placements.json': resolveCatalogPath(adPlacementsFile, productCatalogFile),
  };
}

function readConfiguredPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function readRuntimePlatformTarget(): RuntimePlatformTargetMetadata | undefined {
  const targetsFile = readConfiguredPath(process.env.MPGD_PLATFORM_TARGETS_FILE);
  const configTarget = readConfiguredPath(process.env.MPGD_CONFIG_TARGET);

  if (targetsFile === undefined || configTarget === undefined) {
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

function resolveCatalogPath(path: string, pairedPath: string): string {
  return resolve(resolveCatalogBaseDir(path, pairedPath), path);
}

function resolveCatalogBaseDir(path: string, pairedPath: string): string {
  const fallbackBaseDir = process.cwd();
  const candidates = [
    fallbackBaseDir,
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

  return fallbackBaseDir;
}
