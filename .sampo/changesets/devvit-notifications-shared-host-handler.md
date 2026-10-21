---
npm/@mpgd/adapter-devvit: patch (Changed)
---

`createDevvitNotificationsV2BridgeHandler` serves `notifications.v2.*` with `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`, the handler the Apps in Toss and Capacitor bridges share. For errors thrown by `@mpgd/platform` and this package, codes, retryable flags, `onError` reporting, and the server-side handling of plugin text are unchanged; the local-notification methods now answer `NOTIFICATIONS_UNSUPPORTED` with the shared wording ("The Devvit notifications provider does not implement ..."). The webview client reads a host code back with `readBridgeNotificationsHostCode`. Failures are now also read by shape, so an error from another copy of `@mpgd/platform`, or a thrown object with a platform `code` and a boolean `retryable`, keeps its retryable flag, and its code too when that is a notifications code (any other code crosses as `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`).
