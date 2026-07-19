# @mpgd/target-config

## 0.9.0 — 2026-07-20

### Changed

- [5c39d37](https://github.com/imjlk/mpgd-kit/commit/5c39d376db59231d35740525f5cf85e4c7dd2df0) Add a reusable Apps in Toss production host bridge backed by the official game identity,
  Storage, Ads 2.0, sharing, lifecycle, and Game Center APIs. Rewarded ads load before display and
  forward callback evidence without issuing demo grants, while commerce stays fail-closed until a
  game installs its own verified purchase flow.
  
  Allow game targets to opt out of authoritative game services. Opted-out targets disable IAP and
  ad features in their effective configuration and no longer require a production backend URL,
  while targets that enable authoritative grants keep the public HTTPS backend release gate.
  
  Scaffold each generated game with its own Apps in Toss wrapper, Granite configuration, and
  `@ait-co/devtools` workflow. The wrapper reuses the adapter's exported bundle loader while
  keeping app identity, console state, icons, and review metadata owned by the game repository.
  Expose a shared AIT ad-placement extractor for wrapper builds, preserve configuration parse
  causes, and publish package metadata that the official `.ait` dependency collector can resolve
  from both installed packages and Kit workspaces. — Thanks @imjlk!

## 0.8.0 — 2026-07-17

### Fixed

- [4307985](https://github.com/imjlk/mpgd-kit/commit/4307985f02743278703cb87abb835ed14a92d5d9) Add validated generic consumable resource product grants, preserve them through current and legacy authoritative ledger transactions, and keep unsupported resource products out of Verse8 shops and effective target configurations. — Thanks @imjlk!
- [e3fb909](https://github.com/imjlk/mpgd-kit/commit/e3fb90993fa5b33fdbd293413903d77f52686c08) Add a provider-neutral PlatformGateway capability conformance runner, keep target-configured capability reads live, and isolate bridge-owned capability snapshots before exposing them to callers. — Thanks @imjlk!

### Added

- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.5.0, i18n@0.5.3, platform@0.7.0

## 0.7.0 — 2026-07-15

### Changed

- [6888e52](https://github.com/imjlk/mpgd-kit/commit/6888e52724788139fadb425459d92b5ed409cc4c) Allow game-owned Reddit product SKUs in product catalogs, mark Devvit IAP as
  target-supported, and gate commerce calls on the runtime IAP capability until
  a payments adapter is installed. Devvit artifact smoke checks validate payment
  endpoints and require products.json SKUs to match the effective game catalog. — Thanks @imjlk!

### Fixed

- [e4a89d7](https://github.com/imjlk/mpgd-kit/commit/e4a89d7d7788e7b103a17bbefc5389534c1e7b32) Stop advertising a native Devvit leaderboard and disable the generic client
  score submission path in both the shared target and generated starters. Devvit
  games continue to use the server-only verified leaderboard provider from
  authoritative completion handlers. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.4.0, i18n@0.5.2, platform@0.6.0

## 0.6.1 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.3.5, i18n@0.5.1, platform@0.5.1

## 0.6.0 — 2026-07-13

### Changed

- [5fb3dca](https://github.com/imjlk/mpgd-kit/commit/5fb3dcaf9a6bc491a650221058595e505a725466) Merge target-specific integration overrides into effective target configuration and wire generated game runtimes to enforce the merged availability and presentation-mode contract. — Thanks @imjlk!
- [fc6c6ab](https://github.com/imjlk/mpgd-kit/commit/fc6c6ab4a6d4be5c845606f73f2a3ed492b768fe) Add target-aware locale resolution with saved-value and device-language priority, plus target-configured fallback locales in runtime and effective config. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.3.4, i18n@0.5.0, platform@0.5.0

## 0.5.0 — 2026-07-11

### Fixed

- [001c3b5](https://github.com/imjlk/mpgd-kit/commit/001c3b59abb0a435ad318aaddf24753fd09f7eee) Emit Node ESM-compatible relative specifiers from the target-config package and verify the built package can be imported directly. — Thanks @imjlk!

### Added

- [3b7a57f](https://github.com/imjlk/mpgd-kit/commit/3b7a57fb4472e00626650b265387611326219e3f) Add backward-compatible, stateful integration readiness and presentation-mode data to target config, effective config, and runtime snapshots. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.3.3, platform@0.4.0

## 0.4.0 — 2026-07-10

### Added

- [53f4e59](https://github.com/imjlk/mpgd-kit/commit/53f4e59ab9f2f82545981f4c19df6ff582378e86) Add viewport orientation policy planning and starter guidance. — Thanks @imjlk!

## 0.3.4 — 2026-07-09

### Added

- [fcb9501](https://github.com/imjlk/mpgd-kit/commit/fcb950101e70315d7c96e60f717b197082e416c2) Add target viewport breakpoint helpers and generated Phaser starter guidance for compact, medium, expanded, portrait, landscape, and Devvit embedded-webview layouts. The Phaser starter now measures the game container first and uses target viewport recommendations for control/panel placement. — Thanks @imjlk!

## 0.3.3 — 2026-07-08

### Added

- [bb96043](https://github.com/imjlk/mpgd-kit/commit/bb96043a56aa7777a3d15028f7e3c68976504637) Add a Microsoft Store PWA target that reuses the browser adapter, ships effective target config and web app manifest metadata, and is available from generated Phaser game target builds while keeping matrix defaults compatible with older target files. — Thanks @imjlk!

### Fixed

- [f6410ad](https://github.com/imjlk/mpgd-kit/commit/f6410ad7765c0ff9f9d68b6578335d5d73f056fe) Treat blank platform product and ad placement IDs as missing in effective target configs. — Thanks @imjlk!

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: catalog@0.3.2, platform@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: catalog@0.3.1, platform@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: catalog@0.3.0, platform@0.3.0

## 0.2.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: catalog@0.2.0, platform@0.2.0

## 0.1.0 — 2026-07-04

### Changed

- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Hard-rename `@mpgd/policy-matrix` to `@mpgd/target-config` and model platform feature availability with `targets.json`, target runtime snapshots, and `localization` as the public feature key. — Thanks @imjlk!
- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks imjlk!
- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Apply target feature availability to runtime platform capabilities and feature actions so disabled IAP, ads, and leaderboard features are unavailable in target-configured gateways. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!
- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Expose target config runtime feature snapshots so apps and smoke tests can verify which IAP, ad, and leaderboard features are available, target-disabled, or unsupported. — Thanks imjlk!

### Added

- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Add target-managed localization support through localized content capabilities, target runtime snapshots, a shared Paraglide-backed message package, demo locale resolution, and mock platform capability responses. — Thanks imjlk!
- [fe760bf](https://github.com/imjlk/mpgd-kit/commit/fe760bf8b8e66e4c9417706607bb78f08512459c) Add effective target config bundles that combine target feature availability with product catalog, ad placement, leaderboard, storage, localization, release, and nested policy metadata. Builds now embed the active bundle in each target payload, release manifests record each bundle path, version, and digest, and the Phaser demo consumes the same effective config for runtime action availability. — Thanks imjlk!
- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

### Patch changes

- Updated dependencies: catalog@0.1.0, platform@0.1.0

