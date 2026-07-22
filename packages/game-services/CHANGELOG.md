# @mpgd/game-services

## 0.11.0 — 2026-07-23

### Added

- [8f71019](https://github.com/imjlk/mpgd-kit/commit/8f710196ec0602181ea83599b390d47cb78a1cf6) Add an Apps in Toss partner API client for mTLS user-key verification and functional-message delivery. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.8, catalog@0.5.1, platform@0.8.0

## 0.10.0 — 2026-07-17

### Added

- [e20c08a](https://github.com/imjlk/mpgd-kit/commit/e20c08a59e15adb664022a120babb07bb1f18dca) Add a Google Play one-time-product server verification boundary with token-safe evidence identities and fixtures, independent account/profile binding resolvers, fail-closed rental handling, race-safe idempotency rechecks and post-ledger acknowledge or consume finalization, authoritative identity suppression, independently bounded and observable finalizer retries, abort-safe lease recovery, stored-context recovery, retry metadata, and deterministic fail-closed conformance fixtures. — Thanks @imjlk!
- [807eb4b](https://github.com/imjlk/mpgd-kit/commit/807eb4b322f06c879a79f97187b74b9b74fc1a81) Add a fail-closed Apps in Toss purchase and rewarded-ad evidence verifier boundary, a deadline-bounded SDK-compatible in-callback product-grant API with a nominal abort-aware transport port and failure diagnostics, versioned callback envelopes, grant-time purchase source enforcement, deterministic order timestamp parsing, explicit-zone reward timestamps, three-way request/evidence/authority reward correlation, authority fixtures, and conformance coverage for server matching, pending-order recovery, idempotent retries, replays, and authority failures. — Thanks @imjlk!
- [876992e](https://github.com/imjlk/mpgd-kit/commit/876992e6f76fcf88156f0097200f5819e42f1b1a) Add a fail-closed App Store Server API one-time-purchase verifier, explicit dependency-outage errors with cancellation propagation and bounded response-stream handling, retryable lookup/response handling, original-transaction replay identity for non-consumables, deterministic conformance fixtures, and a CI smoke boundary that accepts only cryptographically verified, single-grant transactions matching the configured app, product, UUID account binding, environment, provider purchase timestamp, and active transaction state. — Thanks @imjlk!
- [4d3634a](https://github.com/imjlk/mpgd-kit/commit/4d3634adfd1e65aa32c6ab6e1ea19e4c19b9192b) Add a Web Crypto AdMob server-side reward verifier with signed claim binding, bounded callback freshness, deterministic transaction replay protection through the entitlement ledger, and a portable conformance fixture. — Thanks @imjlk!

## 0.9.0 — 2026-07-17

### Added

- [4307985](https://github.com/imjlk/mpgd-kit/commit/4307985f02743278703cb87abb835ed14a92d5d9) Add validated generic consumable resource product grants, preserve them through current and legacy authoritative ledger transactions, and keep unsupported resource products out of Verse8 shops and effective target configurations. — Thanks @imjlk!
- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [6acccf2](https://github.com/imjlk/mpgd-kit/commit/6acccf217463fc3280f19273188f660285707d5e) Add a provider-neutral verified leaderboard durability conformance suite with ambiguous-commit fixtures and apply it to D1, Redis, and Agent8 recovery paths. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.7, catalog@0.5.0, platform@0.7.0

## 0.8.2 — 2026-07-15

### Fixed

- [d5a434a](https://github.com/imjlk/mpgd-kit/commit/d5a434a05d1b23e9fb8046a995a691cb8bfe7c18) Reject verified leaderboard snapshots with inconsistent page ordering, ranks, totals, or continuation cursors before they cross provider and transport boundaries. — Thanks @imjlk!

## 0.8.1 — 2026-07-15

### Fixed

- [a18483a](https://github.com/imjlk/mpgd-kit/commit/a18483a286bfae17641951e0322fedd7ca45a7df) Reject calendar-impossible UTC timestamps in server-driven platform fulfillment
  and refund orders instead of accepting `Date.parse` overflow normalization. — Thanks @imjlk!

## 0.8.0 — 2026-07-15

### Added

- [947a834](https://github.com/imjlk/mpgd-kit/commit/947a8347ec6e55c07b086ff06954deab7ad331c3) Add a server-driven platform order contract for Reddit fulfillment and refunds,
  including strict runtime assertions and deterministic order idempotency keys. — Thanks @imjlk!
- [ec79bf0](https://github.com/imjlk/mpgd-kit/commit/ec79bf095f2a35b78d18b0b8a91ebdb5124c9df2) Added a provider-neutral purchase and rewarded-ad evidence verifier boundary,
  versioned adapter evidence envelopes, explicit development verifier helpers,
  bounded verifier execution, authority-level replay protection, and fail-closed
  entitlement grants when production verification is unavailable. Idempotency
  retries now reject changes to the original logical grant or platform target,
  including raced writes, while concurrent identical retries return the original
  successful ledger result. Existing stores can use list fallbacks when optional
  indexed idempotency, authority-evidence, or historical platform-evidence
  lookups are not implemented; both evidence identities are serialized per store
  instance before the fallback write. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.6, catalog@0.4.0, platform@0.6.0

## 0.7.0 — 2026-07-14

### Added

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Add bounded immutable numeric metrics to verified attempts and ranked entries,
  preserving them across memory, Devvit Redis, Cloudflare D1, and authenticated
  snapshot transports without changing score-based ranking behavior. — Thanks @imjlk!

## 0.6.0 — 2026-07-14

### Added

- [f81d3fa](https://github.com/imjlk/mpgd-kit/commit/f81d3fa30da83537d838442ef934642b433e347b) Add authenticated read-only verified leaderboard fetch helpers and opaque
  keyset cursor pagination shared by memory and D1 providers, with bounded,
  well-formed board and attempt identifiers that keep every generated continuation
  cursor transport-safe. — Thanks @imjlk!
- [8599f11](https://github.com/imjlk/mpgd-kit/commit/8599f11b891535635e4aab1cb37d180f1ab861c2) Add a reusable, test-framework-independent conformance suite for verified
  leaderboard providers, including concurrent idempotency and mutation isolation. — Thanks @imjlk!
- [4eb7cee](https://github.com/imjlk/mpgd-kit/commit/4eb7cee9b2088e3734af673af6db33e8c8a7c51b) Add a provider-neutral verified leaderboard boundary with separate public-read
  and trusted server-write ports, first/best attempt selection, deterministic
  snapshots, and an in-memory reference implementation. — Thanks @imjlk!

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.5, catalog@0.3.5, platform@0.5.1

## 0.5.0 — 2026-07-13

### Added

- [fd25ffe](https://github.com/imjlk/mpgd-kit/commit/fd25ffec5041036288c5aa4b10bd8ab5114b0499) Add a shared Game Services runtime factory that disables production clients without an authoritative backend URL and permits process-local backends only through explicit non-production opt-in. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.4, catalog@0.3.4, platform@0.5.0

## 0.4.0 — 2026-07-11

### Added

- [3742ee6](https://github.com/imjlk/mpgd-kit/commit/3742ee60abce4339823af78013c13d958b3ef64a) Add bounded, verified guest-progress reconciliation and durable, idempotent notification delivery provider and ledger contracts. — Thanks @imjlk!

### Changed

- [84b3f83](https://github.com/imjlk/mpgd-kit/commit/84b3f836041c5c3513f3b2bf8b2c5414adfded0a) Allow games to define their own logical product and ad placement identifiers while preserving the starter identifiers as suggested literals. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.3, catalog@0.3.3, platform@0.4.0

## 0.3.3 — 2026-07-08

### Changed

- [09fc2d9](https://github.com/imjlk/mpgd-kit/commit/09fc2d9e44041325de0a91a07fb355ac3014f290) Document and regression-test the game-services ledger idempotency contract for
  source-scoped entitlement grants and leaderboard run records. — Thanks @imjlk!

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: analytics@0.3.2, catalog@0.3.2, platform@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: analytics@0.3.1, catalog@0.3.1, platform@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: analytics@0.3.0, catalog@0.3.0, platform@0.3.0

## 0.2.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: analytics@0.2.0, catalog@0.2.0, platform@0.2.0

## 0.1.0 — 2026-07-04

### Added

- [500e57d](https://github.com/imjlk/mpgd-kit/commit/500e57da6e25d7cbc9aeff2a6222d267f077cd87) Add a ledger-first Game Services vertical slice for reusable purchase, rewarded ad, and leaderboard flows. Platform callbacks are now treated as evidence, while grants and score records are accepted only after backend verifier or ledger APIs respond. — Thanks @imjlk!
- [500e57d](https://github.com/imjlk/mpgd-kit/commit/500e57da6e25d7cbc9aeff2a6222d267f077cd87) Add a game services backend contract using oRPC v2 beta, async store-backed authoritative grants and leaderboard records, and a Cloudflare Vite plugin Worker starter with HTTP, oRPC, and WorkerEntrypoint service binding surfaces. — Thanks @imjlk!
- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!
- [500e57d](https://github.com/imjlk/mpgd-kit/commit/500e57da6e25d7cbc9aeff2a6222d267f077cd87) Add a typed Game Services backend API boundary with endpoint transport helpers, a fetch transport, and an in-process backend handler for local demos and smoke tests. — Thanks imjlk!

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Patch changes

- Updated dependencies: analytics@0.1.0, catalog@0.1.0, platform@0.1.0

