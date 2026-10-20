---
npm/@mpgd/adapter-capacitor: patch (Changed)
---

`createNotificationProviderBridge` serves `notifications.v2.*` with `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`, the handler the Apps in Toss and Devvit bridges share. Codes, retryable flags, and events reaching the game are unchanged; some error messages are reworded. On the bridge itself, a `PlatformOperationError` whose code is not a notifications code now crosses as `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with its retryable flag (the game-side provider already mapped it so), and a host code is named in the message only when it reads as one (`[A-Za-z0-9_.:-]{1,128}`).
