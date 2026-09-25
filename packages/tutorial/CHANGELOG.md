# @mpgd/tutorial

## 0.1.7 — 2026-09-25

### Patch changes

- Updated dependencies: platform@0.13.0

## 0.1.6 — 2026-09-24

### Patch changes

- Updated dependencies: platform@0.12.2

## 0.1.5 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.12.1

## 0.1.4 — 2026-09-02

### Patch changes

- Updated dependencies: platform@0.12.0

## 0.1.3 — 2026-08-29

### Patch changes

- Updated dependencies: platform@0.11.0

## 0.1.2 — 2026-08-26

### Patch changes

- Updated dependencies: platform@0.10.0

## 0.1.1 — 2026-08-13

### Fixed

- [19657e4](https://github.com/imjlk/mpgd-kit/commit/19657e4c6d177e0a4640d4b8d063e58b1938baba) Fix scoped tutorial target rebinding across outer layout and visual viewport changes, keep focus inside blocked action and signal guidance, and contain host callback and storage failures across replay, persistence, and teardown. — Thanks @imjlk!

## 0.1.0 — 2026-08-12

### Added

- Add a reusable, DOM-free tutorial director with typed acknowledge, action,
  signal, scene-gating, replay, skip, suspension, and durable progress flows.
- Add queued platform storage, an optional Driver.js presenter with responsive
  target rebinding and accessible modal ownership, and opt-in local debug and
  reproduction helpers.
