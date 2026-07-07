import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: '../../artifacts/legal-site',
  plugins: [
    ttsc({
      project: 'tsconfig.json',
      plugins: false,
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: 'src/worker.ts',
      formats: ['es'],
      fileName: () => '_worker.js',
    },
    rollupOptions: {
      output: {
        entryFileNames: '_worker.js',
      },
    },
  },
});
