import {
  createGameServicesRuntime,
  type CreateGameServicesRuntimeInput,
} from '@mpgd/game-services/runtime';
import type { GameServicesBackendTransport } from '@mpgd/game-services/client';
import {
  createGuestSessionCoordinator,
  type GuestSessionBackend,
} from '@mpgd/game-services/guest-session';
import type { PlatformGateway, SecureCredentialStore } from '@mpgd/platform';

declare const gateway: PlatformGateway;
declare const transport: GameServicesBackendTransport;
declare const secureCredentials: SecureCredentialStore;
declare const guestBackend: GuestSessionBackend;

const guest = createGuestSessionCoordinator({
  installationId: 'packed-installation',
  credentials: secureCredentials,
  backend: guestBackend,
});
const guestHeaders: Readonly<Record<'authorization', string>> = guest.getHeaders();
void guestHeaders;

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
