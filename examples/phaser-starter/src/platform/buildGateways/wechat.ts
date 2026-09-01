import type { PlatformGateway } from '@mpgd/platform';

import { requireStarterMiniGameRuntimeBridge } from '../minigameBridge';
import type { RuntimeConfig } from '../runtimeDetector';

export async function createBuildGateway(_runtime: RuntimeConfig): Promise<PlatformGateway> {
  return requireStarterMiniGameRuntimeBridge('wechat').gateway;
}
