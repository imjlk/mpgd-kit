import { resolve } from 'node:path';

import ttsc from '@ttsc/unplugin/vite';
import type { PluginOption } from 'vite';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
  },
  server: {
    port: 5198,
  },
  plugins: [
    ttsc({
      plugins: false,
      project: resolve(import.meta.dirname, 'tsconfig.json'),
    }) as unknown as PluginOption,
  ],
  resolve: {
    alias: [
      {
        find: '@mpgd/tutorial/driver.css',
        replacement: resolve(import.meta.dirname, '../../packages/tutorial/driver.css'),
      },
      {
        find: '@mpgd/tutorial/platform-storage',
        replacement: resolve(import.meta.dirname, '../../packages/tutorial/src/platform-storage.ts'),
      },
      {
        find: '@mpgd/tutorial/driver',
        replacement: resolve(import.meta.dirname, '../../packages/tutorial/src/driver.ts'),
      },
      {
        find: '@mpgd/tutorial/testing',
        replacement: resolve(import.meta.dirname, '../../packages/tutorial/src/testing.ts'),
      },
      {
        find: '@mpgd/tutorial',
        replacement: resolve(import.meta.dirname, '../../packages/tutorial/src/index.ts'),
      },
    ],
  },
});
