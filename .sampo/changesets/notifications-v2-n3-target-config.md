---
npm/@mpgd/target-config: minor
---

Notifications v2, PR N3: `withTargetAvailability` gates `notificationsV2` on
`integrations.notifications`, as it gates the v1 `notifications` adapter.
Before, the provider passed through ungated.

- The provider is exposed only while the target's notifications state is
  `available` or `action-required`. Every shipped target is gated today:
  Android, iOS, and Apps in Toss need configuration, Reddit needs approval,
  and the web targets have no notification path.
- While the provider is exposed, `getCapabilities()` and `getTargetRuntime()`
  carry `PlatformCapabilities.notifications` from it: one read bounded at three
  seconds, copied into a fresh block with exact keys, with
  `providerAvailability.pushNotifications` set to its availability, so the
  notifications integration state follows the v2 provider. A read that throws,
  stalls, or answers a block the contract rejects yields a block that offers
  nothing: `unsupported` for `NOTIFICATIONS_V2_UNAVAILABLE` or
  `NOTIFICATIONS_UNSUPPORTED`, `configuration-required` for
  `NOTIFICATIONS_CONFIGURATION_REQUIRED`, and `temporarily-unavailable`
  otherwise. While it is hidden the block is left out.
- A gateway with only `notificationsV2` supports the notifications integration;
  the v1 adapter is still exposed only when it has both of its methods.
