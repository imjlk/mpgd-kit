import { resolveNotificationTopicsForTarget, type NotificationTopicCatalog } from '@mpgd/catalog';
import type { NotificationTopicDeclaration } from '@mpgd/platform/notifications';
import type { TargetConfiguredGateway } from '@mpgd/target-config';

import notificationTopicsJson from '../../notifications/topics.json';
import {
  createStarterHostedNotificationBackend,
  createStarterWorkerNotificationBackend,
  resolveStarterHostedNotificationBackend,
  type StarterNotificationBackend,
} from './notificationBackend';
import { resolveStarterServerSession } from './serverSession';
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
 * `advertising` topic. On Android an FCM notification cannot carry the
 * opt-out action the Korean rules require, so the shell renders advertising
 * pushes itself (`mpgd target init capacitor --providers notifications`
 * declares the kit's renderer, and `notifications/deployment.json` sets
 * `shellRendersAdvertising`); the backend sends one only to an installation
 * whose shell has the renderer. A topic whose copy offers a reward, a
 * benefit, or a promotion is advertising: declare it so, never `requested`.
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

export type { StarterNotificationBackend } from './notificationBackend';

/**
 * The game's notifications backend: the notifications runtime over the
 * game-services Worker's notification routes (see `notificationBackend.ts`),
 * when the game has both a game-services URL (`VITE_MPGD_GAME_SERVICES_URL`,
 * as the commerce client uses) and a server-backed session
 * (`setStarterServerSession` in `serverSession.ts`), and the target exposes
 * a notifications provider. Otherwise `undefined`: the notification settings
 * screen then asks only for the OS or host permission and shows no
 * reminder, advertising, or night switch, because nothing could record them.
 *
 * Reddit gets no Worker backend: its notifications backend is the Devvit
 * server, which keeps the opt-in, the records, and the sends. The runtime
 * there runs over the backend `buildGateways/reddit.ts` sets
 * (`createDevvitNotificationsBackend`, through
 * `setStarterHostedNotificationBackend`), which needs no game session: the
 * Devvit server answers for the logged-in Reddit user. The Worker
 * serves the Android, iOS, and Apps in Toss providers and binds a device to
 * the session its `Authorization` header names, through its
 * `GAME_SERVICES_NOTIFICATIONS_AUTH` binding to your identity service
 * (docs/CLOUDFLARE_WORKER_DEPLOY.md, "Sessions"). Call this through the
 * settings model or `subscribeStarterNotificationOpens`, which keep one
 * runtime per gateway: a second call starts a second runtime on the same
 * provider.
 */
export function createStarterNotificationBackend(
  platform: TargetConfiguredGateway,
): StarterNotificationBackend | undefined {
  // Only a hosted backend set for this config target; other targets keep the Worker path.
  const hosted = platform.notificationsV2 === undefined
    ? undefined
    : resolveStarterHostedNotificationBackend(platform.configTarget);
  if (hosted !== undefined) {
    return createStarterHostedNotificationBackend(platform, {
      backend: hosted,
      topics: starterNotificationTopics(platform.configTarget),
      defaultLocale: starterNotificationCatalog.defaultLocale,
      log: (message, error) => warnOnce(platform, message, error),
    });
  }
  return createStarterWorkerNotificationBackend(platform, {
    baseUrl: import.meta.env.VITE_MPGD_GAME_SERVICES_URL,
    mode: import.meta.env.MODE,
    session: resolveStarterServerSession(),
    topics: starterNotificationTopics(platform.configTarget),
    defaultLocale: starterNotificationCatalog.defaultLocale,
    log: (message, error) => warnOnce(platform, message, error),
  });
}

/** Messages already logged per gateway: a screen opened again does not log them again. */
const warned = new WeakMap<TargetConfiguredGateway, Set<string>>();
function warnOnce(platform: TargetConfiguredGateway, message: string, error?: unknown): void {
  let messages = warned.get(platform);
  if (messages === undefined) {
    messages = new Set();
    warned.set(platform, messages);
  }
  if (!messages.has(message)) {
    messages.add(message);
    if (error === undefined) {
      console.warn(message);
    } else {
      console.error(message, error);
    }
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
