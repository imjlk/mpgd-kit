---
npm/@mpgd/cli: patch (Fixed)
---

Preserve user-facing command summaries, instructions and diagnostic output in compiled CLI builds. Route those messages through the informational console level so debug stripping does not silently remove them, and verify compiled/source kit-doctor output.

Make repeated offline-playtest packages byte-stable by minifying identifiers after random deferred asset markers are resolved. Keep collision-resistant markers, asset validation, tree shaking and network restrictions intact.

Restore offline inlining for assets assigned to native elements created with document.createElement, accounting for the code mask retaining a string literal opening quote while preserving native-receiver and static-argument checks.

Remove only evidence files or symbolic links when cleaning failed Microsoft Store acceptance output. This avoids leaving stale reports when a directory link causes non-recursive rmSync to fail, while preserving the linked target.
