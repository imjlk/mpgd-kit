import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import adPlacementsJson from '@mpgd/catalog/placements.json';
import {
  createGameServicesBackendApiHandler,
  createGameServicesClient,
  createGameServicesHttpBackendApi,
  createInProcessGameServicesBackendTransport,
  type GameServicesClient,
} from '@mpgd/game-services';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform';

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
  if (!isDemoGameServicesTarget(platform.target)) {
    return null;
  }

  return createGameServicesClient({
    gateway: platform,
    playerId: state.player.playerId,
    target: platform.target,
    backend: demoBackend,
  });
}

function isDemoGameServicesTarget(
  target: PlatformTarget,
): target is 'android' | 'ios' | 'ait' | 'reddit' {
  return target === 'android' || target === 'ios' || target === 'ait' || target === 'reddit';
}
