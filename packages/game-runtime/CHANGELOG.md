# @mpgd/game-runtime

## 0.8.3 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/game-services@0.29.0, @mpgd/platform@0.29.0

## 0.8.2 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/game-services@0.28.1, @mpgd/platform@0.28.0

## 0.8.1 — 2026-10-24

### Patch changes

- Updated dependencies: game-services@0.28.0

## 0.8.0 — 2026-10-21

### Minor changes

- [3f519a74](https://github.com/imjlk/mpgd-kit/commit/3f519a74a3eaf7aeec7a35d208ed951ff61ff8df) Add a headless checkout-only coordinator that shares native presentation exclusion without requiring an ad provider. Missing native UI facts block new purchases while recovery and finalization remain available. A trusted not-started fact, including one that arrives after a retryable failure or an explicitly retryable rejection settles, may retry that same unchanged key. A restarting provider echoes the attempt generation so a delayed event from the previous attempt cannot close the next sheet. Purchased, launched, opened, and non-retryable results stay closed, and no client fact grants. Reuse the coordinator in the existing gateway without changing its legacy pass-through behavior. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/game-services@0.27.2, @mpgd/platform@0.27.2

## 0.7.6 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/game-services@0.27.1, @mpgd/platform@0.27.1

## 0.7.5 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/game-services@0.27.0, @mpgd/platform@0.27.0

## 0.7.4 — 2026-10-20

### Patch changes

- Updated dependencies: @mpgd/game-services@0.26.0, @mpgd/platform@0.26.0

## 0.7.3 — 2026-10-19

### Patch changes

- Updated dependencies: game-services@0.25.1, platform@0.25.0

## 0.7.2 — 2026-10-19

### Patch changes

- Updated dependencies: game-services@0.25.0, platform@0.24.0

## 0.7.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.24.1, platform@0.23.1

## 0.7.0 — 2026-10-15

### Minor changes

- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: commerce v2, PR C4. `createCoordinatedPlatformGateway` coordinates the
  commerce provider's `requestPurchase` instead of the removed v1 `purchase`, and
  holds a purchase lease only when a trusted release source exists.
  
  - The wrapper intercepts `gateway.commerce.requestPurchase` and keeps its
    duplicate-key, busy, and key-history guards. Its fingerprint is now the
    `logicalId`, `source`, `offerId`, and `quantity` of the request; the input
    carries `logicalId` where v1 carried `productId`.
  - `classifyPurchasePresentation` receives the provider's `RequestPurchaseResult`
    (`launched`, `purchased`, `cancelled`, or `failed`) instead of a platform
    `PurchaseResult`.
  - A lease is held only when a trusted source can release it: the provider's own
    `presentation` facts (`CommerceProvider.presentation`), the
    `purchasePresentation` option, or a `classifyPurchasePresentation` function.
    With none of them `gateway.commerce` is forwarded unchanged and acquires no
    lease, because a purchase result alone left presentation `unknown` for the
    rest of the session and blocked every ad. A gateway without a commerce
    provider stays without one (`gateway.commerce` is optional). — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.24.0, platform@0.23.0

## 0.6.6 — 2026-10-12

### Patch changes

- Updated dependencies: game-services@0.23.0

## 0.6.5 — 2026-10-12

### Patch changes

- Updated dependencies: game-services@0.22.0, platform@0.22.0

## 0.6.4 — 2026-10-12

### Patch changes

- Updated dependencies: game-services@0.21.1, platform@0.21.0

## 0.6.3 — 2026-10-12

### Patch changes

- Updated dependencies: game-services@0.21.0, platform@0.20.0

## 0.6.2 — 2026-10-11

### Patch changes

- Updated dependencies: game-services@0.20.0, platform@0.19.0

## 0.6.1 — 2026-10-11

### Patch changes

- Updated dependencies: game-services@0.19.1, platform@0.18.0

## 0.6.0 — 2026-10-10

### Minor changes

- [54b14b31](https://github.com/imjlk/mpgd-kit/commit/54b14b31163f3d0326c9e7825b8fa7877109fd12) Add opt-in DOM banner bindings with scene ownership, unique mount identities,
  confirmed-layout reservation, page-restore renewal, and asynchronous cleanup. — Thanks @imjlk!
- [44b26173](https://github.com/imjlk/mpgd-kit/commit/44b261732b8c516c7c28f8b8edd17763144db386) Add bounded, deterministic impact feedback recipes and an opt-in Phaser pool
  with preallocated rings, batched sparks, raster frame strips and scene cleanup. — Thanks @imjlk!

## 0.5.0 — 2026-10-09

### Added

- [537c6168](https://github.com/imjlk/mpgd-kit/commit/537c6168a902332e6c62ab0585d2cdfac946e51a) Add the ONE play H5 Web SDK target and browser adapter subpath, asynchronous host loading acknowledgements, synchronous exit checkpoints, platform asserted identity, audio/safe-area integration, and interstitial presentation handling that keeps uncertain native outcomes quarantined. Include target build, hosting headers, generated starter wiring and explicit server authority gates for subsequent monetization integrations. — Thanks @imjlk!
- [a483af3f](https://github.com/imjlk/mpgd-kit/commit/a483af3fb7f789a9edc71cc513e7c122d0b1e4b6) Add ONE play managed purchases with authenticated checkout intents, independent API V7 verification, ledger-before-consume or acknowledge finalization, signed PNS recovery and authoritative cancellation hooks. Map partial product detail batches and expose trusted native checkout presentation facts through the shared commerce contract and runtime. Keep subscriptions unsupported and server integrations required. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.19.0, platform@0.17.0

## 0.4.0 — 2026-10-09

### Minor changes

- [2d35eb0e](https://github.com/imjlk/mpgd-kit/commit/2d35eb0ecd89eef1058e4b9983eb284f7ba38adc) Add a CrazyGames web target and the browser adapter's `/crazygames` entry point with official v3 SDK initialization, loading/gameplay reporting, and interstitial ads using the shared presentation contract. Basic Launch keeps monetization disabled; Full Launch enables configured interstitial placements. Rewarded ads and purchases remain unavailable pending independent backend verification. Generated starters enter free play directly and retain scene, lifecycle, and native presentation ownership through game-owned gameplay scopes. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.18.1, platform@0.16.0

## 0.3.0 — 2026-10-09

### Added

- [b453182e](https://github.com/imjlk/mpgd-kit/commit/b453182e07aafc5e6db636422faa1bc29e3a97b7) Add a game-owned platform runtime and audio projection shared above scene lifetimes. Wire generated Phaser games to coordinated native presentation, registered late evidence recovery, application-owned journals and reconciliation, and scene-scoped action views. Preserve physical ownership after deadlines and prevent scene teardown from unmuting live ads. — Thanks @imjlk!
- [da9fe97b](https://github.com/imjlk/mpgd-kit/commit/da9fe97b32d888a1f42acbd58aa48dbf35d07d35) Coordinate full-screen purchase and advertising ownership, independent execution blocks, caller deadlines, duplicate invocations, and late claim evidence. Keep native closure separate from backend settlement, and carry proof-lookup correlation without asserting reward eligibility. — Thanks @imjlk!
- [0e5008a0](https://github.com/imjlk/mpgd-kit/commit/0e5008a08fe89638e832182af701310bf4af3406) Attach late registered advertising correlation to a reserved pending journal operation and retry the original claim without reopening native UI. Preserve recorded evidence, request identity, and timestamps, and provide an application-owned observer that uses the original idempotency key without asserting SDK eligibility or a ledger grant. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.18.0, platform@0.15.0

## 0.2.6 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.2

## 0.2.5 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.1

## 0.2.4 — 2026-09-28

### Patch changes

- Updated dependencies: game-services@0.17.0

## 0.2.3 — 2026-09-25

### Patch changes

- Updated dependencies: game-services@0.16.0

## 0.2.2 — 2026-09-24

### Patch changes

- Updated dependencies: game-services@0.15.3

## 0.2.1 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.15.2

## 0.2.0 — 2026-09-14

### Minor changes

- [3b7e5d2](https://github.com/imjlk/mpgd-kit/commit/3b7e5d25aa2cbdde2d47c7ad61f5fa8c11cafc59) Add an optional authoritative ledger recovery port to action coordination. Match the fixed player, operation, product or placement and idempotency key before unlocking new actions; retain original promises and key history to prevent re-execution. — Thanks @imjlk!

### Patch changes

- [1ba8210](https://github.com/imjlk/mpgd-kit/commit/1ba8210171907b15d1fce170326c8d5d10994679) Distribute gameplay execution, scoped UI, lifecycle and action coordination in
  one package, with an optional `@mpgd/game-runtime/phaser` scene binding. Register
  the package for automated releases after its initial 0.1.0 npm publication. — Thanks @imjlk!

