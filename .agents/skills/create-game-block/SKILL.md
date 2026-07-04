---
name: create-game-block
description: Create a reusable Phaser game block with capability naming, manifest metadata, tests, and gotchas. Use when adding mechanics like projectiles, pickups, enemies, movement, hazards, or scoring blocks.
---

# Create Game Block

Use this skill when adding a reusable gameplay block to mpgd-kit or a game repo based on it.

1. Choose a capability-based id.
   - Good: `projectile.pool.burst`
   - Good: `actor.avatar.flight`
   - Good: `pickup.magnet.radius`
   - Good: `scoring.combo.meter`
   - Bad: brand, genre clone, or copyrighted reference names

2. Start in the private starter or game repo first.
   - Use `examples/phaser-starter/agent/game.manifest.json` for starter examples.
   - Promote to a public package only when the block has stable API, tests, docs, and a Sampo changeset.

3. Keep simulation separate from rendering.
   - Serializable state and rules live outside Phaser scenes.
   - Scenes only adapt state into sprites, camera, tweens, and input plumbing.

4. Add manifest metadata.
   - id, kind, capabilities, entry, config, tests, and gotchas
   - acceptance command or manual playtest note

5. Document gotchas.
   - pooling reset
   - collision timing
   - input assumptions
   - scene lifecycle assumptions
   - asset requirements
   - per-frame allocation risks

6. Do not import platform SDKs.

7. Run the smallest relevant checks.
   - `pnpm validate:starter-workflow`
   - `pnpm --dir examples/phaser-starter check`
   - `pnpm --dir examples/phaser-starter build`
