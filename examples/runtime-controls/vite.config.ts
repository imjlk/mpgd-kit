import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@mpgd/game-runtime/actions', replacement: fileURLToPath(new URL('../../packages/game-runtime/src/actions/index.ts', import.meta.url)) },
      { find: '@mpgd/game-runtime/platform', replacement: fileURLToPath(new URL('../../packages/game-runtime/src/platform/index.ts', import.meta.url)) },
      { find: '@mpgd/game-runtime/ui', replacement: fileURLToPath(new URL('../../packages/game-runtime/src/ui/index.ts', import.meta.url)) },
      { find: '@mpgd/game-runtime', replacement: fileURLToPath(new URL('../../packages/game-runtime/src/index.ts', import.meta.url)) },
      { find: '@mpgd/phaser-game-runtime', replacement: fileURLToPath(new URL('../../packages/phaser-game-runtime/src/index.ts', import.meta.url)) },
    ],
  },
});
