import type { AdPlacements } from '@mpgd/ad-placements';
import adPlacementsJson from '@mpgd/ad-placements/placements.json';
import {
  createGameServicesBackendApiHandler,
  createInProcessGameServicesBackendTransport,
} from '@mpgd/backend-game-services';
import {
  createGameServicesClient,
  createGameServicesHttpBackendApi,
  type GameServicesClient,
} from '@mpgd/game-services-client';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform-contract';
import type { ProductCatalog } from '@mpgd/product-catalog';
import productCatalogJson from '@mpgd/product-catalog/catalog.json';

import type { DemoState } from './demoState';

const productCatalog = productCatalogJson as ProductCatalog;
const adPlacements = adPlacementsJson as AdPlacements;
const demoBackend = createGameServicesHttpBackendApi({
  transport: createInProcessGameServicesBackendTransport(
    createGameServicesBackendApiHandler({
      catalog: productCatalog,
      placements: adPlacements,
    }),
  ),
});

export function createDemoGameServicesClient(
  platform: PlatformGateway,
  state: DemoState,
): GameServicesClient | null {
  if (!isStoreGameServicesTarget(platform.target)) {
    return null;
  }

  return createGameServicesClient({
    gateway: platform,
    playerId: state.player.playerId,
    target: platform.target,
    backend: demoBackend,
  });
}

function isStoreGameServicesTarget(
  target: PlatformTarget,
): target is 'android' | 'ios' | 'ait' {
  return target === 'android' || target === 'ios' || target === 'ait';
}
