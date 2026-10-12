import { createAitPlatformGateway } from '@mpgd/adapter-ait';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

/**
 * Apps in Toss gateway over the wrapper's host bridge. Commerce lives on the
 * host side: the wrapper (`apps/target-ait`) installs the IAP products from
 * the catalog's `platformProductIds.ait` entries and serves the six
 * `commerce.v2.*` methods plus the `commerceV2` event channel, so the gateway
 * exposes `commerce` whenever the installed bridge has that channel. The
 * host's grant callback only confirms through the game backend; nothing is
 * granted from this side.
 */
export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  return createAitPlatformGateway({
    appVersion: runtime.appVersion,
    buildId: runtime.buildId,
  });
}
