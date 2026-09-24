# @mpgd/adapter-capacitor

The base adapter uses `@mpgd/capacitor-game-services` for bounded local JSON
storage and a small fail-closed bridge. It does **not** install a store, ad,
identity, leaderboard, or push SDK. Pass separately installed modules through
`createCapacitorPlatformGateway({ providers })`; each module declares its
owned bridge methods, provider features, and current availability. Duplicate
method/feature registrations and attempts to replace base storage are errors.

```ts
import {
  createCapacitorPlatformGateway,
  type CapacitorServiceProvider,
} from '@mpgd/adapter-capacitor';

export function createGameGateway(providers: readonly CapacitorServiceProvider[]) {
  return createCapacitorPlatformGateway({
    target: 'android',
    appVersion: '1.0.0',
    buildId: 'game-build',
    providers,
  });
}
```

`getCapabilities()` reports a fresh boolean snapshot and optional
`providerAvailability` detail. The possible states are `unsupported`,
`configuration-required`, `action-required`, `temporarily-unavailable`, and
`available`. A target's `features` configuration is an upper bound, **not**
proof that a provider is installed or ready. `nativeIap` describes one-time
purchases; `subscriptionIap` is separate. Rewarded, interstitial, and banner
ads and native versus remote leaderboards remain distinct. Target-config
applies the configured upper bound to this live provider state.

When native and remote leaderboard routes coexist, the target-config wrapper
selects a `route` on score/open calls; direct adapter callers can request
`route: 'remote'` to use the base remote bridge instead of the native provider.
When one ads provider handles multiple formats, pass `format` to `ads.preload`
so its readiness check cannot use an available format for an unavailable one.

Provider initialization failures and availability reads stalled beyond three
seconds leave the base bridge and local guest boot available. A registered
provider never silently falls back for purchase, ad, or native leaderboard
operations; an explicit remote leaderboard route is a separate path. Errors
retain a stable code and retry hint. The
provider bridge must return a method-shaped response. In particular, an ad
`rewardGranted: true` result requires a backend ledger entry. A native callback
alone is evidence, not a grant. Game-specific product, consent, entitlement,
and identity policy belongs to the consuming game and its backend.

The source tests and installed-tarball consumer validate composition, types,
error paths, and fallback behavior. They do not establish that any optional
SDK works on a physical device or that a store/ad setup is release-ready.
