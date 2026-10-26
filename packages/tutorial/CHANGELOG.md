# @mpgd/tutorial

## 0.1.26 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/platform@0.29.0

## 0.1.25 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/platform@0.28.0

## 0.1.24 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/platform@0.27.2

## 0.1.23 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/platform@0.27.1

## 0.1.22 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/platform@0.27.0

## 0.1.21 — 2026-10-20

### Patch changes

- Updated dependencies: @mpgd/platform@0.26.0

## 0.1.20 — 2026-10-19

### Patch changes

- Updated dependencies: platform@0.25.0

## 0.1.19 — 2026-10-19

### Patch changes

- Updated dependencies: platform@0.24.0

## 0.1.18 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.23.1

## 0.1.17 — 2026-10-15

### Patch changes

- Updated dependencies: platform@0.23.0

## 0.1.16 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.22.0

## 0.1.15 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.21.0

## 0.1.14 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.20.0

## 0.1.13 — 2026-10-11

### Patch changes

- Updated dependencies: platform@0.19.0

## 0.1.12 — 2026-10-11

### Patch changes

- Updated dependencies: platform@0.18.0

## 0.1.11 — 2026-10-09

### Patch changes

- Updated dependencies: platform@0.17.0

## 0.1.10 — 2026-10-09

### Patch changes

- Updated dependencies: platform@0.16.0

## 0.1.9 — 2026-10-09

### Patch changes

- Updated dependencies: platform@0.15.0

## 0.1.8 — 2026-09-28

### Patch changes

- Updated dependencies: platform@0.14.0

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
