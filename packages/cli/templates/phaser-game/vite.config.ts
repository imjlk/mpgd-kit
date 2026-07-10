import { resolve } from 'node:path';

import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';

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
    '@mpgd/catalog/catalog.json': resolveCatalogPath(productCatalogFile),
    '@mpgd/catalog/placements.json': resolveCatalogPath(adPlacementsFile),
  };
}

function readConfiguredPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function resolveCatalogPath(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}
