import { createAitPlatformGateway, createAitSandboxBridge } from '@mpgd/adapter-ait';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

/**
 * Local Apps in Toss playtest. The sandbox bridge keeps its build-id gate: only
 * the `ait-sandbox` build (`pnpm dev:ait`) gets the `commerceV2` channel and
 * the evidence-only v2 stub; any other build id gets no channel, so the
 * gateway offers no `commerceV2` and the v2 methods answer
 * `COMMERCE_V2_UNAVAILABLE`. It also refuses `intoss://` share links for any
 * app but this game's, the name the wrapper's host bridge uses.
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
