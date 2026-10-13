import { createAitPlatformGateway, createAitSandboxBridge } from '@mpgd/adapter-ait';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

/**
 * Local Apps in Toss playtest. The sandbox bridge keeps its build-id gate: only
 * the `ait-sandbox` build (`pnpm dev:ait`) gets the commerce event channel and
 * the evidence-only v2 stub; any other build id gets no channel, so the
 * gateway offers no `commerce` provider and the v2 methods answer
 * `COMMERCE_V2_UNAVAILABLE`. Every build answers the `notifications.v2.*`
 * methods with `NOTIFICATIONS_V2_UNAVAILABLE` until the Apps in Toss
 * notifications provider lands.
 */
export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  return createAitPlatformGateway({
    appVersion: runtime.appVersion,
    buildId: runtime.buildId,
    fallbackBridge: createAitSandboxBridge({
      appName: __MPGD_AIT_APP_NAME__,
      buildId: runtime.buildId,
    }),
  });
}
