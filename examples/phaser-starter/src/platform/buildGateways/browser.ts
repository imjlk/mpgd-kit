import { createBrowserPlatformGateway } from '@mpgd/adapter-browser';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(_runtime: RuntimeConfig): Promise<PlatformGateway> {
  return createBrowserPlatformGateway();
}
