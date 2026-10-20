---
npm/@mpgd/adapter-ait: patch (Changed)
---

The Apps in Toss host serves `notifications.v2.*` with `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`, the handler the Capacitor and Devvit bridges share. Codes, retryable flags, and events are unchanged (some error messages are reworded), except that a provider answering `register` or `openSettings` with `undefined` now answers `NOTIFICATIONS_CONFIGURATION_REQUIRED`, as any other answer that breaks the contract does, instead of `null` or `unavailable`. The Apps in Toss provider never answers that. The game-side provider reads a host code back with `readBridgeNotificationsHostCode`.
