import { builtinModules } from 'node:module';

import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

const externalBuiltins = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

export default defineConfig({
  plugins: [
    ttsc({
      project: 'tsconfig.json',
      plugins: false,
    }),
  ],
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'dist/server',
    target: 'node22',
    minify: 'esbuild',
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      external: externalBuiltins,
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
        codeSplitting: false,
      },
    },
  },
});
