import type { AnalyticsSink } from '@mpgd/analytics';
import {
  createGameServicesRuntime,
  resolveGameServicesAuthorityMode,
  resolveGameServicesTransport,
  type GameServicesRuntime,
  type GameServicesRuntimeMode,
} from '@mpgd/game-services';
import type { PlatformGateway } from '@mpgd/platform';

export type StarterBackendMode = GameServicesRuntimeMode;
export type StarterGameServices = GameServicesRuntime;

export function createStarterGameServices(input: {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
}): StarterGameServices {
  return createGameServicesRuntime({
    gateway: input.gateway,
    playerId: input.playerId,
    ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
    ...(input.analyticsSessionId === undefined
      ? {}
      : { analyticsSessionId: input.analyticsSessionId }),
    authorityMode: resolveGameServicesAuthorityMode(import.meta.env.MODE),
    target: import.meta.env.VITE_MPGD_GAME_SERVICES_TARGET ?? input.gateway.target,
    ...(import.meta.env.VITE_MPGD_GAME_SERVICES_URL === undefined
      ? {}
      : { baseUrl: import.meta.env.VITE_MPGD_GAME_SERVICES_URL }),
    transport: resolveGameServicesTransport(import.meta.env.VITE_MPGD_GAME_SERVICES_TRANSPORT),
  });
}
