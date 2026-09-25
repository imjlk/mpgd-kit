# @mpgd/platform

## 0.13.0 — 2026-09-25

### Minor changes

- [bd7d0125](https://github.com/imjlk/mpgd-kit/commit/bd7d0125fc8201e17f92988c4ad177563e004175) Connect Capacitor app state, Android back navigation, and classified cold/warm
  URL entry to the platform lifecycle contract. Keep OAuth redirects separate
  from game links, own and dispose only registered listeners, and hold game
  execution while optional external provider UI is still active. Include the
  App plugin in generated native projects. — Thanks @imjlk!
- [f6e47baa](https://github.com/imjlk/mpgd-kit/commit/f6e47baa9c84aee3b3ea67bdba192bbeae2ba4af) Add optional Capacitor provider composition with per-method bridge validation and
  fail-closed readiness reporting. Distinguish uninstalled, unconfigured,
  action-required, transient, and available features without changing existing
  purchase result states. Expose subscription and native/remote leaderboard
  availability separately while preserving legacy target configuration defaults.
  Fix the base plugin's ESM-relative export so the published tarball can be
  imported by Node-based consumers and native build tooling.
  Keep generated starter target-availability checks aligned with the new readiness states. — Thanks @imjlk!
- [7a27b7f8](https://github.com/imjlk/mpgd-kit/commit/7a27b7f8b033ca987eefe859a702d0c08eba0800) Expose an optional Capacitor viewport state and change subscription with
  separate safe-area, system-bar, keyboard, and named occupied-surface geometry.
  Resolve one usable CSS-pixel rectangle without double-counting overlapping
  native or CSS insets, and convert provider-owned physical-pixel surfaces at
  the adapter boundary.
  Align newly scaffolded games with the SystemBars CSS safe-area fallback. — Thanks @imjlk!
- [b7ffbf9d](https://github.com/imjlk/mpgd-kit/commit/b7ffbf9d8baedbae894063e89a07509fc96dfd46) Add a separate fail-closed credential storage contract to the Capacitor base
  bridge. Android uses a Keystore-held AES-GCM key with no-backup ciphertext
  files, and iOS uses device-only
  Keychain items; neither falls back to ordinary game JSON storage. — Thanks @imjlk!

## 0.12.2 — 2026-09-24

### Added

- [095d603](https://github.com/imjlk/mpgd-kit/commit/095d603e33061975bfd1e46a5e24639eee2e8597) Expose server-confirmed consumable purchase settlements from restore flows and
  provide a shared resolver that never treats native checkout completion alone as
  a durable grant. — Thanks @imjlk!

### Patch changes

- [a8cba3e](https://github.com/imjlk/mpgd-kit/commit/a8cba3e5168d94c0bdfc13b0992e7e8c32bcdb2c) The capability conformance runner now rejects a provider that reuses an earlier snapshot after a transition or mutates the fixture's aliased expectation, even when later values appear to match. — Thanks @imjlk!

## 0.12.1 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

## 0.12.0 — 2026-09-02

### Minor changes

- [916f648](https://github.com/imjlk/mpgd-kit/commit/916f648d113c975f8a2bf7074deb38d9506ce014) Add experimental WeChat and TikTok native mini-game target contracts, shared runtime classification, and notification target validation. — Thanks @imjlk!

## 0.11.0 — 2026-08-29

### Minor changes

- [c1c39a2](https://github.com/imjlk/mpgd-kit/commit/c1c39a2aaaefcde6a2a04e5ae06c784df07d0fce) Preserve provider-neutral platform operation codes and retry hints across adapter boundaries. Apps in Toss now uses the current anonymous identity API, coalesces concurrent identity reads for one wrapper session, retries a rejected identity read after the host recovers, and gives generated games an explicit native Sandbox wrapper command without local SDK or identity mocks. — Thanks @imjlk!

## 0.10.0 — 2026-08-26

### Added

- [17cbec9](https://github.com/imjlk/mpgd-kit/commit/17cbec9de406aae06949b1c9df832f3ae0446b95) Add provider-neutral inline banner placements and surface lifecycle methods. Apps in Toss hosts now
  initialize and attach Toss banner ads by game-owned surface ID, report rendered/no-fill/failure
  states, and destroy active attachments on unmount. Target configuration, effective artifacts,
  starter validation, and bridge contracts understand optional `bannerAds` capability flags while
  remaining compatible with previously published adapters and target matrices. — Thanks @imjlk!

## 0.9.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

## 0.8.0 — 2026-07-23

### Added

- [d88309c](https://github.com/imjlk/mpgd-kit/commit/d88309c46dd0df84fc33580eff643fd8c820eab4) Add server-authorized platform promotion rewards and Apps in Toss notification agreement support. — Thanks @imjlk!

## 0.7.0 — 2026-07-17

### Added

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!
- [e3fb909](https://github.com/imjlk/mpgd-kit/commit/e3fb90993fa5b33fdbd293413903d77f52686c08) Add a provider-neutral PlatformGateway capability conformance runner, keep target-configured capability reads live, and isolate bridge-owned capability snapshots before exposing them to callers. — Thanks @imjlk!

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

