import {
  createGameServicesClient,
  createGameServicesFetchBackendTransport,
  createGameServicesHttpBackendApi,
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
  type GameServicesClient,
  type GameServicesStoreTarget,
} from '@mpgd/game-services-client';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform-contract';

export type StarterBackendMode = 'disabled' | 'http' | 'orpc';

export interface StarterGameServices {
  readonly mode: StarterBackendMode;
  readonly baseUrl?: string;
  readonly target?: GameServicesStoreTarget;
  readonly client?: GameServicesClient;
}

export function createStarterGameServices(input: {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
}): StarterGameServices {
  const baseUrl = import.meta.env.VITE_MPGD_GAME_SERVICES_URL;
  const requestedMode = import.meta.env.VITE_MPGD_GAME_SERVICES_TRANSPORT;
  const storeTarget = readStoreTarget(
    import.meta.env.VITE_MPGD_GAME_SERVICES_TARGET ?? input.gateway.target,
  );

  if (baseUrl === undefined || baseUrl.length === 0 || storeTarget === null) {
    return {
      mode: 'disabled',
    };
  }

  const mode = requestedMode === 'orpc' ? 'orpc' : 'http';
  const backend =
    mode === 'orpc'
      ? createGameServicesOrpcBackendApi(
          createGameServicesOrpcClient({
            url: baseUrl,
          }),
        )
      : createGameServicesHttpBackendApi({
          transport: createGameServicesFetchBackendTransport({
            baseUrl,
          }),
        });

  return {
    mode,
    baseUrl,
    target: storeTarget,
    client: createGameServicesClient({
      gateway: input.gateway,
      backend,
      playerId: input.playerId,
      target: storeTarget,
    }),
  };
}

function readStoreTarget(target: PlatformTarget | string): GameServicesStoreTarget | null {
  if (target === 'android' || target === 'ios' || target === 'ait') {
    return target;
  }

  return null;
}
