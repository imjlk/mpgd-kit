import type { PlatformGateway } from '@mpgd/platform-contract';

import type { RuntimeConfig } from './runtimeDetector';

export async function installPlatform(runtime: RuntimeConfig): Promise<PlatformGateway> {
  switch (runtime.target) {
    case 'android':
    case 'ios': {
      const { createCapacitorPlatformGateway } = await import('@mpgd/adapter-capacitor');
      return createCapacitorPlatformGateway({
        target: runtime.target,
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
      });
    }

    case 'ait': {
      const { createAitPlatformGateway } = await import('@mpgd/adapter-ait');
      return createAitPlatformGateway({
        appVersion: runtime.appVersion,
        buildId: runtime.buildId,
      });
    }

    default: {
      const { createBrowserPlatformGateway } = await import('@mpgd/adapter-browser');
      return createBrowserPlatformGateway();
    }
  }
}
