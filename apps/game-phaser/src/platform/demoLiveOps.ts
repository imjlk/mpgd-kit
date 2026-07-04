import type { AdPlacements } from '@mpgd/ad-placements';
import adPlacementsJson from '@mpgd/ad-placements/placements.json';
import {
  createInProcessLiveOpsBackendTransport,
  createLiveOpsBackendApiHandler,
} from '@mpgd/backend-liveops-api';
import {
  createLiveOpsClient,
  createLiveOpsHttpBackendApi,
  type LiveOpsClient,
} from '@mpgd/liveops-client';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform-contract';
import type { ProductCatalog } from '@mpgd/product-catalog';
import productCatalogJson from '@mpgd/product-catalog/catalog.json';

import type { DemoState } from './demoState';

const productCatalog = productCatalogJson as ProductCatalog;
const adPlacements = adPlacementsJson as AdPlacements;
const demoBackend = createLiveOpsHttpBackendApi({
  transport: createInProcessLiveOpsBackendTransport(
    createLiveOpsBackendApiHandler({
      catalog: productCatalog,
      placements: adPlacements,
    }),
  ),
});

export function createDemoLiveOpsClient(
  platform: PlatformGateway,
  state: DemoState,
): LiveOpsClient | null {
  if (!isStoreLiveOpsTarget(platform.target)) {
    return null;
  }

  return createLiveOpsClient({
    gateway: platform,
    playerId: state.player.playerId,
    target: platform.target,
    backend: demoBackend,
  });
}

function isStoreLiveOpsTarget(
  target: PlatformTarget,
): target is 'android' | 'ios' | 'ait' {
  return target === 'android' || target === 'ios' || target === 'ait';
}
