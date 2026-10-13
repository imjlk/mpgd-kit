---
npm/@mpgd/platform: minor
---

Notifications v2, PR N3: the capability snapshot block and stricter bridge
answers and events.

- `PlatformCapabilities.notifications` is the optional notifications v2
  capability block of the `notificationsV2` provider a gateway exposes. Like
  the commerce block, it is a fresh object on every read with no unknown keys,
  and `providerAvailability.pushNotifications` equals its `availability`.
- `@mpgd/platform/capability-conformance` checks the block the way it checks
  the commerce block: exact keys, known values, positive integer counts,
  `remote.addressing` `'none'` exactly when remote delivery is unsupported,
  and no record or purposes list, empty or not, shared across reads. The block
  must be present exactly when the gateway exposes `notificationsV2`, with the
  push readiness equal to its availability. A fixture may now expect a
  malformed block or commerce block as is: the runner copies the expected
  state whatever its shape, so only the block checks reject it.
- `assertNotificationBridgeGetCapabilitiesResult` now also checks the block's
  `remote.addressing` rule, as `assertNotificationCapabilities` does, and
  `assertNotificationBridgeRegisterResult` checks the registration's time zone,
  as `assertNotificationEndpointRegistration` does.
- `assertNotificationEvent`, `assertNotificationEventEnvelope`,
  `isNotificationEvent`, and `isNotificationEventEnvelope` apply the same time
  zone rule to an `endpoint-changed` registration.
