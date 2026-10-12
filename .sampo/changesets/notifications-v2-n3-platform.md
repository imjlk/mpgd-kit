---
npm/@mpgd/platform: minor
---

Notifications v2, PR N3: the capability snapshot block and stricter bridge
answers.

- `PlatformCapabilities.notifications` is the optional notifications v2
  capability block of the `notificationsV2` provider a gateway exposes. Like
  the commerce block, it is a fresh object on every read with no unknown keys,
  and `providerAvailability.pushNotifications` equals its `availability`.
- `@mpgd/platform/capability-conformance` accepts the block and checks it the
  same way: exact keys, known values, positive integer counts, `remote.addressing`
  `'none'` exactly when remote delivery is unsupported, no record or purposes
  list shared across reads, and the push readiness equal to its availability.
- `assertNotificationBridgeGetCapabilitiesResult` now also checks the block's
  `remote.addressing` rule, as `assertNotificationCapabilities` does, and
  `assertNotificationBridgeRegisterResult` checks the registration's time zone,
  as `assertNotificationEndpointRegistration` does.
