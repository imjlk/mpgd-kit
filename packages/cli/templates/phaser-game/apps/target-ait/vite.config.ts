import { readFileSync } from 'node:fs';

import {
  extractAitAdBridgeConfig,
  type AitAdBridgeConfig,
} from '@mpgd/adapter-ait/ad-config';
import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

const aitAppName = process.env.MPGD_AIT_APP_NAME?.trim() || '__GAME_NAME__';
const aitAdConfig = readAitAdConfig(process.env.MPGD_AD_PLACEMENTS_FILE);

export default defineConfig(({ command, isPreview }) => {
  const enableLocalAitMock = command === 'serve'
    && !isPreview
    && process.env.MPGD_AIT_LOCAL_MOCK !== '0';

  return {
    define: {
      __MPGD_AIT_APP_NAME__: JSON.stringify(aitAppName),
      __MPGD_AIT_AD_GROUP_IDS__: JSON.stringify(aitAdConfig.adGroupIds),
      __MPGD_AIT_AD_PLACEMENT_TYPES__: JSON.stringify(aitAdConfig.adPlacementTypes),
    },
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
      ttsc({ project: 'tsconfig.json', plugins: false }),
    ],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});

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
