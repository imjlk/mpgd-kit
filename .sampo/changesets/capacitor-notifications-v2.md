---
npm/@mpgd/adapter-capacitor: minor (Added)
---

Add the notifications v2 provider for Android and iOS as `@mpgd/adapter-capacitor/notifications`. `@capacitor-firebase/messaging` and `@capacitor/local-notifications` 8.x are optional peers that only this subpath loads, dynamically, and the provider fails closed for whichever the native shell lacks. It reads the app-scope OS permission (OS `denied` reads `blocked`; `promptLimit` 2 on Android, 1 on iOS), registers FCM tokens (or Firebase installation ids through a `PushSdk` that issues them), schedules inexact local reminders on per-purpose Android channels (at most 64 pending on iOS, keeping the nearest) without ever letting the plugin prompt, registers the advertising opt-out action, buffers opens until the first subscriber, and resolves `openSettings` once the player is back from the settings screen, or after a timeout.

Register it with `createCapacitorNotificationServiceProvider` (or `createNotificationServiceProvider`): the gateway then exposes `notificationsV2` over its validated in-process bridge, pauses the game under the permission dialog and the settings screen, serves the v1 `notifications` adapter from the same provider, and reports the `notifications` capability block with `providerAvailability.pushNotifications` equal to its availability.
