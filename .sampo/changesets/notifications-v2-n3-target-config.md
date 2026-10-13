---
npm/@mpgd/target-config: minor
---

Notifications v2, PR N3: `withTargetAvailability` gates `notificationsV2` on
`integrations.notifications`, as it gates the v1 `notifications` adapter.
Before, the provider passed through ungated.

- The provider is exposed only while the target's notifications state is
  `available` or `action-required`, and only when its `getCapabilities`,
  `getPermission`, `requestPermission`, and `subscribe` are functions. Every
  shipped target is gated today: Android, iOS, and Apps in Toss need
  configuration, Reddit needs approval, and the web targets have no
  notification path.
- While the provider is exposed, `getCapabilities()` and `getTargetRuntime()`
  carry `PlatformCapabilities.notifications` from it, with
  `providerAvailability.pushNotifications` set to its availability, so the
  notifications integration state follows the v2 provider. Each read is
  bounded at three seconds, and reads that overlap share one provider read
  while it is in flight, so a read that starts during another gets its
  answer; nothing is kept after it settles. The answer is
  copied into a fresh block with exact keys, and the copy is validated, so a
  sparse `purposes` list does not pass.
- A read that throws, stalls, or answers a block the contract rejects yields
  a block that offers nothing. A failure that is not retryable and recurs on
  the same host is `unsupported`: `NOTIFICATIONS_V2_UNAVAILABLE`,
  `NOTIFICATIONS_UNSUPPORTED`, `NOTIFICATIONS_HOST_VERSION_UNSUPPORTED`, and
  the `UNSUPPORTED_METHOD` or `INVALID_BRIDGE_REQUEST` of a bridge that
  predates the methods. `NOTIFICATIONS_CONFIGURATION_REQUIRED` is
  `configuration-required`, and anything else, including a retryable
  transport failure and a timeout, is `temporarily-unavailable`. While the
  provider is hidden the block is left out.
- A gateway with only `notificationsV2` supports the notifications integration;
  the v1 adapter is still exposed only when it has both of its methods.
