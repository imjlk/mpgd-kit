import { createVerse8PlatformGateway } from '@mpgd/adapter-verse8';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(_runtime: RuntimeConfig): Promise<PlatformGateway> {
  return createVerse8PlatformGateway();
}
