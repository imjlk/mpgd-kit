# @mpgd/cli

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

