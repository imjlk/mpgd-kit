import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vitest/config';

// The commerce module compiles its typia validators through ttsc. Vitest runs
// the same transform so source tests exercise the generated checks.
export default defineConfig({
  plugins: [ttsc({ project: 'tsconfig.json' })],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
