---
name: evolve-phaser-starter
description: Evolve the private Phaser starter template while preserving mpgd platform, target-config, i18n, and game-services wiring.
---

# Evolve Phaser Starter

Use this skill when changing `examples/phaser-starter`.

1. Keep the starter minimal.
   - It should demonstrate reusable wiring, not copy the full demo game loop.
   - Game-specific content should live in a downstream game repo.

2. Preserve the starter boundaries.
   - `src/game/simulation` owns serializable rules and state.
   - `src/scenes` adapts state to Phaser.
   - `src/platform` owns `PlatformGateway`, target config, and game-services wiring.
   - `agent/` owns agent-facing brief, manifest, and acceptance notes.

3. Keep platform APIs behind `PlatformGateway`.
   - No direct Capacitor, Apps in Toss, StoreKit, Play Billing, Devvit, or ad SDK imports in scenes.

4. Update the agent manifest when changing starter capabilities.
   - `examples/phaser-starter/agent/game.manifest.json`
   - `examples/phaser-starter/agent/brief.template.md`
   - `examples/phaser-starter/agent/acceptance.md`

5. Validate.
   - `pnpm validate:starter-workflow`
   - `pnpm --dir examples/phaser-starter check`
   - `pnpm --dir examples/phaser-starter build`
