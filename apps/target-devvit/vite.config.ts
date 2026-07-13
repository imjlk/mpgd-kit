import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { devvit } from '@devvit/start/vite';
import { defineConfig } from 'vite';

import { createGameViteSharedConfig } from '../../examples/phaser-starter/vite.shared';

const wrapperRoot = fileURLToPath(new URL('.', import.meta.url));
const gameRoot = resolve(wrapperRoot, '../../examples/phaser-starter');

export default defineConfig(({ mode }) => {
  const shared = createGameViteSharedConfig({
    appTarget: 'reddit',
    configTarget: 'reddit',
    gameRoot,
    mode,
    platformTargetsFile: resolve(gameRoot, 'mpgd.targets.json'),
    project: resolve(wrapperRoot, 'tsconfig.json'),
  });

  return {
    ...shared,
    publicDir: resolve(gameRoot, 'public'),
    plugins: [
      ...(shared.plugins ?? []),
      devvit({
        client: {
          build: {
            sourcemap: mode !== 'production',
          },
        },
        server: {
          build: {
            sourcemap: mode !== 'production',
          },
        },
      }),
    ],
  };
});
