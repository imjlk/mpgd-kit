import {
  isPublicGameServicesUrl,
  resolveGameServicesAuthorityMode,
  type GameServicesHeaderResolver,
} from '@mpgd/game-services';
import {
  createGameServicesNotificationsClient,
  type GameServicesNotificationIdentity,
  type GameServicesNotificationsFetch,
} from '@mpgd/game-services/notifications/client';
import type {
  NotificationConsentRecord,
  NotificationRuntime,
  NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';
import {
  createNotificationRuntime,
  createNotificationRuntimeStorage,
  type NotificationRuntimeBackend,
} from '@mpgd/platform/notifications-runtime';
import type { TargetConfiguredGateway } from '@mpgd/target-config';

/**
 * The game backend's notifications surface the starter uses: the runtime
 * (notifications RFC "Runtime"), which composes the target's provider with
 * the backend that keeps consent records, endpoint registrations, server
 * reminders, and notices; and the signed-in player's consent records (the
 * game-services Worker's `GET /consent`), which the settings screen shows.
 */
export interface StarterNotificationBackend {
  readonly runtime: NotificationRuntime;
  listConsent(): Promise<readonly NotificationConsentRecord[]>;
}

/** The server-backed session the Worker client needs (see `serverSession.ts`). */
export interface StarterWorkerSession extends GameServicesNotificationIdentity {
  readonly getHeaders: GameServicesHeaderResolver;
}

export interface StarterWorkerNotificationInput {
  /** `VITE_MPGD_GAME_SERVICES_URL`. */
  readonly baseUrl: string | undefined;
  /** The Vite mode (`import.meta.env.MODE`), which decides the production URL rule. */
  readonly mode: string;
  readonly session: StarterWorkerSession | undefined;
  /** This target's topics, each with its mapping. */
  readonly topics: readonly NotificationTopicDeclaration[];
  readonly defaultLocale: string;
  /** Logs a message, once per gateway and message. */
  readonly log: (message: string, error?: unknown) => void;
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: GameServicesNotificationsFetch;
}

/**
 * Config targets whose notifications backend is not the game-services
 * Worker. A Reddit game's backend is its Devvit server: the opt-in, the
 * consent records, and the sends live there, and the Worker serves no
 * `reddit` target. A runtime over the Worker would send the game's session
 * header to a backend that cannot use it, so Reddit gets the hosted backend
 * below instead (`createStarterHostedNotificationBackend`).
 */
const targetsWithoutWorkerBackend: ReadonlySet<string> = new Set(['reddit']);

/**
 * The notifications runtime over the game-services Worker's notification
 * routes (`@mpgd/game-services/notifications/client`), when the target's
 * backend is the Worker, the game has a game-services URL and a
 * server-backed session, and the target exposes a notifications provider.
 * Otherwise `undefined`.
 *
 * The runtime keeps its registration state in the platform storage, starts
 * here, and compares its provider with the Worker's registry entry for this
 * target (`GET /providers`), loaded in the background: a Worker it cannot
 * reach is logged once and the runtime runs without the comparison.
 */
export function createStarterWorkerNotificationBackend(
  platform: TargetConfiguredGateway,
  input: StarterWorkerNotificationInput,
): StarterNotificationBackend | undefined {
  // By platform, and by config target name for a gateway that reports another platform.
  if (platform.target === 'reddit' || targetsWithoutWorkerBackend.has(platform.configTarget)) {
    return undefined;
  }
  const baseUrl = input.baseUrl?.trim();
  const provider = platform.notificationsV2;
  if (baseUrl === undefined || baseUrl === '' || provider === undefined) {
    return undefined;
  }
  const { session } = input;
  if (session === undefined) {
    input.log(
      '[notifications] VITE_MPGD_GAME_SERVICES_URL is set but no server session is: call setStarterServerSession '
        + '(src/platform/serverSession.ts) before the game starts, or on the dev server set '
        + 'VITE_MPGD_DEV_NOTIFICATION_SESSION (docs/NOTIFICATIONS.md). The settings screen shows no switch until then.',
    );
    return undefined;
  }
  try {
    if (!isAllowedGameServicesUrl(baseUrl, input.mode)) {
      // The session's credentials never travel in clear text or to a private host in production.
      input.log(
        '[notifications] VITE_MPGD_GAME_SERVICES_URL must be an absolute http(s) URL, and a public https URL '
          + 'without credentials in production; notifications stay off.',
      );
      return undefined;
    }
    const client = createGameServicesNotificationsClient({
      baseUrl,
      identity: session,
      getHeaders: () => session.getHeaders(),
      // The catalog target whose mapping applies to this device (android or ios share FCM).
      target: platform.configTarget,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    const runtime = createNotificationRuntime({
      provider,
      backend: client,
      catalog: input.topics,
      defaultLocale: input.defaultLocale,
      storage: createNotificationRuntimeStorage({ storage: platform.storage }),
      // This target's entry in the Worker's registry, or none when the Worker does not serve it.
      async loadRegistryEntry() {
        const { providers, targets } = await client.getProviders();
        const id = targets[platform.configTarget];
        return id === undefined ? undefined : providers.find((entry) => entry.provider === id);
      },
      onError(error) {
        console.error('[notifications]', error);
      },
    });
    // It subscribes to the provider at once; a backend that cannot answer yet does not fail the game.
    runtime.start().catch((error: unknown) => {
      console.error('[notifications] the runtime could not start.', error);
    });
    return { runtime, listConsent: () => client.listConsent() };
  } catch (error) {
    // A configuration the client refuses turns notifications off, never the game.
    input.log('[notifications] the notifications backend could not be created.', error);
    return undefined;
  }
}

/**
 * A backend the target's own server hosts, set by the target's gateway
 * builder for its config target: on Reddit, `createDevvitNotificationsBackend`
 * from `@mpgd/adapter-devvit` over the Devvit server bridge
 * (`buildGateways/reddit.ts`). The server answers for the request's
 * logged-in Reddit user, so the game sets no session of its own. The
 * backend is created on first use, so a game whose target exposes no
 * notifications provider (Reddit's gated beta before approval) sends
 * nothing.
 */
let hostedBackend:
  | {
      readonly configTarget: string;
      readonly create: () => NotificationRuntimeBackend;
      created?: NotificationRuntimeBackend;
      /** The factory threw once: notifications stay off, and the failure is logged once. */
      failed?: true;
    }
  | undefined;

/**
 * Sets the backend `configTarget`'s own server hosts, as a factory called on
 * first use; `undefined` clears it.
 */
export function setStarterHostedNotificationBackend(
  configTarget: string,
  create: (() => NotificationRuntimeBackend) | undefined,
): void {
  hostedBackend = create === undefined ? undefined : { configTarget, create };
}

/**
 * The backend `configTarget`'s own server hosts, created on the first call;
 * `undefined` when none was set for this config target, or when its factory
 * threw (logged once; not called again until a new factory is set).
 */
export function resolveStarterHostedNotificationBackend(configTarget: string): NotificationRuntimeBackend | undefined {
  if (hostedBackend === undefined || hostedBackend.configTarget !== configTarget) {
    return undefined;
  }
  if (hostedBackend.failed === true) {
    return undefined;
  }
  try {
    hostedBackend.created ??= hostedBackend.create();
  } catch (error) {
    // A backend that cannot be created turns notifications off, never the game.
    hostedBackend.failed = true;
    console.error('[notifications] the hosted notifications backend could not be created.', error);
    return undefined;
  }
  return hostedBackend.created;
}

export interface StarterHostedNotificationInput {
  readonly backend: NotificationRuntimeBackend | undefined;
  /** This target's topics, each with its mapping. */
  readonly topics: readonly NotificationTopicDeclaration[];
  readonly defaultLocale: string;
  /** Logs a message, once per gateway and message. */
  readonly log: (message: string, error?: unknown) => void;
}

/**
 * The notifications runtime over a backend the target's own server hosts
 * (Reddit: the Devvit server's notifications service), when the target
 * exposes a notifications provider and its gateway builder set the backend.
 * Otherwise `undefined`.
 *
 * The runtime keeps its registration state in the platform storage and
 * starts here. It learns the player from the backend, which reads the
 * session the server answers, so the settings screen shows the reminder
 * switches once a logged-in Reddit user is known; a logged-out viewer is
 * asked to log in first. It runs without a registry entry comparison: the
 * provider and the server's service come from the same adapter and
 * deployment, and the entry lives in server code the webview does not load.
 */
export function createStarterHostedNotificationBackend(
  platform: TargetConfiguredGateway,
  input: StarterHostedNotificationInput,
): StarterNotificationBackend | undefined {
  const provider = platform.notificationsV2;
  const { backend } = input;
  if (provider === undefined || backend === undefined) {
    return undefined;
  }
  try {
    const runtime = createNotificationRuntime({
      provider,
      backend,
      catalog: input.topics,
      defaultLocale: input.defaultLocale,
      storage: createNotificationRuntimeStorage({ storage: platform.storage }),
      onError(error) {
        console.error('[notifications]', error);
      },
    });
    runtime.start().catch((error: unknown) => {
      console.error('[notifications] the runtime could not start.', error);
    });
    return { runtime, listConsent: () => backend.listConsent() };
  } catch (error) {
    // A configuration the runtime refuses turns notifications off, never the game.
    input.log('[notifications] the notifications backend could not be created.', error);
    return undefined;
  }
}

/**
 * Whether the game-services URL may carry the session's credentials: any
 * absolute http(s) URL outside production builds, and in production the
 * public https URL the commerce client requires (`isPublicGameServicesUrl`).
 */
function isAllowedGameServicesUrl(baseUrl: string, mode: string): boolean {
  if (resolveGameServicesAuthorityMode(mode) === 'production') {
    return isPublicGameServicesUrl(baseUrl);
  }
  try {
    const { protocol } = new URL(baseUrl);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
