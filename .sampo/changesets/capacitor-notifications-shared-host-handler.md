---
npm/@mpgd/adapter-capacitor: patch (Changed)
---

`createNotificationProviderBridge` serves `notifications.v2.*` with `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`, the handler the Apps in Toss and Devvit bridges share. For this repository's errors, codes, retryable flags, and events reaching the game are unchanged; some error messages are reworded. On the bridge itself, a `PlatformOperationError` whose code is not a notifications code now crosses as `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with its retryable flag (the game-side provider already mapped it so), and a host code is named in the message only when it reads as one (`[A-Za-z0-9_.:-]{1,128}`). Failures are now also read by shape, so an error from another copy of `@mpgd/platform`, or a thrown object with a platform `code` and `retryable: false`, keeps its notifications code and retryable flag.
