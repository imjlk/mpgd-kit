import type { AnalyticsSink } from '@mpgd/analytics';
import type { ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import {
  createGameServicesRuntime,
  resolveGameServicesAuthorityMode,
  resolveGameServicesTransport,
  type GameServicesHeaderResolver,
  type GameServicesRuntime,
  type GameServicesRuntimeMode,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import type { PlatformGateway } from '@mpgd/platform';
import type { GameActionReconciliationPort } from '@mpgd/game-runtime/actions';
import type { PurchasePresentationEvent } from '@mpgd/game-runtime/ads';

import { resolveStarterCommerceProducts } from './commerceProducts';
import { createStorageMonetizationOperationStore } from './monetizationJournal';

const productCatalog = productCatalogJson as ProductCatalog;

/**
 * Game-owned monetization ports. `operationStore` replaces the reference
 * journal over platform storage with an encrypted, access-controlled one;
 * `reconciliation` and `purchasePresentation` supply trusted native facts.
 */
export interface StarterMonetizationPorts {
  readonly operationStore: MonetizationOperationStore;
  readonly reconciliation?: GameActionReconciliationPort;
  readonly purchasePresentation?: { subscribe(listener: (event: PurchasePresentationEvent) => void): () => void };
}

/**
 * The game's server-backed session: who is signed in to the game backend,
 * and the `Authorization` header for that session. The starter has none, so
 * `resolveStarterServerSession` returns `undefined`. Return yours there (for
 * example over a `GuestSessionCoordinator` from `@mpgd/game-services` and
 * your identity service): the commerce client then sends its header, and,
 * in a game created with `--providers notifications`, the notifications
 * runtime uses the same session and header for the game-services Worker's
 * notification routes.
 */
export interface StarterServerSession {
  /**
   * The signed-in player and session, or `undefined` while signed out.
   * `sessionId` stays the same across token refreshes: it is the
   * `sessionId` your identity service answers to the Worker's
   * `authenticateNotificationSession`.
   */
  current(): { readonly playerId: string; readonly sessionId: string } | undefined;
  /** Calls `listener` when a session becomes current (sign-in, restore, account switch); returns the unsubscribe. */
  onAuthenticated(
    listener: (session: { readonly playerId: string; readonly sessionId: string }) => void,
  ): () => void;
  /** The current session's request headers, such as `{ authorization: 'Bearer …' }`. */
  readonly getHeaders: GameServicesHeaderResolver;
}

let serverSession: StarterServerSession | undefined;

/** The game's server-backed session; `undefined` until the game sets one with `setStarterServerSession`. */
export function resolveStarterServerSession(): StarterServerSession | undefined {
  return serverSession;
}

/**
 * Sets the game's server-backed session. Call it at the top of `main.ts`,
 * before `bootstrap()`: `createStarterGameServices` reads it once, and the
 * notification settings and opens read it until a backend exists. Its
 * `current()` may answer `undefined` until the player signs in.
 */
export function setStarterServerSession(session: StarterServerSession | undefined): void {
  serverSession = session;
}

export type StarterBackendMode = GameServicesRuntimeMode;
export type StarterGameServices = GameServicesRuntime;

/**
 * Game-services runtime over the commerce v2 reconciler: every purchase is
 * journaled in a durable `MonetizationOperationStore` (the reference journal
 * over the platform storage adapter unless the game supplies its own) and
 * verified through the backend ledger, with the catalog's kinds and SKUs for
 * the gateway target resolved without a store read.
 */
export function createStarterGameServices(input: {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
  readonly configTarget: string;
  readonly operationStore?: MonetizationOperationStore;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
}): StarterGameServices {
  const session = resolveStarterServerSession();
  return createGameServicesRuntime({
    gateway: input.gateway,
    playerId: input.playerId,
    operationStore: input.operationStore
      ?? createStorageMonetizationOperationStore({ storage: input.gateway.storage }),
    commerceProducts: resolveStarterCommerceProducts(productCatalog, input.configTarget),
    ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
    ...(input.analyticsSessionId === undefined
      ? {}
      : { analyticsSessionId: input.analyticsSessionId }),
    authorityMode: resolveGameServicesAuthorityMode(import.meta.env.MODE),
    target: import.meta.env.VITE_MPGD_GAME_SERVICES_TARGET ?? input.gateway.target,
    deploymentTarget: input.configTarget,
    ...(import.meta.env.VITE_MPGD_GAME_SERVICES_URL === undefined
      ? {}
      : { baseUrl: import.meta.env.VITE_MPGD_GAME_SERVICES_URL }),
    transport: resolveGameServicesTransport(import.meta.env.VITE_MPGD_GAME_SERVICES_TRANSPORT),
    ...(session === undefined ? {} : { getHeaders: () => session.getHeaders() }),
  });
}
