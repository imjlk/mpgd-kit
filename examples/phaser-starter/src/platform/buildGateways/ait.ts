import { createAitPlatformGateway } from '@mpgd/adapter-ait';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  return createAitPlatformGateway({
    appVersion: runtime.appVersion,
    buildId: runtime.buildId,
  });
}
