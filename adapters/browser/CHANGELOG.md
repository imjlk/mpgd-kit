# @mpgd/adapter-browser

## 0.8.0 — 2026-10-09

### Minor changes

- [2d35eb0e](https://github.com/imjlk/mpgd-kit/commit/2d35eb0ecd89eef1058e4b9983eb284f7ba38adc) Add a CrazyGames web target and the browser adapter's `/crazygames` entry point with official v3 SDK initialization, loading/gameplay reporting, and interstitial ads using the shared presentation contract. Basic Launch keeps monetization disabled; Full Launch enables configured interstitial placements. Rewarded ads and purchases remain unavailable pending independent backend verification. Generated starters enter free play directly and retain scene, lifecycle, and native presentation ownership through game-owned gameplay scopes. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.16.0

## 0.7.9 — 2026-10-09

### Patch changes

- Updated dependencies: platform@0.15.0

## 0.7.8 — 2026-10-04

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

## 0.7.7 — 2026-09-28

### Patch changes

- Updated dependencies: platform@0.14.0

## 0.7.6 — 2026-09-25

### Patch changes

- Updated dependencies: platform@0.13.0

## 0.7.5 — 2026-09-24

### Patch changes

- Updated dependencies: platform@0.12.2

## 0.7.4 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.12.1

## 0.7.3 — 2026-09-02

### Patch changes

- Updated dependencies: platform@0.12.0

## 0.7.2 — 2026-08-29

### Patch changes

- Updated dependencies: platform@0.11.0

## 0.7.1 — 2026-08-26

### Patch changes

- Updated dependencies: platform@0.10.0

## 0.7.0 — 2026-08-21

### Minor changes

- [842fc11](https://github.com/imjlk/mpgd-kit/commit/842fc1190d92692cf503233d9f916ea49d9b050c) Add a bounded WebView2 message bridge for native Microsoft Store player sign-in, catalog,
  purchase, and ownership operations. Native StoreContext hosts can now reuse the browser commerce
  adapter without granting purchases from client callbacks. The sign-in contract keeps the Microsoft
  ID token, publisher ticket, and User Collections ID inside the trusted native host and returns only
  a short-lived game-scoped session to web content. — Thanks @imjlk!

## 0.6.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!
### Patch changes

- Updated dependencies: platform@0.9.0

## 0.5.1 — 2026-07-23

### Patch changes

- Updated dependencies: platform@0.8.0

## 0.5.0 — 2026-07-17

### Added

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.7.0

## 0.4.3 — 2026-07-15

### Patch changes

- Updated dependencies: platform@0.6.0

## 0.4.2 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.5.1

## 0.4.1 — 2026-07-13

### Patch changes

- Updated dependencies: platform@0.5.0

## 0.4.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

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
- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Add target-managed localization support through localized content capabilities, target runtime snapshots, a shared Paraglide-backed message package, demo locale resolution, and mock platform capability responses. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

### Patch changes

- Updated dependencies: platform@0.1.0
