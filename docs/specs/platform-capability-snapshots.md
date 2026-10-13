# Platform capability snapshot conformance

This is a confirmed contract for the published
`@mpgd/platform/capability-conformance` runner. It describes what the runner
checks in gateway fixtures; it does not assert that every adapter has passed on
a physical device or is ready for release.

## Snapshot shape {#snapshot-shape}

Every `getCapabilities()` read must return a new object with every required
`PlatformCapabilities` key, no unknown keys, and boolean values. `bannerAds` is
optional and is treated as `false` when absent; `subscriptionIap` follows the
same rule. The optional `providerAvailability` record contains per-feature
readiness states and is compared with the fixture's expected provider state,
not treated as a boolean capability.

Two optional blocks describe a provider in more detail. Each must have exactly
its declared keys and known values, and be compared with the fixture's
expected block:

- `commerce` holds the commerce v2 `purchase`, `catalog`, `lifecycle`, and
  `authority` records and an `availability` readiness state. `nativeIap` and
  `subscriptionIap` must equal the values derived from it.
- `notifications` holds the notifications v2 `permission`, `remote`, and
  `local` records, an `availability` readiness state, and the `open` path.
  Counts are positive 32-bit integers, `remote.purposes` lists only known
  purposes, and `remote.addressing` is `'none'` exactly when remote delivery
  is unsupported. The block is present exactly when the gateway exposes
  `notificationsV2`, and `providerAvailability.pushNotifications` then equals
  its `availability`.

Mutating or retaining one snapshot, including a nested record or the purposes
list of a block, must not change the result of the next read. The runner
compares each read with the fixture's expected provider state.

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
