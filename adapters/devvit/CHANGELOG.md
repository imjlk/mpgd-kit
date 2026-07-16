# @mpgd/adapter-devvit

## 0.8.3 — 2026-07-17

### Fixed

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!
- [e3fb909](https://github.com/imjlk/mpgd-kit/commit/e3fb90993fa5b33fdbd293413903d77f52686c08) Add a provider-neutral PlatformGateway capability conformance runner, keep target-configured capability reads live, and isolate bridge-owned capability snapshots before exposing them to callers. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.6.1, game-services@0.9.0, platform@0.7.0

## 0.8.2 — 2026-07-15

### Patch changes

- Updated dependencies: game-services@0.8.2

## 0.8.1 — 2026-07-15

### Fixed

- [ae8ffdb](https://github.com/imjlk/mpgd-kit/commit/ae8ffdb449db4fc05e41bc9d4e2b2af149d4339c) Prevent the Devvit commerce installer from bypassing target-config IAP gating by
  failing closed when invoked after target availability has already been applied. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.8.1

## 0.8.0 — 2026-07-15

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
- [8248bcf](https://github.com/imjlk/mpgd-kit/commit/8248bcfed031669cf70b13996bb8ad2bf9bc0063) Add Devvit payment order normalization, a commerce adapter that keeps checkout
  results separate from authoritative server entitlement reads, and a gateway
  installer that advertises IAP only when that adapter is configured. — Thanks @imjlk!
- [cddcba8](https://github.com/imjlk/mpgd-kit/commit/cddcba899e912b28e18fdca3b1520cbda992ccd7) Add an official-terminology Devvit view mode API with a concurrency-safe,
  retryable inline mode gameplay loader. Generated Phaser starters now keep their
  initial launch screen lightweight, start gameplay inside the post after an
  explicit click, and retain the separate expanded mode game entry. — Thanks @imjlk!

### Fixed

- [e4a89d7](https://github.com/imjlk/mpgd-kit/commit/e4a89d7d7788e7b103a17bbefc5389534c1e7b32) Stop advertising a native Devvit leaderboard and disable the generic client
  score submission path in both the shared target and generated starters. Devvit
  games continue to use the server-only verified leaderboard provider from
  authoritative completion handlers. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.8.0, platform@0.6.0

## 0.7.0 — 2026-07-14

### Changed

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Add bounded immutable numeric metrics to verified attempts and ranked entries,
  preserving them across memory, Devvit Redis, Cloudflare D1, and authenticated
  snapshot transports without changing score-based ranking behavior. — Thanks @imjlk!

### Removed

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Upgrade generated Devvit targets to the stable 0.13.8 toolchain and remove the
  deprecated JSON fetch bridge API, JSON route, pre-namespace storage fallback,
  and split build strategy so Devvit targets use oRPC and the official Vite plugin
  exclusively. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.7.0

## 0.6.0 — 2026-07-14

### Changed

- [2f06373](https://github.com/imjlk/mpgd-kit/commit/2f063737d518a19d93de0781bf44582c0a0bc78b) Add an opt-in official Devvit Vite build strategy for generated Phaser games,
  upgrade Devvit packages to 0.13.7, expose a direct oRPC Node HTTP bridge
  adapter, and remove the generated target's Express-based request conversion. — Thanks @imjlk!
- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Added

- [960a114](https://github.com/imjlk/mpgd-kit/commit/960a114db3a7999e0b0541f46026e5d1a297fb93) Add a durable Redis verified-leaderboard provider for Devvit servers with
  atomic idempotency, deterministic ranking, and opaque cursor pagination. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.6.0, game-services@0.6.0, platform@0.5.1

## 0.5.0 — 2026-07-13

### Added

- [5a4f259](https://github.com/imjlk/mpgd-kit/commit/5a4f259ff196db50f5bd53cbd4e9f91bae9b2bd5) Add a duplicate-safe, ambiguity-safe Devvit custom-post operation coordinator and include its Redis-backed server wrapper in generated starters. — Thanks @imjlk!
- [2f51b58](https://github.com/imjlk/mpgd-kit/commit/2f51b580aa5057d0d18e1820b1ed5b9d50d86d7e) Add reusable Devvit web-surface routing and generate physically separate lightweight inline and expanded Phaser entries. — Thanks @imjlk!

### Changed

- [81b1bab](https://github.com/imjlk/mpgd-kit/commit/81b1bab1be4e9234187cc1db673d9b724f80d728) Distinguish a presented share surface from confirmed share completion and expose a conservative Devvit share-sheet wrapper. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.5.0

## 0.4.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.5.0, platform@0.4.0

## 0.3.3 — 2026-07-08

### Patch changes

- Updated dependencies: bridge@0.4.0

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: bridge@0.3.2, platform@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: bridge@0.3.1, platform@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: bridge@0.3.0, platform@0.3.0

## 0.2.0 — 2026-07-06

### Added

- [02d8cfd](https://github.com/imjlk/mpgd-kit/commit/02d8cfd5e7669e29f7c99754fb98773aa807bc4c) Add Devvit oRPC bridge transport. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.2.0, platform@0.2.0

## 0.1.0 - Unreleased

### Added

- Add the initial Reddit Devvit Web platform adapter.
