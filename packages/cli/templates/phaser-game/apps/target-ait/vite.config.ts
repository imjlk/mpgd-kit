import { readFileSync } from 'node:fs';

import type { AitIapProductConfig } from '@mpgd/adapter-ait';
import { extractAitAdBridgeConfig, type AitAdBridgeConfig } from '@mpgd/adapter-ait/ad-config';
import { extractAitIapProductConfig } from '@mpgd/adapter-ait/iap-config';
import ttsc from '@ttsc/unplugin/vite';
import { defineConfig, type Plugin } from 'vite';

const aitAppName = process.env.MPGD_AIT_APP_NAME?.trim() || '__GAME_NAME__';
const aitAdConfig = readAitAdConfig(process.env.MPGD_AD_PLACEMENTS_FILE);
const aitIapProducts = readAitIapProducts(process.env.MPGD_PRODUCT_CATALOG_FILE);

export default defineConfig(({ command, isPreview }) => {
  const enableLocalAitMock = command === 'serve'
    && !isPreview
    && process.env.MPGD_AIT_LOCAL_MOCK !== '0';

  return {
    // Browser-only local development must not pretend that native rewards or
    // purchases are available. Production and console builds use the real SDK.
    ...(enableLocalAitMock
      ? {
          resolve: {
            alias: {
              '@apps-in-toss/web-framework': '@mpgd/adapter-ait/local-mock',
            },
          },
        }
      : {}),
    plugins: [
      createAitRuntimeConfigPlugin({
        appName: aitAppName,
        adGroupIds: aitAdConfig.adGroupIds,
        adPlacementTypes: aitAdConfig.adPlacementTypes,
        iapProducts: aitIapProducts,
      }),
      ...(command === 'build'
        ? [ttsc({ project: 'tsconfig.json', plugins: false })]
        : []),
    ],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});

function createAitRuntimeConfigPlugin(input: Readonly<{
  readonly appName: string;
  readonly adGroupIds: Readonly<Record<string, string>>;
  readonly adPlacementTypes: AitAdBridgeConfig['adPlacementTypes'];
  readonly iapProducts: readonly AitIapProductConfig[];
}>): Plugin {
  const publicId = 'virtual:mpgd-ait-runtime-config';
  const resolvedId = `\0${publicId}`;
  return {
    name: 'mpgd-ait-runtime-config',
    resolveId(id) {
      return id === publicId ? resolvedId : null;
    },
    load(id) {
      return id === resolvedId ? `export default Object.freeze(${JSON.stringify(input)});\n` : null;
    },
  };
}

function readAitAdConfig(path: string | undefined): AitAdBridgeConfig {
  if (path === undefined || path.trim().length === 0) {
    return { adGroupIds: {}, adPlacementTypes: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`AIT ad placements file is unreadable or invalid JSON: ${path}`, {
      cause: error,
    });
  }

  return extractAitAdBridgeConfig(parsed, path);
}

/**
 * The Apps in Toss SKUs come from the product catalog (`platformProductIds.ait`)
 * so the wrapper and the game share one source; without a configured catalog
 * file the wrapper sells nothing and the host bridge fails every purchase closed.
 */
function readAitIapProducts(path: string | undefined): readonly AitIapProductConfig[] {
  if (path === undefined || path.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`AIT product catalog file is unreadable or invalid JSON: ${path}`, {
      cause: error,
    });
  }

  return extractAitIapProductConfig(parsed, { sourceLabel: path });
}
