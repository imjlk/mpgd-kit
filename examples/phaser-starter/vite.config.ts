import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    ttsc({
      project: 'tsconfig.json',
      plugins: false,
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
  },
});
