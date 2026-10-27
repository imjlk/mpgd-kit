import type { AnalyticsSink } from '@mpgd/analytics';
import type { ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
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

import {
  pinStarterCommercePlayer,
  resolveStarterStoreAccountBindingFor,
} from './commerceAccountBinding';
import { resolveStarterCommerceProducts } from './commerceProducts';
import type { StarterGuestSignIn } from './guestIdentity';
import { createStorageMonetizationOperationStore } from './monetizationJournal';
import { resolveStarterServerSession } from './serverSession';
import {
  bindStarterServicesToPlayer,
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
  /**
   * Called at once when the server session names another player than the
   * services' (an account switch within the run): the services refuse
   * everything from now on; block input or show a switching screen
   * (`main.ts` does both). `onPlayerChanged` follows.
   */
  readonly onPlayerChanging?: (playerId: string) => void;
  /**
   * Called once after `onPlayerChanging`, when the closed services have
   * stopped (an open store sheet first journals its answer, up to
   * `gameServicesDisposeWaitMs`): restart the game so it boots for that
   * player (`main.ts` reloads).
   */
  readonly onPlayerChanged?: (playerId: string) => void;
}

/**
 * Game-services runtime over the commerce v2 reconciler: every purchase is
 * journaled in a durable `MonetizationOperationStore` (the reference journal
 * over the platform storage adapter unless the game supplies its own) and
 * verified through the backend ledger, with the catalog's kinds and SKUs for
 * the gateway target resolved without a store read.
 *
 * With a server session (`setStarterServerSession`), the services belong to
 * `playerId` for their whole life and fail closed for anyone else: while the
 * session names no player, purchases and backend requests are refused
 * (retryable); once it names another player (an account switch), the
 * services close for good before that player's headers or store account
 * binding reach this player's journal (purchases answer `failed` with the
 * retryable diagnostic `GAME_SERVICES_PLAYER_CHANGED`), `onPlayerChanging`
 * tells the host at once, and `onPlayerChanged` asks it to boot again for
 * the new player once they have stopped. Pass the
 * session's player as `playerId`, never the platform's local placeholder:
 * services created for another player than the session's stay closed.
 */
export function createStarterGameServices(input: StarterGameServicesInput): StarterGameServices {
  const session = resolveStarterServerSession({ once: true });
  if (session === undefined) {
    return createRuntime(input, session);
  }
  // The store account binding follows the same player as the journal, until
  // these services were disposed; throws while another player's are open.
  const releasePin = pinStarterCommercePlayer(input.playerId);
  let services: GameServicesRuntime;
  try {
    services = createRuntime(input, session);
  } catch (error) {
    releasePin();
    throw error;
  }
  return bindStarterServicesToPlayer({
    services,
    playerId: input.playerId,
    session,
    onDisposed: releasePin,
    ...(input.onPlayerChanging === undefined ? {} : { onPlayerChanging: input.onPlayerChanging }),
    ...(input.onPlayerChanged === undefined ? {} : { onPlayerChanged: input.onPlayerChanged }),
  });
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
  const { signIn, onActivated, onPlayerChanging, onPlayerChanged, ...rest } = input;
  // The inner services (a session switch) and the gate (a later sign-in) may
  // both see the same change; the host hears each step once.
  const once = (callback: (playerId: string) => void): ((playerId: string) => void) => {
    let called = false;
    return (playerId) => {
      if (!called) {
        called = true;
        callback(playerId);
      }
    };
  };
  const hooks = {
    ...(onPlayerChanging === undefined ? {} : { onPlayerChanging: once(onPlayerChanging) }),
    ...(onPlayerChanged === undefined ? {} : { onPlayerChanged: once(onPlayerChanged) }),
  };
  return createSessionGatedGameServices({
    // Configuration only (mode, target, whether a client exists); never sends a request.
    probe: createRuntime({ ...rest, playerId: 'session-pending' }, undefined),
    ensurePlayer: async () => (await signIn.ensure())?.playerId,
    onPlayer: (listener) => signIn.onSignedIn((signedIn) => listener(signedIn.playerId)),
    create: (playerId) => createStarterGameServices({ ...rest, playerId, ...hooks }),
    ...(onActivated === undefined ? {} : { onActivated }),
    ...hooks,
  });
}

function createRuntime(
  input: StarterGameServicesInput,
  session: ReturnType<typeof resolveStarterServerSession>,
): GameServicesRuntime {
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
    // A store purchase bound to another player's account is left for that player.
    commerceAccountBinding: () => resolveStarterStoreAccountBindingFor(input.gateway.target, input.playerId),
    ...(session === undefined
      ? {}
      : {
          getHeaders: () => session.getHeaders(),
          // Requests, the store account binding, and the journal follow this
          // session's player; the services refuse while it is not theirs.
          sessionPlayerId: () => session.current()?.playerId,
        }),
  });
}
