import { resolveNotificationTopicsForTarget, type NotificationTopicCatalog } from '@mpgd/catalog';
import type { PlatformGateway } from '@mpgd/platform';
import type { TargetConfiguredGateway } from '@mpgd/target-config';
import type {
  NotificationRuntime,
  NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import notificationTopicsJson from '../../notifications/topics.json';
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
 * `advertising` topic. A topic whose copy offers a reward, a benefit, or a
 * promotion is advertising: declare it so, never `requested`.
 */
export const starterNotificationCatalog = notificationTopicsJson as NotificationTopicCatalog;

/** The consent text version recorded with advertising and night consent; bump it when the text changes. */
export const starterAdvertisingConsentTextVersion = '1';

/** The topics this deployment target maps, each with its mapping, as providers read them. */
export function starterNotificationTopics(configTarget: string): readonly NotificationTopicDeclaration[] {
  return resolveNotificationTopicsForTarget(starterNotificationCatalog, configTarget);
}

/**
 * The game's notifications runtime (notifications RFC "Runtime"): the target's
 * provider composed with the game backend, which keeps consent records,
 * endpoint registrations, server reminders, and notices.
 *
 * The kit does not ship that runtime's backend client yet: the game-services
 * Worker's notification routes need a session from the identity side, which
 * comes in a later kit release. Until then this returns `undefined`, and the
 * notification settings screen asks only for the OS or host permission and
 * keeps topic, advertising, and night consent switched off, because nothing
 * could record them. Return your own `NotificationRuntime` here when your
 * backend implements those routes.
 */
export function createStarterNotificationRuntime(
  _platform: PlatformGateway,
): NotificationRuntime | undefined {
  return undefined;
}

const runtimes = new WeakMap<PlatformGateway, NotificationRuntime | undefined>();

/** One runtime per gateway: a runtime subscribes to its provider once, for the process. */
function starterNotificationRuntime(platform: PlatformGateway): NotificationRuntime | undefined {
  if (!runtimes.has(platform)) {
    runtimes.set(platform, createStarterNotificationRuntime(platform));
  }
  return runtimes.get(platform);
}

/** The settings screen's model for this gateway, player, and locale. */
export function createStarterNotificationSettingsModel(
  platform: TargetConfiguredGateway,
  input: { readonly playerId: string; readonly locale: string },
): StarterNotificationSettings {
  const requestUpgrade = platform.identity.requestUpgrade?.bind(platform.identity);
  return createStarterNotificationSettings({
    provider: platform.notificationsV2,
    runtime: starterNotificationRuntime(platform),
    topics: starterNotificationTopics(platform.configTarget),
    ...(starterNotificationCatalog.notices === undefined
      ? {}
      : { noticeCopy: starterNotificationCatalog.notices.copy }),
    defaultLocale: starterNotificationCatalog.defaultLocale,
    consentTextVersion: starterAdvertisingConsentTextVersion,
    storage: platform.storage,
    playerId: input.playerId,
    // Devvit: a logged-out player logs in before the opt-in (the gateway's loginPrompt).
    ...(requestUpgrade === undefined
      ? {}
      : { requestLogin: () => requestUpgrade({ reason: 'notifications' }) }),
    locale: input.locale,
  });
}

/** The route the advertising opt-out action and the consent notices open. */
export const starterNotificationSettingsRoute = '/?entry=notification-settings';

/**
 * Calls `open` for every notification open whose route is the settings
 * screen: the advertising opt-out action and the consent notices land there,
 * and the RFC requires the opt-out to open that screen directly. Opens are
 * read through the runtime when the game has one, else from the provider.
 * Returns the unsubscribe.
 */
export function subscribeStarterNotificationSettingsOpens(
  platform: PlatformGateway,
  open: () => void,
): () => void {
  const source = starterNotificationRuntime(platform) ?? platform.notificationsV2;
  if (source === undefined) {
    return () => undefined;
  }
  return source.subscribe((event) => {
    if (event.type === 'opened' && event.route !== undefined && isSettingsRoute(event.route)) {
      open();
    }
  });
}

function isSettingsRoute(route: string): boolean {
  const url = new URL(route, 'https://game.invalid');
  return url.searchParams.get('entry') === 'notification-settings';
}
