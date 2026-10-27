import type { AnalyticsSink } from '@mpgd/analytics';
import type { ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import {
  createGameServicesRuntime,
  resolveGameServicesAuthorityMode,
  resolveGameServicesBaseUrl,
  resolveGameServicesTransport,
  type GameServicesRuntime,
  type GameServicesRuntimeMode,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import type { PlatformGateway } from '@mpgd/platform';
import type { GameActionReconciliationPort } from '@mpgd/game-runtime/actions';
import type { PurchasePresentationEvent } from '@mpgd/game-runtime/ads';

import { resolveStarterCommerceProducts } from './commerceProducts';
import type { StarterGuestSignIn } from './guestIdentity';
import { createStorageMonetizationOperationStore } from './monetizationJournal';
import { resolveStarterServerSession } from './serverSession';
import {
  createSessionGatedGameServices,
  type StarterSessionGatedServices,
} from './sessionGatedServices';

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

export type StarterBackendMode = GameServicesRuntimeMode;
/**
 * The game services the scenes read. In a run whose guest sign-in failed at
 * boot they are session-gated (`ensureSession` present): see
 * `sessionGatedServices.ts`.
 */
export type StarterGameServices = GameServicesRuntime & {
  readonly ensureSession?: StarterSessionGatedServices['ensureSession'];
};

interface StarterGameServicesInput {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
  readonly configTarget: string;
  readonly operationStore?: MonetizationOperationStore;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
}

/**
 * Game-services runtime over the commerce v2 reconciler: every purchase is
 * journaled in a durable `MonetizationOperationStore` (the reference journal
 * over the platform storage adapter unless the game supplies its own) and
 * verified through the backend ledger, with the catalog's kinds and SKUs for
 * the gateway target resolved without a store read.
 */
export function createStarterGameServices(input: StarterGameServicesInput): StarterGameServices {
  return createRuntime(input, resolveStarterServerSession({ once: true }));
}

/**
 * The game services of a run whose guest sign-in failed at boot: they come
 * up for the server player once `signIn` succeeds (in the background, or
 * when a purchase or restore asks again), and never for the platform's local
 * placeholder. Set the server session (`setStarterServerSession`) in a
 * `signIn.onSignedIn` listener registered before this, so the services read it.
 */
export function createStarterSessionGatedGameServices(
  input: Omit<StarterGameServicesInput, 'playerId'> & {
    readonly signIn: StarterGuestSignIn;
    /** Called once the services exist for the server player: run the game runtime's `reconcile()`. */
    readonly onActivated?: () => void;
  },
): StarterGameServices {
  const { signIn, onActivated, ...rest } = input;
  return createSessionGatedGameServices({
    // Configuration only (mode, target, whether a client exists); never sends a request.
    probe: createRuntime({ ...rest, playerId: 'session-pending' }, undefined),
    ensurePlayer: async () => (await signIn.ensure())?.playerId,
    onPlayer: (listener) => signIn.onSignedIn((signedIn) => listener(signedIn.playerId)),
    create: (playerId) => createStarterGameServices({ ...rest, playerId }),
    ...(onActivated === undefined ? {} : { onActivated }),
  });
}

function createRuntime(
  input: StarterGameServicesInput,
  session: ReturnType<typeof resolveStarterServerSession>,
): GameServicesRuntime {
  const baseUrl = resolveGameServicesBaseUrl(import.meta.env.VITE_MPGD_GAME_SERVICES_URL, {
    target: input.gateway.target,
    ...(globalThis.location?.origin === undefined ? {} : { pageOrigin: globalThis.location.origin }),
  });
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
    ...(baseUrl === undefined ? {} : { baseUrl }),
    transport: resolveGameServicesTransport(import.meta.env.VITE_MPGD_GAME_SERVICES_TRANSPORT),
    ...(session === undefined ? {} : { getHeaders: () => session.getHeaders() }),
  });
}
