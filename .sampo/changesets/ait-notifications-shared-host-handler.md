---
npm/@mpgd/adapter-ait: patch (Changed)
---

The Apps in Toss host serves `notifications.v2.*` with `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`, the handler the Capacitor and Devvit bridges share. For this repository's errors, codes, retryable flags, and events are unchanged (some error messages are reworded), except that a provider answering `register` or `openSettings` with `undefined` now answers `NOTIFICATIONS_CONFIGURATION_REQUIRED`, as any other answer that breaks the contract does, instead of `null` or `unavailable`. The Apps in Toss provider never answers that. The game-side provider reads a host code back with `readBridgeNotificationsHostCode`. Failures are now also read by shape, so an error from another copy of `@mpgd/platform`, or a thrown object with a platform `code` and `retryable: false`, keeps its notifications code and retryable flag.
