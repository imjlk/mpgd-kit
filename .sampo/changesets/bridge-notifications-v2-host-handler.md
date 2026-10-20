---
npm/@mpgd/bridge: minor (Added)
---

`@mpgd/bridge/notifications` adds `createNotificationsV2BridgeHandler({ provider })`, the host side of the nine `notifications.v2.*` bridge methods that the Apps in Toss host, the Capacitor in-process bridge, and the Devvit server bridge now share. It checks each payload (`NOTIFICATIONS_INVALID_INPUT`) and answer (`NOTIFICATIONS_CONFIGURATION_REQUIRED`), answers `NOTIFICATIONS_UNSUPPORTED` for a method the provider lacks (`openSettings` answers `unavailable`, and `register` answers no address under `registerOptional`), maps failures fail-closed with a readable host code named in the message, and numbers the provider's events per handler from 0. `label`, `unexpectedFailureMessage`, and `onError` keep host-specific wording and server-side logging.
