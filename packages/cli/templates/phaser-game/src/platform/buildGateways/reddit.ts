import { createDevvitPlatformGateway } from '@mpgd/adapter-devvit';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  return createDevvitPlatformGateway({
    appVersion: runtime.appVersion,
    buildId: runtime.buildId,
  });
}
