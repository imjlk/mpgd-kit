# @mpgd/game-runtime

## 0.2.0 — 2026-09-14

### Minor changes

- [3b7e5d2](https://github.com/imjlk/mpgd-kit/commit/3b7e5d25aa2cbdde2d47c7ad61f5fa8c11cafc59) Add an optional authoritative ledger recovery port to action coordination. Match the fixed player, operation, product or placement and idempotency key before unlocking new actions; retain original promises and key history to prevent re-execution. — Thanks @imjlk!

### Patch changes

- [1ba8210](https://github.com/imjlk/mpgd-kit/commit/1ba8210171907b15d1fce170326c8d5d10994679) Distribute gameplay execution, scoped UI, lifecycle and action coordination in
  one package, with an optional `@mpgd/game-runtime/phaser` scene binding. Register
  the package for automated releases after its initial 0.1.0 npm publication. — Thanks @imjlk!

