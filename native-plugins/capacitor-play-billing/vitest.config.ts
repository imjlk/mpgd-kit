import { defineConfig } from 'vitest/config';

// `src/provider.test.ts` is the v1 script-style test run through ttsx by the
// package `test` script; vitest owns the commerce v2 suites.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/provider.test.ts', '**/node_modules/**'],
  },
});
