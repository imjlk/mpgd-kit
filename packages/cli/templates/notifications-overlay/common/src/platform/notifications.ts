import { resolveNotificationTopicsForTarget, type NotificationTopicCatalog } from '@mpgd/catalog';
import { resolveGameServicesAuthorityMode } from '@mpgd/game-services';
import { createGameServicesNotificationsClient } from '@mpgd/game-services/notifications/client';
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

import notificationTopicsJson from '../../notifications/topics.json';
import { resolveStarterServerSession } from './gameServices';
import { routeNotificationOpens, type NotificationOpenRoutes } from './notificationOpens';
import {
  createStarterNotificationSettings,
  type StarterNotificationSettings,
} from './notificationSettings';

/**
 * The game's notification topic catalog (`notifications/topics.json`), the
 * one source for every target's provider, the Apps in Toss wrapper, the
 * Devvit server, and the game backend (`MPGD_NOTIFICATIONS_CATALOG`).
 * `pnpm validate:notifications` checks it with `notifications/deployment.json`.
 *
 * The starter topics' purposes follow the notifications RFC (open question 1):
 * `daily-ready` and `streak-at-risk` are `requested` reminders the player
 * turns on, `friend-challenge` is `service`, and `events` is the sample
 * `advertising` topic, mapped to iOS only: an Android FCM push cannot carry
 * the opt-out action the Korean rules require yet. A topic whose copy offers a reward, a benefit, or a
 * promotion is advertising: declare it so, never `requested`.
 */
export const starterNotificationCatalog = notificationTopicsJson as NotificationTopicCatalog;

/** The consent text version recorded with advertising and night consent; bump it when the text changes. */
export const starterAdvertisingConsentTextVersion = '1';

/** The topics this deployment target maps, each with its mapping, as providers read them. */
export function starterNotificationTopics(configTarget: string): readonly NotificationTopicDeclaration[] {
  try {
    return resolveNotificationTopicsForTarget(starterNotificationCatalog, configTarget);
  } catch (error) {
    // A catalog that cannot be read turns notifications off, never the game.
    console.error('[notifications] the topic catalog could not be read.', error);
    return [];
  }
}

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

/**
 * The game's notifications backend: the notifications runtime over the
 * game-services Worker's notification routes
 * (`@mpgd/game-services/notifications/client`), when the game has both a
 * game-services URL (`VITE_MPGD_GAME_SERVICES_URL`, as the commerce client
 * uses) and a server-backed session (`setStarterServerSession` in
 * `gameServices.ts`), and the target exposes a notifications provider.
 * Otherwise `undefined`: the notification settings screen then asks only for
 * the OS or host permission and shows no reminder, advertising, or night
 * switch, because nothing could record them.
 *
 * The Worker binds a device to the session its `Authorization` header names,
 * through its `GAME_SERVICES_NOTIFICATIONS_AUTH` binding to your identity
 * service (docs/CLOUDFLARE_WORKER_DEPLOY.md, "Sessions"); it serves the
 * Android, iOS, and Apps in Toss providers, while a Reddit game's backend is
 * its Devvit server. The runtime keeps its registration state in the
 * platform storage and starts here. Call this through the settings model or
 * `subscribeStarterNotificationOpens`, which keep one runtime per gateway:
 * a second call starts a second runtime on the same provider.
 */
export function createStarterNotificationBackend(
  platform: TargetConfiguredGateway,
): StarterNotificationBackend | undefined {
  const baseUrl = import.meta.env.VITE_MPGD_GAME_SERVICES_URL?.trim();
  const provider = platform.notificationsV2;
  if (baseUrl === undefined || baseUrl === '' || provider === undefined) {
    return undefined;
  }
  const session = resolveStarterServerSession();
  if (session === undefined) {
    warnOnce(
      platform,
      '[notifications] VITE_MPGD_GAME_SERVICES_URL is set but no server session is: call setStarterServerSession '
        + '(src/platform/gameServices.ts) before the game starts. The settings screen shows no switch until then.',
    );
    return undefined;
  }
  if (!isAllowedGameServicesUrl(baseUrl)) {
    // The session's credentials never travel in clear text or to a private host in production.
    console.error(
      '[notifications] VITE_MPGD_GAME_SERVICES_URL must be a public https URL in production; notifications stay off.',
    );
    return undefined;
  }
  try {
    const client = createGameServicesNotificationsClient({
      baseUrl,
      identity: session,
      getHeaders: () => session.getHeaders(),
      // The catalog target whose mapping applies to this device (android or ios share FCM).
      target: platform.configTarget,
    });
    const runtime = createNotificationRuntime({
      provider,
      backend: client,
      catalog: starterNotificationTopics(platform.configTarget),
      defaultLocale: starterNotificationCatalog.defaultLocale,
      storage: createNotificationRuntimeStorage({ storage: platform.storage }),
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
    console.error('[notifications] the notifications backend could not be created.', error);
    return undefined;
  }
}

/**
 * Whether the game-services URL may carry the session's credentials: any
 * absolute http(s) URL outside production builds, and a public https URL
 * without credentials in production, as the commerce client requires.
 */
function isAllowedGameServicesUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (resolveGameServicesAuthorityMode(import.meta.env.MODE) !== 'production') {
    return url.protocol === 'https:' || url.protocol === 'http:';
  }
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:'
    && url.username === ''
    && url.password === ''
    && host !== 'localhost'
    && !host.endsWith('.localhost')
    && !host.endsWith('.local');
}

const warned = new WeakSet<TargetConfiguredGateway>();
function warnOnce(platform: TargetConfiguredGateway, message: string): void {
  if (!warned.has(platform)) {
    warned.add(platform);
    console.warn(message);
  }
}

const backends = new WeakMap<TargetConfiguredGateway, StarterNotificationBackend>();
/** Per gateway, for the process: agreements given on a host that gives no read. */
const agreements = new WeakMap<TargetConfiguredGateway, Set<string>>();

/**
 * One backend per gateway: a runtime subscribes to its provider once, for the
 * process. A gateway without one yet (no session set) is asked again on the
 * next use.
 */
function starterNotificationBackend(platform: TargetConfiguredGateway): StarterNotificationBackend | undefined {
  let backend = backends.get(platform);
  if (backend === undefined) {
    backend = createStarterNotificationBackend(platform);
    if (backend !== undefined) {
      backends.set(platform, backend);
    }
  }
  return backend;
}

/** The settings screen's model for this gateway and locale. */
export function createStarterNotificationSettingsModel(
  platform: TargetConfiguredGateway,
  input: { readonly locale: string },
): StarterNotificationSettings {
  const requestUpgrade = platform.identity.requestUpgrade?.bind(platform.identity);
  const backend = starterNotificationBackend(platform);
  let agreed = agreements.get(platform);
  if (agreed === undefined) {
    agreed = new Set<string>();
    agreements.set(platform, agreed);
  }
  return createStarterNotificationSettings({
    provider: platform.notificationsV2,
    runtime: backend?.runtime,
    ...(backend === undefined ? {} : { listConsent: () => backend.listConsent() }),
    topics: starterNotificationTopics(platform.configTarget),
    ...(starterNotificationCatalog.notices === undefined
      ? {}
      : { noticeCopy: starterNotificationCatalog.notices.copy }),
    defaultLocale: starterNotificationCatalog.defaultLocale,
    consentTextVersion: starterAdvertisingConsentTextVersion,
    agreedThisSession: agreed,
    // Devvit: a logged-out player logs in before the opt-in (the gateway's loginPrompt).
    ...(requestUpgrade === undefined
      ? {}
      : { requestLogin: () => requestUpgrade({ reason: 'notifications' }) }),
    locale: input.locale,
  });
}

/**
 * The game's one listener for notification opens (see
 * `routeNotificationOpens` in `notificationOpens.ts`), over the runtime when
 * the game has one, else the provider. Returns the unsubscribe.
 */
export function subscribeStarterNotificationOpens(
  platform: TargetConfiguredGateway,
  routes: NotificationOpenRoutes,
): () => void {
  const source = starterNotificationBackend(platform)?.runtime ?? platform.notificationsV2;
  return source === undefined ? () => undefined : routeNotificationOpens(source, routes);
}

export { starterNotificationSettingsRoute } from './notificationOpens';
