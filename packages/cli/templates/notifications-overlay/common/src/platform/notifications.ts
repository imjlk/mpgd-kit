import { resolveNotificationTopicsForTarget, type NotificationTopicCatalog } from '@mpgd/catalog';
import type { PlatformGateway } from '@mpgd/platform';
import type { TargetConfiguredGateway } from '@mpgd/target-config';
import type {
  NotificationConsentRecord,
  NotificationRuntime,
  NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import notificationTopicsJson from '../../notifications/topics.json';
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
 * The game's notifications backend.
 *
 * The kit does not ship that runtime's backend client yet: the game-services
 * Worker's notification routes need a session from the identity side, which
 * comes in a later kit release. Until then this returns `undefined`, and the
 * notification settings screen asks only for the OS or host permission and
 * shows no reminder, advertising, or night switch, because nothing could
 * record them. Return your own runtime and consent reader here when your
 * backend implements those routes.
 */
export function createStarterNotificationBackend(
  _platform: PlatformGateway,
): StarterNotificationBackend | undefined {
  return undefined;
}

const backends = new WeakMap<PlatformGateway, StarterNotificationBackend | undefined>();
/** Per gateway, for the process: agreements given on a host that gives no read. */
const agreements = new WeakMap<PlatformGateway, Set<string>>();

/** One backend per gateway: a runtime subscribes to its provider once, for the process. */
function starterNotificationBackend(platform: PlatformGateway): StarterNotificationBackend | undefined {
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
  platform: PlatformGateway,
  routes: NotificationOpenRoutes,
): () => void {
  const source = starterNotificationBackend(platform)?.runtime ?? platform.notificationsV2;
  return source === undefined ? () => undefined : routeNotificationOpens(source, routes);
}

export { starterNotificationSettingsRoute } from './notificationOpens';
