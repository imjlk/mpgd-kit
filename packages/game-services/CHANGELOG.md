# @mpgd/game-services

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

