/**
 * The Devvit notifications profile (notifications v2 RFC, "Provider
 * profiles", Devvit), shared by the webview gateway and the Devvit server.
 * Pure values: no Devvit SDK, no `@mpgd/platform/notifications` runtime code,
 * so the gateway's main entry can import it without pulling in validators.
 *
 * Sources (checked 2026-10-19 through the Devvit MCP `devvit_search`):
 * - <https://developers.reddit.com/docs/versioned_docs/version-0.14/capabilities/notifications/notifications-overview>:
 *   a gated beta that an app applies for.
 * - <https://developers.reddit.com/docs/versioned_docs/version-0.14/capabilities/notifications/pn-best-practices>:
 *   copy pre-approved by Devvit admins, "titles ≤ 60 characters, body ≤ 100
 *   characters", at most 2 per user per day and 25K per app per day once
 *   published, opt-in enforced at the API level, an in-game control for both
 *   directions, and opt-out controls planned for Reddit settings.
 * - <https://developers.reddit.com/docs/versioned_docs/version-0.14/guides/logged-out-users>:
 *   `showLoginPrompt()` reloads the page after the player logs in.
 */

import type { NotificationCapabilities } from '@mpgd/platform/notifications';

/** The reference provider id of the Devvit profile. */
export const devvitNotificationProviderId = 'devvit' as const;

/** The catalog target Devvit serves. */
export const devvitNotificationTarget = 'reddit' as const;

/** Longest title Devvit accepts, in Unicode code points of the filled text as the kit counts them. */
export const devvitNotificationTitleMaxLength = 60;

/** Longest body Devvit accepts, in Unicode code points of the filled text as the kit counts them. */
export const devvitNotificationBodyMaxLength = 100;

/** Sends per Reddit user per rolling day (a provider limit). */
export const devvitNotificationsPerUserPerDay = 2;

/** Sends per app per day (the registry entry's `rate`). */
export const devvitNotificationsPerAppPerDay = 25_000;

/**
 * Devvit's length unit, which the RFC left to P3. The docs give the limits
 * in "characters" without a unit, the SDK (`@devvit/notifications` 0.14.1)
 * checks nothing before `Enqueue`, and Devvit admins approve the copy
 * before a game may send it, so the limit is a copy-review rule more than an
 * API one. The kit counts Unicode code points, as the catalog validator
 * counts its mapping fields: an accented letter or an emoji counts once, as
 * a reader sees it, and a grapheme cluster of several code points (a flag, a
 * family emoji) counts more than once, which is stricter than a reader.
 * Devvit has not confirmed the unit; if its server counts UTF-16 units, a
 * text with astral characters (most emoji) that passes here could still be
 * refused there, and the refusal arrives as an `enqueue` error. It counts
 * the filled text, at send time, because `{{name}}` placeholders change the
 * length once template data fills them.
 */
export function devvitNotificationTextLength(text: string): number {
  return [...text].length;
}

/**
 * The characters of a Devvit host code. The server bridge names a host code
 * in an error message as `(host code <code>)`, and the webview reads it back,
 * both through `@mpgd/bridge/notifications` (`createNotificationsV2BridgeHandler`
 * and `readBridgeNotificationsHostCode`), whose pattern this equals.
 */
export const devvitHostCodeCharacters = '[A-Za-z0-9_.:-]{1,128}';

/** A post (`t3_`) or comment (`t1_`) id, the only links `enqueue` accepts. */
export const devvitNotificationLinkPattern = /^t[13]_[A-Za-z0-9]+$/u;

/** A Reddit user id (`t2_`), the only recipient `enqueue` accepts. */
export const devvitUserIdPattern = /^t2_[A-Za-z0-9]+$/u;

/**
 * The Devvit capability block (RFC "Provider profiles"): app-scope consent
 * the game renders, readable through the server bridge and at send time,
 * persistent, behind a player gesture, revocable in the game, with no
 * settings link; platform-user, free-form (approved copy) remote delivery for
 * `service` and `requested` topics; no local notifications; opens through
 * the send's post or comment link. While the viewer is logged out the
 * availability is `action-required` (login). A fresh object on every call.
 */
export function createDevvitNotificationCapabilities(
  availability: NotificationCapabilities['availability'] = 'available',
): NotificationCapabilities {
  return {
    availability,
    permission: {
      scope: 'app',
      prompt: 'game',
      readable: true,
      serverReadable: true,
      allowance: 'persistent',
      userGesture: true,
      settings: false,
    },
    remote: {
      supported: true,
      purposes: ['service', 'requested'],
      addressing: 'platform-user',
      content: 'free-form',
    },
    local: { supported: false },
    open: 'host-link',
  };
}

/**
 * A block that offers nothing, for a provider read that failed or stalled
 * (`createUnsupportedNotificationCapabilities()` of `@mpgd/platform/notifications`
 * with the given availability, kept equal by a test). A fresh object.
 */
export function createDevvitDegradedNotificationCapabilities(
  availability: NotificationCapabilities['availability'],
): NotificationCapabilities {
  return {
    availability,
    permission: {
      scope: 'app',
      prompt: 'os',
      readable: true,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: false,
      settings: false,
    },
    remote: { supported: false, purposes: [], addressing: 'none', content: 'free-form' },
    local: { supported: false },
    open: 'none',
  };
}
