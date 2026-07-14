# @mpgd/platform

## 0.6.0 — 2026-07-15

### Added

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

## 0.5.1 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

## 0.5.0 — 2026-07-13

### Added

- [81b1bab](https://github.com/imjlk/mpgd-kit/commit/81b1bab1be4e9234187cc1db673d9b724f80d728) Distinguish a presented share surface from confirmed share completion and expose a conservative Devvit share-sheet wrapper. — Thanks @imjlk!

## 0.4.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

### Changed

- [84b3f83](https://github.com/imjlk/mpgd-kit/commit/84b3f836041c5c3513f3b2bf8b2c5414adfded0a) Allow games to define their own logical product and ad placement identifiers while preserving the starter identifiers as suggested literals. — Thanks @imjlk!

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

## 0.2.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

## 0.1.0 — 2026-07-04

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks @imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Add target-managed localization support through localized content capabilities, target runtime snapshots, a shared Paraglide-backed message package, demo locale resolution, and mock platform capability responses. — Thanks imjlk!
- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

