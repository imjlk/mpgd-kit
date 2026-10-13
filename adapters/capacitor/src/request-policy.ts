import {
  isBridgeNotificationsV2Method,
  notificationsV2UnavailableBridgeErrorCode,
  type BridgeMethod,
} from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';

// How the gateway's request path treats a method before routing it. Internal:
// the package entry does not export this module.

/**
 * Methods that put a native UI over the game, so the gateway pauses the game
 * (`beginExternalActivity`) while one runs: a store sheet, an ad, a sign-in,
 * a permission dialog, or the system settings that
 * `notifications.v2.openSettings` leaves for (notifications RFC "Provider
 * profiles", Capacitor).
 */
export const externalActivityMethods: ReadonlySet<BridgeMethod> = new Set<BridgeMethod>([
  'commerce.v2.requestPurchase',
  'ads.showRewarded',
  'ads.showInterstitial',
  'identity.requestUpgrade',
  'notifications.requestSubscription',
  'notifications.v2.requestPermission',
  'notifications.v2.openSettings',
]);

/**
 * Fails closed for a notifications v2 method that no registered provider
 * serves: the base game-services plugin speaks no notifications v2, so the
 * request answers `NOTIFICATIONS_V2_UNAVAILABLE`, which is not retryable,
 * without pausing the game or reaching the plugin.
 */
export function assertNotificationsV2Served(method: BridgeMethod, served: boolean): void {
  if (served || !isBridgeNotificationsV2Method(method)) {
    return;
  }
  throw new PlatformOperationError({
    code: notificationsV2UnavailableBridgeErrorCode,
    message: `No Capacitor provider serves notifications v2; ${method} is unavailable.`,
    retryable: false,
  });
}
