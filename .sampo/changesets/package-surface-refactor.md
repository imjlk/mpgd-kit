---
npm/@mpgd/analytics: minor (Added)
npm/@mpgd/bridge: minor (Changed)
npm/@mpgd/catalog: minor (Changed)
npm/@mpgd/game-services: minor (Changed)
npm/@mpgd/platform: minor (Changed)
npm/@mpgd/target-config: patch (Changed)
npm/@mpgd/adapter-ait: patch (Changed)
npm/@mpgd/adapter-browser: patch (Changed)
npm/@mpgd/adapter-capacitor: patch (Changed)
npm/@mpgd/capacitor-game-services: patch (Changed)
---

Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows.
