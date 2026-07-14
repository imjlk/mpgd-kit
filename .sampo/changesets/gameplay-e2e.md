---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: patch (Added)
---

Add a manifest-driven target gameplay E2E contract with strict plan parsing,
normalized input actions, fail-safe pause and resume handling, session
continuity checks, per-state screenshots, and hashed plan, artifact, and release
evidence. Game-owned automation drivers remain optional and outside Phaser
scenes; when a `gameplay:e2e` script is configured, `mpgd game accept` now runs
it after target smoke and requires a passing standard report for handoff.
