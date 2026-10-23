---
npm/@mpgd/cli: patch (Changed)
npm/@mpgd/create-game: patch (Changed)
---

The generated game's notifications guide ("Try it locally") binds the local game-services Worker to `127.0.0.1` and points at mpgd-kit's live test runbook (`docs/NOTIFICATIONS_LIVE_TEST.md`) for real pushes, instead of suggesting the service-account key go into `.dev.vars` in the checkout.
