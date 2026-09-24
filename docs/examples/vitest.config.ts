import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

const platformSource = fileURLToPath(
  new URL('../../packages/platform/src/index.ts', import.meta.url),
);
const conformanceSource = fileURLToPath(
  new URL('../../packages/platform/src/capability-conformance.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [
      { find: '@mpgd/platform/capability-conformance', replacement: conformanceSource },
      { find: '@mpgd/platform', replacement: platformSource },
    ],
  },
  test: {
    include: ['docs/examples/**/*.test.ts'],
  },
});
