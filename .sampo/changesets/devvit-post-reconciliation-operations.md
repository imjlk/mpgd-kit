---
npm/@mpgd/adapter-devvit: minor (Added)
npm/@mpgd/cli: patch (Added)
npm/@mpgd/create-game: patch (Added)
---

Add atomically indexed durable Devvit post operations and scope-bound cursor
pagination for bounded recovery workers. Pending discovery remains read-only and
keeps attempted and terminal outcomes fail-closed instead of restoring submit
permission.
