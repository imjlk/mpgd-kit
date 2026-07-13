# @mpgd/cli

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

