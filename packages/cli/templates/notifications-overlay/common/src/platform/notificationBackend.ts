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
 * header to a backend that cannot use it, so Reddit keeps no backend here,
 * as before R1, until the Devvit server has a runtime client of its own.
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
