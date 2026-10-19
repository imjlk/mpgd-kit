---
npm/@mpgd/capacitor-game-services: minor (Added)
npm/@mpgd/adapter-capacitor: minor (Added)
---

`@mpgd/capacitor-game-services` adds `openNotificationSettings()`, which opens this app's notification settings: `Settings.ACTION_APP_NOTIFICATION_SETTINGS` on Android 8 and later (the app details screen on Android 7) and `UIApplication.openNotificationSettingsURLString` on iOS 16 and later (the app's settings page on iOS 15). It answers `{ opened }` as soon as the screen is launched.

`@mpgd/adapter-capacitor/notifications` adds `openCapacitorNotificationSettings`, the opener to pass as the notifications provider's `openSettings`: with it the provider declares `permission.settings: true`. It throws when the screen did not open; a shell built with an older plugin rejects the call, and the provider then answers `unavailable`.
