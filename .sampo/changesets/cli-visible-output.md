---
npm/@mpgd/cli: patch (Fixed)
---

Preserve user-facing command summaries, instructions and diagnostic output in compiled CLI builds. Route those messages through the informational console level so debug stripping does not silently remove them, and verify compiled/source kit-doctor output.
