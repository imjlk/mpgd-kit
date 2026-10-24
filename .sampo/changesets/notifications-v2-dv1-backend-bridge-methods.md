---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/bridge: minor (Added)
---

Notifications backend bridge methods: the notifications runtime's backend calls (`NotificationRuntimeBackend`) for a backend that a host serves over its own bridge, such as the Devvit server. `@mpgd/platform/notifications` adds the nine `notifications.backend.*` method shapes (`NotificationBackendBridgeMethods`, `notificationBackendBridgeMethods`), their typia validators (`assertNotificationBackendBridge*Payload` and `*Result`), JSON Schemas, and `NotificationBackendReminderSetStatus`, which `NotificationRuntimeReminderSetStatus` now names. Every call but `getSession` carries `expectedPlayer`, only as a cross-check: the host acts for its own authenticated player and refuses a call for another.

`@mpgd/bridge` adds the methods to `BridgeMethod` as `BridgeNotificationsBackendMethod` (`bridgeNotificationsBackendMethods`, `isBridgeNotificationsBackendMethod`), apart from the nine provider methods, and `createNotificationsBackendUnavailableBridgeError`, which answers `NOTIFICATIONS_CONFIGURATION_REQUIRED`. `@mpgd/bridge/notifications` adds `assertBridgeNotificationsBackendPayload`, `assertBridgeNotificationsBackendResult`, `notificationsBackendBridgeHostCodes`, and `createNotificationsBackendBridgeHandler`, which serves the methods from the host's backend for its own session: a request without a player answers `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with host code `NOTIFICATIONS_SIGNED_OUT`, one whose `expectedPlayer` is another player the same code with `NOTIFICATIONS_SESSION_CHANGED`, and a backend failure that is not a notifications failure crosses with a fixed message.

The notifications conformance runner awaits a backend's `authenticate`, whose return type now admits a promise; `NotificationConformanceFakeBackend` still answers synchronously.
