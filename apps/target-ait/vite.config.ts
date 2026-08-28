import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  extractAitAdBridgeConfig,
  type AitAdBridgeConfig,
} from '@mpgd/adapter-ait/ad-config';
import ttsc from '@ttsc/unplugin/vite';
import { defineConfig, type Plugin } from 'vite';

const aitAppName = process.env.MPGD_AIT_APP_NAME?.trim() || 'mpgd-kit';
const aitAdConfig = readAitAdConfig(process.env.MPGD_AD_PLACEMENTS_FILE);
const aitLocalMockPath = fileURLToPath(
  new URL('../../adapters/ait/src/local-mock.ts', import.meta.url),
);

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
              // Resolve source directly: the local wrapper must work in a
              // fresh workspace before package build artifacts exist.
              '@apps-in-toss/web-framework': aitLocalMockPath,
            },
          },
        }
      : {}),
    plugins: [
      createAitRuntimeConfigPlugin({
        appName: aitAppName,
        adGroupIds: aitAdConfig.adGroupIds,
        adPlacementTypes: aitAdConfig.adPlacementTypes,
      }),
      ...(command === 'build'
        ? [
          ttsc({
            project: 'tsconfig.bundle.json',
            plugins: false,
          }),
        ]
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
}>): Plugin {
  const publicId = 'virtual:mpgd-ait-runtime-config';
  const resolvedId = `\0${publicId}`;
  return {
    name: 'mpgd-ait-runtime-config',
    resolveId(id) {
      return id === publicId ? resolvedId : null;
    },
    load(id) {
      return id === resolvedId
        ? `export default Object.freeze(${JSON.stringify(input)});\n`
        : null;
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
