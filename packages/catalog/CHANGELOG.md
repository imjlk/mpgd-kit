# @mpgd/catalog

## 0.5.0 — 2026-07-17

### Added

- [4307985](https://github.com/imjlk/mpgd-kit/commit/4307985f02743278703cb87abb835ed14a92d5d9) Add validated generic consumable resource product grants, preserve them through current and legacy authoritative ledger transactions, and keep unsupported resource products out of Verse8 shops and effective target configurations. — Thanks @imjlk!
- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.7.0

## 0.4.0 — 2026-07-15

### Added

- [6888e52](https://github.com/imjlk/mpgd-kit/commit/6888e52724788139fadb425459d92b5ed409cc4c) Allow game-owned Reddit product SKUs in product catalogs, mark Devvit IAP as
  target-supported, and gate commerce calls on the runtime IAP capability until
  a payments adapter is installed. Devvit artifact smoke checks validate payment
  endpoints and require products.json SKUs to match the effective game catalog. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.6.0

## 0.3.5 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.5.1

## 0.3.4 — 2026-07-13

### Patch changes

- Updated dependencies: platform@0.5.0

## 0.3.3 — 2026-07-11

### Changed

- [84b3f83](https://github.com/imjlk/mpgd-kit/commit/84b3f836041c5c3513f3b2bf8b2c5414adfded0a) Allow games to define their own logical product and ad placement identifiers while preserving the starter identifiers as suggested literals. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.4.0

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: platform@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: platform@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: platform@0.3.0

## 0.2.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: platform@0.2.0

## 0.1.0 — 2026-07-04

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

### Patch changes

- Updated dependencies: platform@0.1.0

