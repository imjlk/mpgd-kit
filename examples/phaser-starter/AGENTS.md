# Phaser Starter Agent Instructions

This starter is the minimal private template for new mpgd Phaser games.

## Boundaries

- Keep simulation state in `src/game/simulation`.
- Keep Phaser scene glue in `src/scenes`.
- Keep platform wiring in `src/platform`.
- Keep agent-facing brief, manifest, and acceptance notes in `agent/`.

## Rules

- Do not copy the full demo game's score, coin, purchase, or result loop into this starter.
- Do not import platform SDKs from scenes or simulation modules.
- Use `PlatformGateway` for identity, storage, commerce, ads, leaderboard, lifecycle, and capabilities.
- Use `@mpgd/game-services` for authoritative purchase, ad reward, and leaderboard flows.
- Update `agent/game.manifest.json` when adding starter capabilities.

## Checks

- `pnpm validate:starter-workflow`
- `pnpm --dir examples/phaser-starter check`
- `pnpm --dir examples/phaser-starter build`
