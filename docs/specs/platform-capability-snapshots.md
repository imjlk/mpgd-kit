# Platform capability snapshot conformance

This is a confirmed contract for the published
`@mpgd/platform/capability-conformance` runner. It describes what the runner
checks in gateway fixtures; it does not assert that every adapter has passed on
a physical device or is ready for release.

## Snapshot shape {#snapshot-shape}

Every `getCapabilities()` read must return a new object with every required
`PlatformCapabilities` key and no unknown keys. The platform flags are
booleans; `bannerAds` is optional and is treated as `false` when absent.
`commerce` is required and is the only commerce source: a block of `purchase`,
`catalog`, `lifecycle`, `authority`, and `availability` with exact keys and
typed values. A gateway that sells nothing reports a fresh
`createUnsupportedCommerceCapabilities()` block instead of omitting it, and a
gateway with a commerce provider reports that provider's validated block. The
boolean `nativeIap` and `subscriptionIap` flags were removed with the v1
commerce adapter; they are unknown keys now, and a snapshot that carries one
fails. The optional `providerAvailability` record contains per-feature
readiness states for the other providers (commerce readiness is the block's
own `availability`) and is compared with the fixture's expected provider
state, not treated as a boolean capability. Mutating or retaining one
snapshot, nested commerce blocks included, must not change the result of the
next read. The runner compares each read with the fixture's expected provider
state.

- `notifications` holds the notifications v2 `permission`, `remote`, and
  `local` records, an `availability` readiness state, and the `open` path.
  Counts are positive 32-bit integers, `remote.purposes` lists only known
  purposes, and `remote.addressing` is `'none'` exactly when remote delivery
  is unsupported. The block is present exactly when the gateway exposes
  `notificationsV2`, and `providerAvailability.pushNotifications` then equals
  its `availability`.

The notification block, nested records, and purposes list must also be fresh
on every read; frozen shared objects and sparse purpose lists are invalid.

## Provider transitions {#provider-transitions}

When a fixture supplies a transition, its expected capabilities must differ
from the initial state. After the transition updates the provider, a fresh
`getCapabilities()` read must reflect the new expected state. This detects an
adapter or target wrapper that permanently caches its first response.

## Fixture validation {#fixture-validation}

The runner requires at least one fixture. Names must be nonempty and unique,
and each gateway target must equal its fixture's expected target. It reports
the names of fixtures that passed in input order and rejects a fixture whose
gateway violates its expected capability contract.
