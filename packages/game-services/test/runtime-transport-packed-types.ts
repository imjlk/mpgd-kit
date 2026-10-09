import {
  createGameServicesRuntime,
  type CreateGameServicesRuntimeInput,
} from '@mpgd/game-services/runtime';
import type {
  GameServicesBackendApi,
  GameServicesBackendTransport,
} from '@mpgd/game-services/client';
import {
  createGuestSessionCoordinator,
  type GuestSessionBackend,
} from '@mpgd/game-services/guest-session';
import type { PlatformGateway, SecureCredentialStore } from '@mpgd/platform';
import type { MonetizationOperationStore } from '@mpgd/game-services';

declare const gateway: PlatformGateway;
declare const transport: GameServicesBackendTransport;
declare const secureCredentials: SecureCredentialStore;
declare const guestBackend: GuestSessionBackend;
declare const operationStore: MonetizationOperationStore;

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
const recoverable: CreateGameServicesRuntimeInput = { ...http, operationStore };
const recoveryRuntime = createGameServicesRuntime(recoverable);
void recoveryRuntime.monetizationRecovery;

// A fixed JSON endpoint transport is not a general oRPC Fetch implementation.
// @ts-expect-error oRPC does not accept an HTTP JSON transport.
const invalidOrpc: CreateGameServicesRuntimeInput = { ...http, transport: 'orpc' };
void invalidOrpc;

import { createOnePlayPurchaseClient } from '@mpgd/game-services/oneplay-purchase-client';
import {
  createOnePlayCheckoutIntentIssuer,
  createOnePlayPurchaseBoundary,
  type OnePlayCheckoutIntentStore,
} from '@mpgd/game-services/oneplay-purchase';
import { createOnePlayPnsReceiver } from '@mpgd/game-services/oneplay-pns';

declare const checkoutStore: OnePlayCheckoutIntentStore;
declare const catalog: Parameters<typeof createOnePlayCheckoutIntentIssuer>[0]['catalog'];
declare const backend: GameServicesBackendApi;
const oneplayClient = createOnePlayPurchaseClient({
  clientId: 'application',
  clientSecret: 'server-only',
  environment: 'SANDBOX',
});
const checkout = createOnePlayCheckoutIntentIssuer({
  client: oneplayClient,
  store: checkoutStore,
  catalog,
});
void checkout.issue({ playerId: 'authenticated', productId: 'COINS', idempotencyKey: 'claim' });
const boundary = createOnePlayPurchaseBoundary({ client: oneplayClient, store: checkoutStore });
createOnePlayPnsReceiver({
  publicKey: 'license-key',
  client: oneplayClient,
  boundary,
  backend,
  onCancelled: async (purchase) => {
    void purchase.verificationId;
  },
});
