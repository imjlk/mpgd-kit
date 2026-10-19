import { isRootRelativeNotificationRoute } from '@mpgd/catalog';
import type { NotificationEvent } from '@mpgd/platform/notifications';

/** The route the advertising opt-out action and the consent notices open. */
export const starterNotificationSettingsRoute = '/?entry=notification-settings';

export interface NotificationOpenRoutes {
  /** An open whose route is the settings screen. */
  readonly settings: () => void;
  /** Every other open, as the provider reported it, with `route` only when it is safe. */
  readonly other?: (open: Omit<Extract<NotificationEvent, { readonly type: 'opened' }>, 'route'> & {
    readonly route?: string;
  }) => void;
}

/**
 * The game's one listener for notification opens. It is the runtime's (or
 * the provider's) first subscriber, which is the one that receives a
 * cold-start open (RFC "Buffer before the first listener"), so route every
 * topic's opens here rather than in a later subscriber. The starter routes
 * the settings screen: the advertising opt-out action and the consent
 * notices carry `starterNotificationSettingsRoute`, and the RFC requires the
 * opt-out to open that screen directly. `other` receives every other open,
 * with a route only when `isRootRelativeNotificationRoute` accepts it. The
 * data an open carries is untrusted and never grants anything. Returns the
 * unsubscribe.
 */
export function routeNotificationOpens(
  source: { subscribe(listener: (event: NotificationEvent) => void): () => void },
  routes: NotificationOpenRoutes,
): () => void {
  return source.subscribe((event) => {
    if (event.type !== 'opened') {
      return;
    }
    const route = event.route !== undefined && isRootRelativeNotificationRoute(event.route)
      ? event.route
      : undefined;
    if (route !== undefined && isSettingsRoute(route)) {
      routes.settings();
      return;
    }
    const { route: _unsafe, ...rest } = event;
    routes.other?.({ ...rest, ...(route === undefined ? {} : { route }) });
  });
}

const settingsEntry = new URL(starterNotificationSettingsRoute, 'https://game.invalid')
  .searchParams.get('entry');

/**
 * Whether a route opens the settings screen: the same `entry` as
 * `starterNotificationSettingsRoute`. Only routes
 * `isRootRelativeNotificationRoute` accepted reach it, which parse.
 */
function isSettingsRoute(route: string): boolean {
  return new URL(route, 'https://game.invalid').searchParams.get('entry') === settingsEntry;
}
