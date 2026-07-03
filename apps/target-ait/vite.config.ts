import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    ttsc({
      project: 'tsconfig.bundle.json',
      plugins: false,
    }),
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
