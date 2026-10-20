---
npm/@mpgd/adapter-devvit: patch (Changed)
---

`createDevvitNotificationsV2BridgeHandler` serves `notifications.v2.*` with `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`, the handler the Apps in Toss and Capacitor bridges share. For this repository's errors, codes, retryable flags, `onError` reporting, and the server-side handling of plugin text are unchanged; the local-notification methods now answer `NOTIFICATIONS_UNSUPPORTED` with the shared wording ("The Devvit notifications provider does not implement ..."). The webview client reads a host code back with `readBridgeNotificationsHostCode`. Failures are now also read by shape, so an error from another copy of `@mpgd/platform`, or a thrown object with a platform `code` and `retryable: false`, keeps its notifications code and retryable flag.
