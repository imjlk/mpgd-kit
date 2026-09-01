import { resolve } from 'node:path';

import { defineConfig } from 'vite';

import { createGameViteSharedConfig } from './vite.shared';
import { resolveMiniGameBundleOutput } from './vite.minigame-output';
import { createPhaserMiniGameStaticGlobalPlugin } from './vite.minigame-phaser';

const gameRoot = process.cwd();

export default defineConfig(({ mode }) => {
  const appTarget = process.env.APP_TARGET;
  const bundleKind = process.env.MPGD_MINIGAME_BUNDLE_KIND;
  const outDir = process.env.MPGD_MINIGAME_BUNDLE_OUTPUT_DIR;
  const stagingRoot = process.env.MPGD_MINIGAME_BUNDLE_STAGING_ROOT;

  if (appTarget !== 'wechat') {
    throw new Error(`Unsupported Mini Game bundle target: ${String(appTarget)}`);
  }
  if (bundleKind !== 'runtime' && bundleKind !== 'game') {
    throw new Error(`Unsupported Mini Game bundle kind: ${String(bundleKind)}`);
  }
  if (outDir === undefined || outDir.trim().length === 0) {
    throw new Error('MPGD_MINIGAME_BUNDLE_OUTPUT_DIR is required.');
  }
  if (stagingRoot === undefined || stagingRoot.trim().length === 0) {
    throw new Error('MPGD_MINIGAME_BUNDLE_STAGING_ROOT is required.');
  }
  const resolvedOutDir = resolveMiniGameBundleOutput({
    gameRoot,
    outputDir: outDir,
    stagingRoot,
  });

  const entry = bundleKind === 'runtime'
    ? resolve(gameRoot, 'src/platform/minigameRuntime/wechat.ts')
    : resolve(gameRoot, 'src/minigameEntry.ts');
  const fileName = bundleKind === 'runtime' ? 'runtime.js' : 'game.bundle.js';
  const sharedConfig = createGameViteSharedConfig({
    appTarget,
    gameRoot,
    mode,
    project: resolve(gameRoot, 'tsconfig.json'),
  });

  return {
    ...sharedConfig,
    plugins: bundleKind === 'game'
      ? [...sharedConfig.plugins, createPhaserMiniGameStaticGlobalPlugin()]
      : sharedConfig.plugins,
    build: {
      target: 'es2020',
      outDir: resolvedOutDir,
      emptyOutDir: true,
      copyPublicDir: false,
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 2_000,
      rolldownOptions: {
        input: entry,
        output: {
          format: 'iife',
          name: bundleKind === 'runtime' ? 'MPGDWechatRuntime' : 'MPGDWechatGame',
          entryFileNames: fileName,
          chunkFileNames: 'forbidden-[name].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
