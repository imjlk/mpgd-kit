---
npm/@mpgd/adapter-ait: patch (Fixed)
---

The Apps in Toss game-side notifications provider fails closed when the host answers `notifications.v2.getCapabilities` with another major notifications protocol version than the game's `notificationsProtocolVersion` (or a version without a major): `getCapabilities` throws `NOTIFICATIONS_CONFIGURATION_REQUIRED`, so the gateway reports notifications as `configuration-required`, as it already did for another provider id.
