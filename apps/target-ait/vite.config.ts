import { readFileSync } from 'node:fs';

import aitDevtools from '@ait-co/devtools/unplugin';
import { extractAitAdBridgeConfig } from '@mpgd/adapter-ait/ad-config';
import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

const isTruthyEnv = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

const aitDevtoolsTunnel = isTruthyEnv(process.env.AIT_TUNNEL)
  ? { cdp: isTruthyEnv(process.env.AIT_TUNNEL_CDP) }
  : false;
const aitAppName = process.env.MPGD_AIT_APP_NAME?.trim() || 'mpgd-kit';
const aitAdConfig = readAitAdConfig(process.env.MPGD_AD_PLACEMENTS_FILE);

export default defineConfig(({ command, isPreview }) => {
  const enableAitDevtools = command === 'serve'
    && !isPreview
    && process.env.MPGD_AIT_DEVTOOLS !== '0';

  return {
    define: {
      __MPGD_AIT_APP_NAME__: JSON.stringify(aitAppName),
      __MPGD_AIT_AD_GROUP_IDS__: JSON.stringify(aitAdConfig.adGroupIds),
      __MPGD_AIT_AD_PLACEMENT_TYPES__: JSON.stringify(aitAdConfig.adPlacementTypes),
    },
    // Vite prebundles the Kit host before plugin resolve hooks run. An explicit development
    // alias keeps that optimized host while replacing its transitive native SDK import.
    ...(enableAitDevtools
      ? {
          resolve: {
            alias: {
              '@apps-in-toss/web-framework': '@ait-co/devtools/mock',
            },
          },
        }
      : {}),
    plugins: [
      ...(enableAitDevtools
        ? [aitDevtools.vite({ mcp: true, tunnel: aitDevtoolsTunnel })]
        : []),
      ttsc({
        project: 'tsconfig.bundle.json',
        plugins: false,
      }),
    ],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});

function readAitAdConfig(path: string | undefined): {
  readonly adGroupIds: Readonly<Record<string, string>>;
  readonly adPlacementTypes: Readonly<Record<string, 'rewarded' | 'interstitial'>>;
} {
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
