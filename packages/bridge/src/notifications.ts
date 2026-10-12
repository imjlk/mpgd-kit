import {
  assertNotificationBridgeCancelLocalPayload,
  assertNotificationBridgeCancelLocalResult,
  assertNotificationBridgeGetCapabilitiesPayload,
  assertNotificationBridgeGetCapabilitiesResult,
  assertNotificationBridgeGetPermissionPayload,
  assertNotificationBridgeGetPermissionResult,
  assertNotificationBridgeListLocalPayload,
  assertNotificationBridgeListLocalResult,
  assertNotificationBridgeOpenSettingsPayload,
  assertNotificationBridgeOpenSettingsResult,
  assertNotificationBridgeRegisterPayload,
  assertNotificationBridgeRegisterResult,
  assertNotificationBridgeRequestPermissionPayload,
  assertNotificationBridgeRequestPermissionResult,
  assertNotificationBridgeRevokePermissionPayload,
  assertNotificationBridgeRevokePermissionResult,
  assertNotificationBridgeScheduleLocalPayload,
  assertNotificationBridgeScheduleLocalResult,
} from '@mpgd/platform/notifications';

import {
  isBridgeNotificationsV2Method,
  type BridgeNotificationsV2Method,
  type BridgeNotificationsV2Payload,
  type BridgeNotificationsV2Result,
} from './index.js';

// `@mpgd/bridge/notifications`: validation of notifications v2 bridge traffic
// (notifications RFC "Bridge and versioning"). A separate entry because it
// loads the `@mpgd/platform/notifications` validators, which a transport that
// only answers `NOTIFICATIONS_V2_UNAVAILABLE` does not need.

// Each entry is the `@mpgd/platform/notifications` validator of that
// method's shape; the lookups below are typed by the method.
const notificationsV2PayloadAsserts: Readonly<
  Record<BridgeNotificationsV2Method, (input: unknown) => unknown>
> = {
  'notifications.v2.getCapabilities': assertNotificationBridgeGetCapabilitiesPayload,
  'notifications.v2.getPermission': assertNotificationBridgeGetPermissionPayload,
  'notifications.v2.requestPermission': assertNotificationBridgeRequestPermissionPayload,
  'notifications.v2.revokePermission': assertNotificationBridgeRevokePermissionPayload,
  'notifications.v2.register': assertNotificationBridgeRegisterPayload,
  'notifications.v2.scheduleLocal': assertNotificationBridgeScheduleLocalPayload,
  'notifications.v2.cancelLocal': assertNotificationBridgeCancelLocalPayload,
  'notifications.v2.listLocal': assertNotificationBridgeListLocalPayload,
  'notifications.v2.openSettings': assertNotificationBridgeOpenSettingsPayload,
};

const notificationsV2ResultAsserts: Readonly<
  Record<BridgeNotificationsV2Method, (input: unknown) => unknown>
> = {
  'notifications.v2.getCapabilities': assertNotificationBridgeGetCapabilitiesResult,
  'notifications.v2.getPermission': assertNotificationBridgeGetPermissionResult,
  'notifications.v2.requestPermission': assertNotificationBridgeRequestPermissionResult,
  'notifications.v2.revokePermission': assertNotificationBridgeRevokePermissionResult,
  'notifications.v2.register': assertNotificationBridgeRegisterResult,
  'notifications.v2.scheduleLocal': assertNotificationBridgeScheduleLocalResult,
  'notifications.v2.cancelLocal': assertNotificationBridgeCancelLocalResult,
  'notifications.v2.listLocal': assertNotificationBridgeListLocalResult,
  'notifications.v2.openSettings': assertNotificationBridgeOpenSettingsResult,
};

/**
 * Validates the payload of a notifications v2 request with the
 * `@mpgd/platform/notifications` validator for its method: unknown keys,
 * timestamps without an offset or on a date that does not exist, and routes
 * that are not root-relative are rejected. Throws what that validator throws,
 * and a `TypeError` for a method that is not a notifications v2 method.
 */
export function assertBridgeNotificationsV2Payload<TMethod extends BridgeNotificationsV2Method>(
  method: TMethod,
  payload: unknown,
): BridgeNotificationsV2Payload<TMethod> {
  assertNotificationsV2Method(method);
  return notificationsV2PayloadAsserts[method](payload) as BridgeNotificationsV2Payload<TMethod>;
}

/**
 * Validates the data a transport answered a notifications v2 request with,
 * as `assertBridgeNotificationsV2Payload` validates the payload.
 */
export function assertBridgeNotificationsV2Result<TMethod extends BridgeNotificationsV2Method>(
  method: TMethod,
  data: unknown,
): BridgeNotificationsV2Result<TMethod> {
  assertNotificationsV2Method(method);
  return notificationsV2ResultAsserts[method](data) as BridgeNotificationsV2Result<TMethod>;
}

function assertNotificationsV2Method(method: string): void {
  // A caller outside TypeScript may pass any string; an inherited key such as
  // `constructor` must not reach a lookup that would call it.
  if (!isBridgeNotificationsV2Method(method)) {
    throw new TypeError(`${method} is not a notifications v2 bridge method.`);
  }
}
