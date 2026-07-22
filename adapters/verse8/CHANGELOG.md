# @mpgd/adapter-verse8

## 0.2.2 — 2026-07-23

### Patch changes

- Updated dependencies: catalog@0.5.1, game-services@0.11.0, platform@0.8.0

## 0.2.1 — 2026-07-17

### Patch changes

- Updated dependencies: game-services@0.10.0

## 0.2.0 — 2026-07-17

### Added

- [f3ea335](https://github.com/imjlk/mpgd-kit/commit/f3ea335773e7e0812a65866800789cac0d85a34b) Add opt-in Verse8 Agent8 authenticated-encrypted cloud storage and a server-verified leaderboard provider with authenticated participant scoping, game-specific verification, server-secret-keyed persistence markers, and bounded opaque cursor pagination while keeping the generic native leaderboard disabled. — Thanks @imjlk!
- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Fixed

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!
- [4307985](https://github.com/imjlk/mpgd-kit/commit/4307985f02743278703cb87abb835ed14a92d5d9) Add validated generic consumable resource product grants, preserve them through current and legacy authoritative ledger transactions, and keep unsupported resource products out of Verse8 shops and effective target configurations. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.5.0, game-services@0.9.0, platform@0.7.0

