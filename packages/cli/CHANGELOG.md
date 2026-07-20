# @mpgd/cli

## 0.15.2 — 2026-07-20

### Patch changes

- Updated dependencies: adapter-ait@0.5.2

## 0.15.1 — 2026-07-20

### Patch changes

- Updated dependencies: adapter-ait@0.5.1

## 0.15.0 — 2026-07-20

### Added

- [dede158](https://github.com/imjlk/mpgd-kit/commit/dede158e343b1fa8494e3d28ae52a2f0a0b89a16) Add explicit Microsoft Store starter selection, conflict-safe idempotent target
  initialization, and generated agent workflow documentation and skills for
  discovering and validating mpgd-kit capabilities. — Thanks @imjlk!
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

### Patch changes

- Updated dependencies: adapter-ait@0.5.0, target-config@0.9.0

## 0.14.0 — 2026-07-19

### Added

- [dd2ad0c](https://github.com/imjlk/mpgd-kit/commit/dd2ad0cd4c2cffad32e3b38b50d3ab3b15daaefc) Add Windows package acceptance that verifies MSIX and AppX identity against submission evidence, records package hashes, and can optionally run the recommended Windows App Certification Kit check with report hashing. — Thanks @imjlk!
- [3b6e93a](https://github.com/imjlk/mpgd-kit/commit/3b6e93a025162253026f5a68cbb61e731177f60b) Add guarded Microsoft Store PWA package generation with scope-bound pinned manifests, public-only DNS-pinned downloads, local and deployed icon integrity checks, ZIP safety, transactional evidence, and provenance records. — Thanks @imjlk!
- [2c5046a](https://github.com/imjlk/mpgd-kit/commit/2c5046af170f7a31ab93c3f7d3ddb7dee94634ce) Add a game-owned Microsoft Store submission preflight that validates Partner Center identity, listing, privacy, age-rating, commerce, PWA manifest, and screenshot evidence. — Thanks @imjlk!

## 0.13.0 — 2026-07-17

### Patch changes

- Updated dependencies: adapter-devvit@0.8.4, adapter-verse8@0.2.1, game-services@0.10.0

## 0.12.0 — 2026-07-17

### Changed

- [f3ea335](https://github.com/imjlk/mpgd-kit/commit/f3ea335773e7e0812a65866800789cac0d85a34b) Add opt-in Verse8 Agent8 authenticated-encrypted cloud storage and a server-verified leaderboard provider with authenticated participant scoping, game-specific verification, server-secret-keyed persistence markers, and bounded opaque cursor pagination while keeping the generic native leaderboard disabled. — Thanks @imjlk!
- [0e7b585](https://github.com/imjlk/mpgd-kit/commit/0e7b585060a4f9cb39d4cd031d8b233090873644) Add generated Agent8 structured-server acceptance guidance and a CI smoke harness that exercises authenticated verified leaderboard submissions, scoped snapshots, effective Verse8 target configuration, and secret-free starter output. — Thanks @imjlk!

### Fixed

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!

### Added

- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.4, adapter-browser@0.5.0, adapter-capacitor@0.4.4, adapter-devvit@0.8.3, adapter-verse8@0.2.0, analytics@0.3.7, bridge@0.6.1, catalog@0.5.0, game-services@0.9.0, i18n@0.5.3, platform@0.7.0, target-config@0.8.0

## 0.11.0 — 2026-07-15

### Added

- [61f208f](https://github.com/imjlk/mpgd-kit/commit/61f208fa4c38df57ffd75e052913ac4d1b4cfe66) Add a reusable Playwright-compatible browser Gameplay E2E driver that shares normalized input and screenshot handling while keeping lifecycle and game-state inspection hooks consumer-owned. — Thanks @imjlk!
- [59640c1](https://github.com/imjlk/mpgd-kit/commit/59640c17c4189ae7f5550e3e7d23975dd9b99217) Add Playwright-compatible Microsoft Store PWA helpers for reading release evidence, requesting service worker updates, resolving deployment-scoped caches, and verifying atomic A-to-B cache transitions. — Thanks @imjlk!

### Fixed

- [8934ce1](https://github.com/imjlk/mpgd-kit/commit/8934ce1cb5c00a085ce59ea5c12f0813aad32c26) Share bounded evidence reads, path display normalization, Markdown formatting, error formatting, and deterministic JSON and Markdown report writes across CLI verification workflows. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-devvit@0.8.2, game-services@0.8.2

## 0.10.1 — 2026-07-15

### Patch changes

- Updated dependencies: adapter-devvit@0.8.1, game-services@0.8.1

## 0.10.0 — 2026-07-15

### Added

- [7d1108e](https://github.com/imjlk/mpgd-kit/commit/7d1108ef1d81262b5a707af6f7e57289b6c5f2b3) Add conservatively indexed durable Devvit post operations and scope-bound cursor
  pagination for bounded recovery workers. Stable registry membership is created
  before durable state and retained across every transition, preventing live work
  from disappearing through partial cross-key updates. Discovery remains read-only
  and keeps attempted and terminal outcomes fail-closed instead of restoring submit
  permission. Exact operation reads and transitions lazily backfill stable registry
  membership for durable records created before indexed discovery was enabled.
  Best-effort read backfills use the stored descriptor even on conflicts and never
  mask an already-readable durable result, while state mutations still require
  registry membership first. — Thanks @imjlk!
- [956b93c](https://github.com/imjlk/mpgd-kit/commit/956b93c28ca46899fb3acfda79d1abda072fdb4c) Add a manifest-driven target gameplay E2E contract with strict plan parsing,
  normalized input actions, fail-safe pause and resume handling, session
  continuity checks, per-state screenshots, and hashed plan, artifact, and release
  evidence. Game-owned automation drivers remain optional and outside Phaser
  scenes; when a `gameplay:e2e` script is configured, `mpgd game accept` now runs
  it after target smoke and requires a passing standard report for handoff. — Thanks @imjlk!

### Fixed

- [e4a89d7](https://github.com/imjlk/mpgd-kit/commit/e4a89d7d7788e7b103a17bbefc5389534c1e7b32) Stop advertising a native Devvit leaderboard and disable the generic client
  score submission path in both the shared target and generated starters. Devvit
  games continue to use the server-only verified leaderboard provider from
  authoritative completion handlers. — Thanks @imjlk!

### Changed

- [cddcba8](https://github.com/imjlk/mpgd-kit/commit/cddcba899e912b28e18fdca3b1520cbda992ccd7) Add an official-terminology Devvit view mode API with a concurrency-safe,
  retryable inline mode gameplay loader. Generated Phaser starters now keep their
  initial launch screen lightweight, start gameplay inside the post after an
  explicit click, and retain the separate expanded mode game entry. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.3, adapter-browser@0.4.3, adapter-capacitor@0.4.3, adapter-devvit@0.8.0, analytics@0.3.6, catalog@0.4.0, game-services@0.8.0, i18n@0.5.2, platform@0.6.0, target-config@0.7.0

## 0.9.0 — 2026-07-14

### Removed

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Upgrade generated Devvit targets to the stable 0.13.8 toolchain and remove the
  deprecated JSON fetch bridge API, JSON route, pre-namespace storage fallback,
  and split build strategy so Devvit targets use oRPC and the official Vite plugin
  exclusively. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-devvit@0.7.0, game-services@0.7.0

## 0.8.0 — 2026-07-14

### Added

- [2f06373](https://github.com/imjlk/mpgd-kit/commit/2f063737d518a19d93de0781bf44582c0a0bc78b) Add an opt-in official Devvit Vite build strategy for generated Phaser games,
  upgrade Devvit packages to 0.13.7, expose a direct oRPC Node HTTP bridge
  adapter, and remove the generated target's Express-based request conversion. — Thanks @imjlk!

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.2, adapter-browser@0.4.2, adapter-capacitor@0.4.2, adapter-devvit@0.6.0, analytics@0.3.5, bridge@0.6.0, catalog@0.3.5, game-services@0.6.0, i18n@0.5.1, phaser-assets@0.4.1, platform@0.5.1, target-config@0.6.1

## 0.7.0 — 2026-07-13

### Added

- [fd32478](https://github.com/imjlk/mpgd-kit/commit/fd3247854df451008b7c42d619977d8a09999ad2) Fail closed before production AIT, Android, and iOS builds unless the target uses a game-owned wrapper or shell and a public HTTPS game-services endpoint. — Thanks @imjlk!
- [fdacd52](https://github.com/imjlk/mpgd-kit/commit/fdacd52c510f09ea8723c1665e729515b64817a7) Add a single-source PNG/SVG app icon pipeline with versioned target profiles, per-target overrides, generated-game CLI commands, automatic target staging, and digest-linked release evidence. — Thanks @imjlk!
- [2a60e46](https://github.com/imjlk/mpgd-kit/commit/2a60e4688f5d15e2740c9219476a006eaf6f3ae7) Generate target-isolated platform gateway entrypoints so production bundles include only the selected platform adapter. — Thanks @imjlk!
- [420ad8f](https://github.com/imjlk/mpgd-kit/commit/420ad8fb5b54e4aa6b049aa5a220a2294ef4f2f6) Generate deterministic Microsoft Store PWA release evidence, atomic offline updates, and target-aware service worker registration in Phaser game starters. — Thanks @imjlk!
- [74bd3cc](https://github.com/imjlk/mpgd-kit/commit/74bd3cc38b769d3ee8622938815c0e8624d29b38) Add `mpgd game accept` for reusable check, test, build, graph, playtest, target-matrix, and JSON/Markdown handoff reporting. — Thanks @imjlk!

### Changed

- [5a4f259](https://github.com/imjlk/mpgd-kit/commit/5a4f259ff196db50f5bd53cbd4e9f91bae9b2bd5) Add a duplicate-safe, ambiguity-safe Devvit custom-post operation coordinator and include its Redis-backed server wrapper in generated starters. — Thanks @imjlk!
- [2f51b58](https://github.com/imjlk/mpgd-kit/commit/2f51b580aa5057d0d18e1820b1ed5b9d50d86d7e) Add reusable Devvit web-surface routing and generate physically separate lightweight inline and expanded Phaser entries. — Thanks @imjlk!
- [5fb3dca](https://github.com/imjlk/mpgd-kit/commit/5fb3dcaf9a6bc491a650221058595e505a725466) Merge target-specific integration overrides into effective target configuration and wire generated game runtimes to enforce the merged availability and presentation-mode contract. — Thanks @imjlk!
- [fd25ffe](https://github.com/imjlk/mpgd-kit/commit/fd25ffec5041036288c5aa4b10bd8ab5114b0499) Add a shared Game Services runtime factory that disables production clients without an authoritative backend URL and permits process-local backends only through explicit non-production opt-in. — Thanks @imjlk!

### Fixed

- [bfbcfaa](https://github.com/imjlk/mpgd-kit/commit/bfbcfaafd1f929962ca951e1e87cd5107212613a) Reject malformed app-icon options, clear stale Android monochrome resources during staging, and complete synthesized Microsoft Store PWA manifests. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.1, adapter-browser@0.4.1, adapter-capacitor@0.4.1, adapter-devvit@0.5.0, analytics@0.3.4, catalog@0.3.4, game-services@0.5.0, i18n@0.5.0, platform@0.5.0, target-config@0.6.0

## 0.6.0 — 2026-07-11

### Fixed

- [68c3d28](https://github.com/imjlk/mpgd-kit/commit/68c3d28b14508e32ddfd0fd3c5f3ed8147d4b40f) Resolve game-owned product catalogs, ad placements, package versions, and source revisions from the target config location so direct CLI builds match workspace wrapper builds. — Thanks @imjlk!

### Added

- [e15576b](https://github.com/imjlk/mpgd-kit/commit/e15576b36b2f2e01ae5a02b5bbbd2f9a5e180d71) Teach generated Phaser starters to resolve identity sessions and launch intents with legacy-host fallbacks and include readiness-accurate Devvit bridge responses. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.0, adapter-browser@0.4.0, adapter-capacitor@0.4.0, adapter-devvit@0.4.0, analytics@0.3.3, bridge@0.5.0, catalog@0.3.3, game-services@0.4.0, i18n@0.4.1, platform@0.4.0, target-config@0.5.0

## 0.5.0 — 2026-07-10

### Changed

- [dd4378f](https://github.com/imjlk/mpgd-kit/commit/dd4378f3fec3b66114a0ce661741f16736614206) Validate generated Phaser game orientation guidance and include the orientation-policy block in generated agent metadata. — Thanks @imjlk!

### Added

- [53f4e59](https://github.com/imjlk/mpgd-kit/commit/53f4e59ab9f2f82545981f4c19df6ff582378e86) Add viewport orientation policy planning and starter guidance. — Thanks @imjlk!

### Patch changes

- Updated dependencies: i18n@0.4.0, target-config@0.4.0

## 0.4.1 — 2026-07-09

### Added

- [fcb9501](https://github.com/imjlk/mpgd-kit/commit/fcb950101e70315d7c96e60f717b197082e416c2) Add target viewport breakpoint helpers and generated Phaser starter guidance for compact, medium, expanded, portrait, landscape, and Devvit embedded-webview layouts. The Phaser starter now measures the game container first and uses target viewport recommendations for control/panel placement. — Thanks @imjlk!

### Patch changes

- Updated dependencies: i18n@0.3.3, target-config@0.3.4

## 0.4.0 — 2026-07-08

### Fixed

- [33f2598](https://github.com/imjlk/mpgd-kit/commit/33f259881be5932e3f155dfc17c3b75f6f78da09) Copy iOS sync target artifacts into the game release-output directory before writing the release manifest, including local Swift package dependencies inside the advertised artifact root. — Thanks @imjlk!
- [d7d241b](https://github.com/imjlk/mpgd-kit/commit/d7d241bab37570c244cd2adfd08fe1735f7347c4) Render generated Phaser starter package manifests with per-package `@mpgd/*`
  versions so release automation can publish packages independently. — Thanks @imjlk!
- [33f2598](https://github.com/imjlk/mpgd-kit/commit/33f259881be5932e3f155dfc17c3b75f6f78da09) Keep AIT wrapper smoke artifacts game-owned, copy wrapper build output for skip-package smoke, and add target doctor ownership validation. — Thanks @imjlk!
- [acfa5f0](https://github.com/imjlk/mpgd-kit/commit/acfa5f0ea81fd179b9206c7baf500d0897cb025a) Preserve generated Devvit target bridge raw request body headers and align leaderboard lock expiration with the millisecond TTL. — Thanks @imjlk!

### Added

- [3069720](https://github.com/imjlk/mpgd-kit/commit/30697204ac97a7afe7bfce52982b31dd72c9f0a9) Add Apps in Toss starter scripts and docs for target-aware local development,
  AIT target build/smoke shortcuts, and the kit reference wrapper's community
  devtools flow. — Thanks @imjlk!
- [e8bdb67](https://github.com/imjlk/mpgd-kit/commit/e8bdb67ee6d086d890f00c453117595a0f6f6327) Add the Apps in Toss community Web API polyfill to generated Phaser starters
  and document the permission-aware AIT standard Web API flow. — Thanks @imjlk!
- [bb96043](https://github.com/imjlk/mpgd-kit/commit/bb96043a56aa7777a3d15028f7e3c68976504637) Add a Microsoft Store PWA target that reuses the browser adapter, ships effective target config and web app manifest metadata, and is available from generated Phaser game target builds while keeping matrix defaults compatible with older target files. — Thanks @imjlk!
- [11e5573](https://github.com/imjlk/mpgd-kit/commit/11e5573be744d61348cb0e502fc60e26bf34eec8) Add a Cloudflare Pages advanced-mode host helper for bridge JSON, bridge oRPC,
  optional game-services service binding proxy, and static asset fallback, plus
  generated Phaser game legal/support/terms HTML sources with `mpgd legal
  build/check` and a TypeScript Pages host that bundles to `_worker.js`. — Thanks @imjlk!
- [b5f9345](https://github.com/imjlk/mpgd-kit/commit/b5f93450062a4e347eb62e59700e5a2d2013ee03) Add Apps in Toss community console CLI scripts and docs to generated Phaser
  starters for project-local console login, app initialization, registration,
  status, package builds, and deploy automation. — Thanks @imjlk!

### Changed

- [33f2598](https://github.com/imjlk/mpgd-kit/commit/33f259881be5932e3f155dfc17c3b75f6f78da09) Generate Phaser starters with the public phaser-assets manifest loader, Vite-emitted starter assets, workspace-root install guidance, and a pnpm workspace root directory entry. — Thanks @imjlk!
- [f3bf2dd](https://github.com/imjlk/mpgd-kit/commit/f3bf2ddd7dc9e1a874e55a80fe3182308fd018c0) Add optional target release metadata plumbing so Apps in Toss builds can pass
  game-specific app names into Granite config, AIT artifact names, and release
  manifest entries. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.3.3, adapter-capacitor@0.3.3, adapter-devvit@0.3.3, bridge@0.4.0, game-services@0.3.3, phaser-assets@0.4.0, target-config@0.3.3

## 0.3.2 — 2026-07-06

### Changed

- [80d35a2](https://github.com/imjlk/mpgd-kit/commit/80d35a2749094424c2d131c0ff1ba9fdae535714) Split generated Devvit init commands into browser-auth default and copy-paste fallback. — Thanks @imjlk!

## 0.3.1 — 2026-07-06

### Fixed

- [fd54514](https://github.com/imjlk/mpgd-kit/commit/fd545149b93c0aabfaed609b00ee433c7b951602) Sort generated Phaser starter catalog imports so `ttsc` checks pass immediately after game creation. — Thanks @imjlk!

## 0.3.0 — 2026-07-06

### Changed

- [12fb9df](https://github.com/imjlk/mpgd-kit/commit/12fb9dfe5b50a29f216538133f82e132651fcf07) Generate game-owned Devvit app roots in Phaser starters and derive starter
  `@mpgd/*` dependency pins from the released CLI package version. — Thanks @imjlk!

## 0.2.0 — 2026-07-06

### Added

- [0766fba](https://github.com/imjlk/mpgd-kit/commit/0766fbaa92381bc127ea7a8605ee1440884a79d9) Add a public Gunshi CLI for Phaser starter generation and target build/smoke orchestration, plus a create-package wrapper for `npm create @mpgd/game` style project bootstrapping. — Thanks @imjlk!

