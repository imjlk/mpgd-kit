import { defineConfig } from 'vitest/config';

// The other source tests are plain ttsx scripts run by `test:unit`; only the
// App Store server verifier test mocks Apple's library through vitest.
export default defineConfig({
  test: {
    include: ['src/app-store-server.test.ts'],
  },
});
