import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vitest/config';

// The commerce module compiles its typia validators through ttsc. Vitest runs
// the same transform so source tests exercise the generated checks.
export default defineConfig({
  plugins: [ttsc({ project: 'tsconfig.json' })],
  test: {
    include: ['src/**/*.test.ts'],
    // Vitest 5 persists transformed modules keyed by each file's source and
    // config, not by other files a plugin reads, but typia expands validators
    // from types declared in other files. A cached test would keep its old
    // validator after such a type changes.
    fsModuleCache: false,
  },
});
