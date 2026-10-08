import {
  createGameServicesRuntime,
  resolveGameServicesAuthorityMode,
  resolveGameServicesTransport,
  type GameServicesRuntime,
  type GameServicesRuntimeMode,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import type { PlatformGateway } from '@mpgd/platform';
import type { GameActionReconciliationPort } from '@mpgd/game-runtime/actions';
import type { PurchasePresentationEvent } from '@mpgd/game-runtime/ads';

/** Supply a game-owned durable encrypted journal and trusted recovery/native facts. */
export interface StarterMonetizationPorts {
  readonly operationStore: MonetizationOperationStore;
  readonly reconciliation?: GameActionReconciliationPort;
  readonly purchasePresentation?: { subscribe(listener: (event: PurchasePresentationEvent) => void): () => void };
}

export type StarterBackendMode = GameServicesRuntimeMode;
export type StarterGameServices = GameServicesRuntime;

export function createStarterGameServices(input: {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
  readonly configTarget: string;
  readonly operationStore?: MonetizationOperationStore;
}): StarterGameServices {
  return createGameServicesRuntime({
    gateway: input.gateway,
    playerId: input.playerId,
    ...(input.operationStore === undefined ? {} : { operationStore: input.operationStore }),
    authorityMode: resolveGameServicesAuthorityMode(import.meta.env.MODE),
    target: import.meta.env.VITE_MPGD_GAME_SERVICES_TARGET ?? input.gateway.target,
    deploymentTarget: input.configTarget,
    ...(import.meta.env.VITE_MPGD_GAME_SERVICES_URL === undefined
      ? {}
      : { baseUrl: import.meta.env.VITE_MPGD_GAME_SERVICES_URL }),
    transport: resolveGameServicesTransport(import.meta.env.VITE_MPGD_GAME_SERVICES_TRANSPORT),
  });
}
