---
npm/@mpgd/cli: patch (Changed)
npm/@mpgd/create-game: patch (Changed)
---

The generated Devvit server bridge (`apps/target-devvit/src/server/bridge.ts`) takes an optional `notifications` handler, `createDevvitNotificationsV2BridgeHandler` from `@mpgd/adapter-devvit/server`, which serves the `notifications.v2.*` methods. The generated entrypoint does not pass one yet, so every v2 method keeps answering `NOTIFICATIONS_V2_UNAVAILABLE` there; a handler that throws answers a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
