---
npm/@mpgd/adapter-devvit: patch (Changed)
---

`createDevvitNotificationsV2BridgeHandler` serves `notifications.v2.*` with `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`, the handler the Apps in Toss and Capacitor bridges share. Codes, retryable flags, `onError` reporting, and the server-side handling of plugin text are unchanged; the local-notification methods now answer `NOTIFICATIONS_UNSUPPORTED` with the shared wording ("The Devvit notifications provider does not implement ...").
