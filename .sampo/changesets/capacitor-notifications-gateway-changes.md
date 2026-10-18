---
npm/@mpgd/adapter-capacitor: minor (Changed)
---

`createCapacitorPlatformGateway` drops any `notifications` block the native base answer sends, since the block now comes only from a registered notifications v2 service, and the provider registry refuses a v1 `pushNotifications` provider next to such a service, which serves the v1 `notifications` adapter itself.
