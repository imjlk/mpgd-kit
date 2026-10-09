# @mpgd/adapter-verse8

## 0.4.3 — 2026-10-10

### Patch changes

- Updated dependencies: game-runtime@0.6.0

## 0.4.2 — 2026-10-09

### Patch changes

- Updated dependencies: catalog@0.8.0, game-runtime@0.5.0, game-services@0.19.0, platform@0.17.0

## 0.4.1 — 2026-10-09

### Patch changes

- Updated dependencies: catalog@0.7.8, game-runtime@0.4.0, game-services@0.18.1, platform@0.16.0

## 0.4.0 — 2026-10-09

### Added

- [ae650009](https://github.com/imjlk/mpgd-kit/commit/ae65000999f0b97bbeebafd856bc8995bb890edd) Expose Verse8 advertising through the versioned behavior contract with original SDK request identity and scoped host presentation observations. Require reliable host closure for rewarded display, keep timed-out presentation occupied until a real terminal fact, and return only ungranted server-verifiable evidence. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.7.7, game-runtime@0.3.0, game-services@0.18.0, platform@0.15.0

## 0.3.12 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.2

## 0.3.11 — 2026-10-04

### Patch changes

- [c3e9f87c](https://github.com/imjlk/mpgd-kit/commit/c3e9f87cd7dc4f7c4ebcfbe6a1458b4977d363d1) Stop client adapters from returning grant-shaped rewarded-ad results.
  
  - `@mpgd/adapter-verse8`: a Verse8 `rewarded` SDK callback now resolves to
    `status: 'completed', rewardGranted: false` with the `verse8.ads.reward.v1`
    evidence envelope and no `ledgerEntryId`. The Verse8 `requestId` is an
    impression id, not a ledger entry; only the backend verifier may grant.
  - `@mpgd/adapter-browser`: `createBrowserPlatformGateway()` never returns a
    grant on any code path. By default commerce and ads report unavailable and
    `purchase()` fails closed. The new `mockCommerce: true` option adds a
    local-demo sample catalog with evidence-only results: `purchase()` resolves
    `status: 'completed'` with a mock `transactionId`, empty `entitlementIds`,
    no `authoritativeGrant`, and `mpgd.browser.mock-purchase.v1` evidence;
    `showRewarded()` resolves `status: 'completed', rewardGranted: false` with
    no `ledgerEntryId` and `mpgd.browser.mock-reward.v1` evidence. Neither
    schema is accepted by backend claim APIs. The schema strings are exported as
    `browserMockPurchaseEvidenceSchema` and `browserMockRewardEvidenceSchema`.
    `withMicrosoftStoreCommerceAdapter` now replaces the base `ads` surface with
    an unavailable adapter and reports ad capabilities as false.
    `createUnavailableAdAdapter` is exported for custom gateways.
  - `@mpgd/game-services`: `createGameServicesClient` forwards allow-listed
    client reward evidence (AdMob and Verse8) to `claimAdReward`, deriving
    `platformImpressionId` from the Verse8 evidence `requestId`. New exports:
    `isClientRewardEvidence`, `isVerse8ClientRewardEvidence`,
    `resolveRewardPlatformImpressionId`, `clientRewardEvidenceSchemas`,
    `verse8ClientRewardEvidenceSchema`. Recoverable monetization clients bind
    journaled Verse8 claims to the evidence-derived impression id. — Thanks @imjlk!
- Updated dependencies: game-services@0.17.1

## 0.3.10 — 2026-09-28

### Patch changes

- Updated dependencies: catalog@0.7.6, game-services@0.17.0, platform@0.14.0

## 0.3.9 — 2026-09-25

### Patch changes

- Updated dependencies: catalog@0.7.5, game-services@0.16.0, platform@0.13.0

## 0.3.8 — 2026-09-24

### Patch changes

- Updated dependencies: catalog@0.7.4, game-services@0.15.3, platform@0.12.2

## 0.3.7 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.7.3, game-services@0.15.2, platform@0.12.1

## 0.3.6 — 2026-09-13

### Patch changes

- Updated dependencies: game-services@0.15.1

## 0.3.5 — 2026-09-13

### Patch changes

- Updated dependencies: game-services@0.15.0

## 0.3.4 — 2026-09-02

### Patch changes

- Updated dependencies: catalog@0.7.2, game-services@0.14.0, platform@0.12.0

## 0.3.3 — 2026-08-29

### Patch changes

- Updated dependencies: catalog@0.7.1, game-services@0.13.1, platform@0.11.0

## 0.3.2 — 2026-08-27

### Patch changes

- Updated dependencies: game-services@0.13.0

## 0.3.1 — 2026-08-26

### Patch changes

- Updated dependencies: catalog@0.7.0, game-services@0.12.1, platform@0.10.0

## 0.3.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.6.0, game-services@0.12.0, platform@0.9.0

## 0.2.3 — 2026-08-04

### Changed

- [6ae2720](https://github.com/imjlk/mpgd-kit/commit/6ae27206b4aaae601c7feaa4ca7946b7cad5c654) Allow safe game-owned `kind: "web"` target names in build, smoke, and matrix CLI workflows while preserving the existing browser and web aliases. Support additive game-owned target-config policies at build time and runtime, monetization identifiers, authoritative purchase and reward verification for custom deployments, verified non-installable browser artifacts, and bounded static web artifact overlays for custom browser deployments while reserving platform-specific PWA policy for its canonical target. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.5.2, game-services@0.11.1

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

