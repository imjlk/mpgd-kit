# @mpgd/tutorial

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
