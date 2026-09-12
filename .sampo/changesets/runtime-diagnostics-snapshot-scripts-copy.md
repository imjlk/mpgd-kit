---
npm/@mpgd/runtime-diagnostics: patch
---

Shallow-copy each script attribution when cloning the last long animation
frame sample for a snapshot. The scripts array was already copied, but its
entries were shared with the recorder's internal history, so a consumer
mutating `snapshot.lastLongAnimationFrame.scripts[i]` could corrupt future
diagnoses. Script attributions are a package-defined structure bounded to
eight entries, so per-entry copies keep snapshot isolation predictable
without deep-cloning consumer context.
