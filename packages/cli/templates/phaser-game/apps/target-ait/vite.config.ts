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
const aitAppName = process.env.MPGD_AIT_APP_NAME?.trim() || '__GAME_NAME__';
const aitAdConfig = readAitAdConfig(process.env.MPGD_AD_PLACEMENTS_FILE);

export default defineConfig(({ command, isPreview }) => ({
  define: {
    __MPGD_AIT_APP_NAME__: JSON.stringify(aitAppName),
    __MPGD_AIT_AD_GROUP_IDS__: JSON.stringify(aitAdConfig.adGroupIds),
    __MPGD_AIT_AD_PLACEMENT_TYPES__: JSON.stringify(aitAdConfig.adPlacementTypes),
  },
  plugins: [
    ...(command === 'serve' && !isPreview && process.env.MPGD_AIT_DEVTOOLS !== '0'
      ? [aitDevtools.vite({ mcp: true, tunnel: aitDevtoolsTunnel })]
      : []),
    ttsc({ project: 'tsconfig.json', plugins: false }),
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
}));

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
