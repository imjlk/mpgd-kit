---
name: use-mpgd-kit
description: Route Phaser game development, platform integration, target builds, icons, localization, analytics, game services, acceptance, and release work through this generated game's mpgd-kit contracts. Use for any change that adds gameplay-facing platform behavior, configures a distribution target, prepares release evidence, or needs to discover which mpgd capability and validation flow applies.
---

# Use mpgd-kit

Read `AGENTS.md`, `agent/game-manifest.json`, and
`docs/MPGD_KIT_WORKFLOWS.md` before editing. Treat the manifest as the list of
enabled targets and the workflow guide as the routing reference.

## Route the request

- Put deterministic state and rules in game/simulation modules.
- Keep Phaser scenes limited to rendering and input glue.
- Route identity, storage, commerce, ads, leaderboard, lifecycle, and host
  presentation through `PlatformGateway`.
- Keep SDK imports in adapters or target wrappers.
- Route purchases, rewarded-ad grants, and verified scores through a backend
  ledger or verifier before mutating durable state.
- Use `@mpgd/target-config` for target-owned runtime configuration and
  `mpgd.targets.json` for build ownership.
- Use the generated icon, localization, analytics, acceptance, and evidence
  flows instead of creating target-specific copies.
- For a configured target with a target skill in `agent/game-manifest.json`,
  read that skill before changing its release flow.

## Work in order

1. Identify the owning capability and files from the manifest and workflow
   guide.
2. Inspect the target entry and effective configuration; do not assume a target
   is enabled.
3. Implement the smallest change that preserves `PlatformGateway` and backend
   authority boundaries.
4. Update `agent/game-manifest.json`, `agent/brief.md`, and acceptance guidance
   when the game's capabilities or handoff contract changes.
5. Run the focused check first, then `pnpm check`, `pnpm build`, and
   `pnpm accept` when the change affects a handoff or target release.
6. Preserve generated JSON/Markdown evidence under `artifacts/acceptance` or
   the target's `release-output` directory.

Use official target documentation or the target's configured MCP for SDK and
submission requirements. Do not commit personal MCP configuration, tokens,
credentials, signing material, or platform login state.
