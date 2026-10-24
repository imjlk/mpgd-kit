---
npm/@mpgd/adapter-devvit: minor (Added)
---

The notifications runtime's backend on Reddit. `createDevvitNotificationsBackendBridgeHandler({ service, context })` from `@mpgd/adapter-devvit/server` serves the `notifications.backend.*` bridge methods from the Devvit notifications service (`createDevvitNotificationService(...).service`) for the request's logged-in user, `devvitNotificationSessionFromContext(context())`, never a payload field; pass it to the server bridge as `notificationsBackend`. `DevvitNotificationSessionContext.userId` admits `null`, read as logged out.

`createDevvitNotificationsBackend({ appVersion, buildId })` from `@mpgd/adapter-devvit` is the webview's `NotificationRuntimeBackend` for `createNotificationRuntime`, over the same server bridge as `createDevvitPlatformGateway`, with its client in its own chunk. It reads the session the Devvit server answers (no game session is needed), announces it to the runtime, reads again when the server refuses a call for another user, retries a failed read at most every 5 seconds when the runtime next reads the session, and times a request out after 15 seconds (`timeoutMs`). Server answers map to the codes the runtime acts on.
