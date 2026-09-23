# @mpgd/runtime-diagnostics

## 0.1.2 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

## 0.1.1 — 2026-09-13

### Patch changes

- [8891548](https://github.com/imjlk/mpgd-kit/commit/8891548e84fbcbe6e8e5671c817adddf6fb257a0) Shallow-copy each script attribution when cloning the last long animation
  frame sample for a snapshot. The scripts array was already copied, but its
  entries were shared with the recorder's internal history, so a consumer
  mutating `snapshot.lastLongAnimationFrame.scripts[i]` could corrupt future
  diagnoses. Script attributions are a package-defined structure bounded to
  eight entries, so per-entry copies keep snapshot isolation predictable
  without deep-cloning consumer context. — Thanks @imjlk!

