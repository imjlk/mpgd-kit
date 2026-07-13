import { resolve } from 'node:path';

import { defineConfig } from 'vite';

import { createGameViteSharedConfig } from './vite.shared';

export { resolveBuildGatewayModule } from './vite.shared';

const gameRoot = process.cwd();

export default defineConfig(({ mode }) => {
  const appTarget = process.env.APP_TARGET ?? 'browser';
  const isDevvitBuild = appTarget === 'reddit';

  return {
    ...createGameViteSharedConfig({
      appTarget,
      gameRoot,
      mode,
      project: resolve(gameRoot, 'tsconfig.json'),
    }),
    build: {
      target: 'es2022',
      sourcemap: mode !== 'production',
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
      rolldownOptions: {
        ...(isDevvitBuild
          ? {
              input: {
                preview: resolve(gameRoot, 'index.html'),
                game: resolve(gameRoot, 'game.html'),
              },
            }
          : {}),
        output: {
          entryFileNames: isDevvitBuild ? 'assets/[name].js' : 'assets/game.js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  };
});
