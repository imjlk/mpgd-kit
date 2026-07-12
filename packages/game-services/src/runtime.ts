import type { AnalyticsSink } from '@mpgd/analytics';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform';

import {
  createGameServicesClient,
  createGameServicesFetchBackendTransport,
  createGameServicesHttpBackendApi,
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
  type GameServicesBackendApi,
  type GameServicesClient,
} from './client.js';
import type { GameServicesLedgerTarget } from './types.js';

export type GameServicesAuthorityMode = 'production' | 'non-production';
export type GameServicesRuntimeMode = 'disabled' | 'local' | 'http' | 'orpc';
export type GameServicesDisabledReason =
  | 'unsupported_target'
  | 'missing_authoritative_backend'
  | 'local_backend_not_allowed'
  | 'local_backend_unavailable';

export interface GameServicesRuntime {
  readonly mode: GameServicesRuntimeMode;
  readonly reason?: GameServicesDisabledReason;
  readonly baseUrl?: string;
  readonly target?: GameServicesLedgerTarget;
  readonly client?: GameServicesClient;
}

export interface CreateGameServicesRuntimeInput {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
  readonly authorityMode: GameServicesAuthorityMode;
  readonly target?: PlatformTarget | string;
  readonly baseUrl?: string;
  readonly transport?: 'http' | 'orpc';
  readonly allowLocalBackend?: boolean;
  readonly localBackend?: GameServicesBackendApi;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
  readonly now?: () => string;
}

export function createGameServicesRuntime(
  input: CreateGameServicesRuntimeInput,
): GameServicesRuntime {
  assertAuthorityMode(input.authorityMode);

  const target = resolveGameServicesLedgerTarget(input.target ?? input.gateway.target);

  if (target === null) {
    return disabledRuntime('unsupported_target');
  }

  const baseUrl = normalizeBaseUrl(input.baseUrl);
  let backend: GameServicesBackendApi;
  let mode: Exclude<GameServicesRuntimeMode, 'disabled'>;

  if (baseUrl !== undefined) {
    mode = input.transport === 'orpc' ? 'orpc' : 'http';
    backend = mode === 'orpc'
      ? createGameServicesOrpcBackendApi(createGameServicesOrpcClient({ url: baseUrl }))
      : createGameServicesHttpBackendApi({
          transport: createGameServicesFetchBackendTransport({ baseUrl }),
        });
  } else {
    if (input.authorityMode === 'production') {
      return disabledRuntime('missing_authoritative_backend', target);
    }

    if (input.allowLocalBackend !== true) {
      return disabledRuntime('local_backend_not_allowed', target);
    }

    if (input.localBackend === undefined) {
      return disabledRuntime('local_backend_unavailable', target);
    }

    mode = 'local';
    backend = input.localBackend;
  }

  return {
    mode,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    target,
    client: createGameServicesClient({
      gateway: input.gateway,
      backend,
      playerId: input.playerId,
      target,
      ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
      ...(input.analyticsSessionId === undefined
        ? {}
        : { analyticsSessionId: input.analyticsSessionId }),
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
  };
}

export function resolveGameServicesLedgerTarget(
  target: PlatformTarget | string,
): GameServicesLedgerTarget | null {
  if (
    target === 'browser'
    || target === 'android'
    || target === 'ios'
    || target === 'ait'
    || target === 'reddit'
  ) {
    return target;
  }

  return null;
}

function disabledRuntime(
  reason: GameServicesDisabledReason,
  target?: GameServicesLedgerTarget,
): GameServicesRuntime {
  return {
    mode: 'disabled',
    reason,
    ...(target === undefined ? {} : { target }),
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = baseUrl?.trim();

  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function assertAuthorityMode(
  authorityMode: GameServicesAuthorityMode,
): asserts authorityMode is GameServicesAuthorityMode {
  if (authorityMode !== 'production' && authorityMode !== 'non-production') {
    throw new Error('authorityMode must be production or non-production.');
  }
}
