# @mpgd/runtime-diagnostics

## 0.1.1 — 2026-09-13

### Patch changes

- [8891548](https://github.com/imjlk/mpgd-kit/commit/8891548e84fbcbe6e8e5671c817adddf6fb257a0) Shallow-copy each script attribution when cloning the last long animation
  frame sample for a snapshot. The scripts array was already copied, but its
  entries were shared with the recorder's internal history, so a consumer
  mutating `snapshot.lastLongAnimationFrame.scripts[i]` could corrupt future
  diagnoses. Script attributions are a package-defined structure bounded to
  eight entries, so per-entry copies keep snapshot isolation predictable
  without deep-cloning consumer context. — Thanks @imjlk!

