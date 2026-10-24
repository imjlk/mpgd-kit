---
npm/@mpgd/adapter-devvit: minor (Added)
---

The notifications runtime's backend on Reddit. `createDevvitNotificationsBackendBridgeHandler({ service, context })` from `@mpgd/adapter-devvit/server` serves the `notifications.backend.*` bridge methods from the Devvit notifications service (`createDevvitNotificationService(...).service`) for the request's logged-in user, `devvitNotificationSessionFromContext(context())`, never a payload field; pass it to the server bridge as `notificationsBackend`. A request whose `context.userId` is missing, `null`, or not a `t2_` id has no signed-in player.

`createDevvitNotificationsBackend({ appVersion, buildId })` from `@mpgd/adapter-devvit` is the webview's `NotificationRuntimeBackend` for `createNotificationRuntime`, over the same server bridge as `createDevvitPlatformGateway`, with its client in its own chunk. It reads the session the Devvit server answers (no game session is needed), announces it to the runtime, reads again when the server refuses a call for another user, and, until the server answers a signed-in player or a read fails in a way a retry cannot change, reads again at most every 5 seconds (`retryIntervalMs`) when the runtime next reads the session (a failed read and a signed-out answer alike, so a login is picked up whether or not Reddit reloads the post). It times a request out after 15 seconds (`timeoutMs`). Server answers map to the codes the runtime acts on.

Changed for outside callers: `DevvitNotificationSessionContext.userId` is now `string | null | undefined`. Code that passes a Devvit `context` is unaffected; code that reads `userId` from a value of this type handles `null`.
