import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';

  return {
    plugins: [
      ttsc({
        project: 'tsconfig.json',
        plugins: false,
      }),
    ],
    define: {
      __APP_TARGET__: JSON.stringify(process.env.APP_TARGET ?? 'browser'),
      __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? '0.0.0-dev'),
      __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? 'local'),
      __DEBUG_BUILD__: JSON.stringify(!isProduction),
    },
    build: {
      target: 'es2022',
      sourcemap: !isProduction,
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          entryFileNames: 'assets/game.js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  };
});
