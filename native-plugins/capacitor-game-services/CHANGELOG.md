# @mpgd/capacitor-game-services

## 0.6.0 — 2026-09-25

### Minor changes

- [b7ffbf9d](https://github.com/imjlk/mpgd-kit/commit/b7ffbf9d8baedbae894063e89a07509fc96dfd46) Add a separate fail-closed credential storage contract to the Capacitor base
  bridge. Android uses a Keystore-held AES-GCM key with no-backup ciphertext
  files, and iOS uses device-only
  Keychain items; neither falls back to ordinary game JSON storage. — Thanks @imjlk!

### Patch changes

- [f6e47baa](https://github.com/imjlk/mpgd-kit/commit/f6e47baa9c84aee3b3ea67bdba192bbeae2ba4af) Add optional Capacitor provider composition with per-method bridge validation and
  fail-closed readiness reporting. Distinguish uninstalled, unconfigured,
  action-required, transient, and available features without changing existing
  purchase result states. Expose subscription and native/remote leaderboard
  availability separately while preserving legacy target configuration defaults.
  Fix the base plugin's ESM-relative export so the published tarball can be
  imported by Node-based consumers and native build tooling.
  Keep generated starter target-availability checks aligned with the new readiness states. — Thanks @imjlk!
- [2812253e](https://github.com/imjlk/mpgd-kit/commit/2812253e50fa375532f3fbbcdd48a2fd7760d791) Bundle the iOS privacy manifest with the Capacitor Swift Package and declare
  the required-reason API usage for legacy UserDefaults storage migration. — Thanks @imjlk!
- Updated dependencies: bridge@0.10.0

## 0.5.4 — 2026-09-24

### Patch changes

- [52026ee](https://github.com/imjlk/mpgd-kit/commit/52026eed535a6414a53f88fa8f5db496beac3e68) Use the host's Capacitor core as a peer dependency throughout the native plugin and adapter, and include it in generated game dependencies. Allow compatible Capacitor 8 Swift Package Manager versions instead of pinning the native plugin to 8.5.1. The reference mobile shell now resolves Capacitor 8.5.2 consistently across npm, Android, and iOS. — Thanks @imjlk!
- [a3c5b76](https://github.com/imjlk/mpgd-kit/commit/a3c5b763ddcc5aef76bd98d9080c33f26390a2ff) Stop returning demo purchase, ad reward, interstitial, and leaderboard successes from the reference native plugin when no real provider is installed. Report those capabilities as unavailable on Android and iOS, reject their operations with stable non-retryable codes, and preserve bridge error codes and retry hints in the Capacitor adapter. — Thanks @imjlk!

## 0.5.3 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.9.1

## 0.5.2 — 2026-09-03

### Patch changes

- [a35d132](https://github.com/imjlk/mpgd-kit/commit/a35d13285100ce41a7d7d86392ba522bf8a64e14) Require Capacitor 8.5.1: the plugin's @capacitor/core dependency range and the
  Swift Package Manager pin now target capacitor-swift-pm 8.5.1, picking up the
  upstream fix that blocks navigation to the internal HTTP proxy path and the
  core removeListener correction. Consumers must build against Capacitor 8.5.1,
  which also adopts the iOS UIScene lifecycle required by Xcode 27. — Thanks @imjlk!

## 0.5.1 — 2026-08-26

### Patch changes

- Updated dependencies: bridge@0.9.0

## 0.5.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.8.0

## 0.4.3 — 2026-07-23

### Patch changes

- Updated dependencies: bridge@0.7.0

## 0.4.2 — 2026-07-17

### Fixed

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.6.1

## 0.4.1 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.6.0

## 0.4.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.5.0

## 0.3.3 — 2026-07-08

### Patch changes

- Updated dependencies: bridge@0.4.0

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: bridge@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: bridge@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: bridge@0.3.0

## 0.2.0 — 2026-07-06

### Patch changes

- Updated dependencies: bridge@0.2.0

## 0.1.0 — 2026-07-04

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks @imjlk!
- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Add target-managed localization support through localized content capabilities, target runtime snapshots, a shared Paraglide-backed message package, demo locale resolution, and mock platform capability responses. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

### Patch changes

- Updated dependencies: bridge@0.1.0

