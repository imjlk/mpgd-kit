import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  return createCapacitorPlatformGateway({
    target: 'ios',
    appVersion: runtime.appVersion,
    buildId: runtime.buildId,
  });
}
