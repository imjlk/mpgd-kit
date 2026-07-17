# @mpgd/create-game

## 0.13.0 — 2026-07-17

### Patch changes

- Updated dependencies: cli@0.13.0

## 0.12.0 — 2026-07-17

### Patch changes

- Updated dependencies: cli@0.12.0

## 0.11.0 — 2026-07-15

### Patch changes

- Updated dependencies: cli@0.11.0

## 0.10.1 — 2026-07-15

### Patch changes

- Updated dependencies: cli@0.10.1

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

- Updated dependencies: cli@0.10.0

## 0.9.0 — 2026-07-14

### Removed

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Upgrade generated Devvit targets to the stable 0.13.8 toolchain and remove the
  deprecated JSON fetch bridge API, JSON route, pre-namespace storage fallback,
  and split build strategy so Devvit targets use oRPC and the official Vite plugin
  exclusively. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.9.0

## 0.8.0 — 2026-07-14

### Added

- [2f06373](https://github.com/imjlk/mpgd-kit/commit/2f063737d518a19d93de0781bf44582c0a0bc78b) Add an opt-in official Devvit Vite build strategy for generated Phaser games,
  upgrade Devvit packages to 0.13.7, expose a direct oRPC Node HTTP bridge
  adapter, and remove the generated target's Express-based request conversion. — Thanks @imjlk!

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.8.0

## 0.7.0 — 2026-07-13

### Patch changes

- Updated dependencies: cli@0.7.0

## 0.6.0 — 2026-07-11

### Patch changes

- Updated dependencies: cli@0.6.0

## 0.5.0 — 2026-07-10

### Patch changes

- Updated dependencies: cli@0.5.0

## 0.4.1 — 2026-07-09

### Patch changes

- Updated dependencies: cli@0.4.1

## 0.4.0 — 2026-07-08

### Patch changes

- Updated dependencies: cli@0.4.0

## 0.3.2 — 2026-07-06

### Patch changes

- Updated dependencies: cli@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Updated dependencies: cli@0.3.1

## 0.3.0 — 2026-07-06

### Changed

- [12fb9df](https://github.com/imjlk/mpgd-kit/commit/12fb9dfe5b50a29f216538133f82e132651fcf07) Generate game-owned Devvit app roots in Phaser starters and derive starter
  `@mpgd/*` dependency pins from the released CLI package version. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.3.0

## 0.2.0 — 2026-07-06

### Added

- [0766fba](https://github.com/imjlk/mpgd-kit/commit/0766fbaa92381bc127ea7a8605ee1440884a79d9) Add a public Gunshi CLI for Phaser starter generation and target build/smoke orchestration, plus a create-package wrapper for `npm create @mpgd/game` style project bootstrapping. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.2.0

