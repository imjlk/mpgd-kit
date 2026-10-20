import { resolveNotificationTopicsForTarget, type NotificationTopicCatalog } from '@mpgd/catalog';
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
 * service (docs/CLOUDFLARE_WORKER_DEPLOY.md, "Sessions"). The runtime keeps
 * its registration state in the platform storage, and starts here, so
 * create it before the game signs in (the opens subscription does, at boot).
 */
export function createStarterNotificationBackend(
  platform: TargetConfiguredGateway,
): StarterNotificationBackend | undefined {
  const baseUrl = import.meta.env.VITE_MPGD_GAME_SERVICES_URL?.trim();
  const session = resolveStarterServerSession();
  const provider = platform.notificationsV2;
  if (baseUrl === undefined || baseUrl === '' || session === undefined || provider === undefined) {
    return undefined;
  }
  if (import.meta.env.MODE === 'production' && !baseUrl.startsWith('https://')) {
    // The session's credentials never travel in clear text.
    console.error(
      '[notifications] VITE_MPGD_GAME_SERVICES_URL must be https in production; notifications stay off.',
    );
    return undefined;
  }
  const client = createGameServicesNotificationsClient({
    baseUrl,
    identity: session,
    getHeaders: session.getHeaders,
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
}

const backends = new WeakMap<TargetConfiguredGateway, StarterNotificationBackend | undefined>();
/** Per gateway, for the process: agreements given on a host that gives no read. */
const agreements = new WeakMap<TargetConfiguredGateway, Set<string>>();

/** One backend per gateway: a runtime subscribes to its provider once, for the process. */
function starterNotificationBackend(platform: TargetConfiguredGateway): StarterNotificationBackend | undefined {
  if (!backends.has(platform)) {
    backends.set(platform, createStarterNotificationBackend(platform));
  }
  return backends.get(platform);
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
