# @mpgd/game-runtime

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

