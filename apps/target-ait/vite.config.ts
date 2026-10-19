import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AitIapProductConfig } from '@mpgd/adapter-ait';
import { extractAitAdBridgeConfig, type AitAdBridgeConfig } from '@mpgd/adapter-ait/ad-config';
import { extractAitIapProductConfig } from '@mpgd/adapter-ait/iap-config';
import {
  extractAitNotificationTopicConfig,
  type AitNotificationTopicMapping,
} from '@mpgd/adapter-ait/notification-config';
import ttsc from '@ttsc/unplugin/vite';
import { defineConfig, type Plugin } from 'vite';

const aitAppName = process.env.MPGD_AIT_APP_NAME?.trim() || 'mpgd-kit';
const aitAdConfig = readAitAdConfig(process.env.MPGD_AD_PLACEMENTS_FILE);
const aitIapProducts = readAitIapProducts(process.env.MPGD_PRODUCT_CATALOG_FILE);
const aitNotificationTopics = readAitNotificationTopics(
  process.env.MPGD_NOTIFICATION_TOPICS_FILE,
  fileURLToPath(new URL('../../packages/catalog/notifications.json', import.meta.url)),
);
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
        iapProducts: aitIapProducts,
        notificationTopics: aitNotificationTopics,
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
  readonly iapProducts: readonly AitIapProductConfig[];
  readonly notificationTopics: Readonly<Record<string, AitNotificationTopicMapping>>;
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

/**
 * The notifications v2 topics come from the notification topic catalog
 * (`targets.ait`: `templateSetCode` and `agreement`) so the wrapper and the
 * backend share one source: `MPGD_NOTIFICATION_TOPICS_FILE`, else
 * the kit's `packages/catalog/notifications.json` when it exists. Without a catalog, or with no topic mapped
 * for Apps in Toss, the host bridge exposes no notifications.
 */
function readAitNotificationTopics(
  path: string | undefined,
  defaultPath: string,
): Readonly<Record<string, AitNotificationTopicMapping>> {
  const configured = path?.trim();
  const file = configured === undefined || configured.length === 0
    ? existsSync(defaultPath)
      ? defaultPath
      : undefined
    : configured;
  if (file === undefined) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`AIT notification topic catalog is unreadable or invalid JSON: ${file}`, {
      cause: error,
    });
  }

  return extractAitNotificationTopicConfig(parsed, { sourceLabel: file });
}
