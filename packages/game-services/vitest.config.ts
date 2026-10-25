import { defineConfig } from 'vitest/config';

// The other source tests are plain ttsx scripts run by `test:unit`; vitest runs
// the App Store server adapter tests: one mocks Apple's library, the other
// verifies signed notification vectors through the real library.
export default defineConfig({
  test: {
    include: ['src/app-store-server.test.ts', 'src/app-store-server-notification-vectors.test.ts'],
  },
});
