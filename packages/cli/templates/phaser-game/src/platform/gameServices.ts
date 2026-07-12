import {
  createGameServicesRuntime,
  resolveGameServicesAuthorityMode,
  type GameServicesRuntime,
  type GameServicesRuntimeMode,
} from '@mpgd/game-services';
import type { PlatformGateway } from '@mpgd/platform';

export type StarterBackendMode = GameServicesRuntimeMode;
export type StarterGameServices = GameServicesRuntime;

export function createStarterGameServices(input: {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
}): StarterGameServices {
  return createGameServicesRuntime({
    gateway: input.gateway,
    playerId: input.playerId,
    authorityMode: resolveGameServicesAuthorityMode(import.meta.env.MODE),
    target: import.meta.env.VITE_MPGD_GAME_SERVICES_TARGET ?? input.gateway.target,
    ...(import.meta.env.VITE_MPGD_GAME_SERVICES_URL === undefined
      ? {}
      : { baseUrl: import.meta.env.VITE_MPGD_GAME_SERVICES_URL }),
    transport: import.meta.env.VITE_MPGD_GAME_SERVICES_TRANSPORT === 'orpc' ? 'orpc' : 'http',
  });
}
