import {
  createGameServicesRuntime,
  type CreateGameServicesRuntimeInput,
} from '@mpgd/game-services/runtime';
import type { GameServicesBackendTransport } from '@mpgd/game-services/client';
import type { PlatformGateway } from '@mpgd/platform';

declare const gateway: PlatformGateway;
declare const transport: GameServicesBackendTransport;

const http: CreateGameServicesRuntimeInput = {
  gateway,
  playerId: 'packed-player',
  authorityMode: 'production',
  baseUrl: 'https://api.example.com',
  transport: 'http',
  httpTransport: transport,
  getHeaders: async () => ({ authorization: 'Bearer refreshed' }),
};
createGameServicesRuntime(http);

// A fixed JSON endpoint transport is not a general oRPC Fetch implementation.
// @ts-expect-error oRPC does not accept an HTTP JSON transport.
const invalidOrpc: CreateGameServicesRuntimeInput = { ...http, transport: 'orpc' };
void invalidOrpc;
