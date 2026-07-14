---
npm/@mpgd/adapter-devvit: minor (Added)
npm/@mpgd/cli: patch (Added)
npm/@mpgd/create-game: patch (Added)
---

Add conservatively indexed durable Devvit post operations and scope-bound cursor
pagination for bounded recovery workers. Stable registry membership is created
before durable state and retained across every transition, preventing live work
from disappearing through partial cross-key updates. Discovery remains read-only
and keeps attempted and terminal outcomes fail-closed instead of restoring submit
permission. Exact operation reads and transitions lazily backfill stable registry
membership for durable records created before indexed discovery was enabled.
