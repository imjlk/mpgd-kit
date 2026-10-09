# @mpgd/game-runtime

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

