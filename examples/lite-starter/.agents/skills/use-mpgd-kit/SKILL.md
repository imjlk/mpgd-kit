---
name: use-mpgd-kit
description: Route lite Canvas2D game development, platform integration, target builds, acceptance, and release work through this generated game's mpgd-kit contracts.
---

# Use mpgd-kit

Read `AGENTS.md`, `agent/game-manifest.json`, and `docs/MPGD_KIT_WORKFLOWS.md` before editing.

1. Identify capability ownership and configured targets from the manifest.
2. Keep deterministic rules in `src/game` and Canvas2D rendering/input in `src/lite` through `@mpgd/lite-shell`.
3. Use `PlatformGateway`; keep SDK calls in adapters or target wrappers.
4. Use backend ledger or verifier APIs before mutating durable purchases, rewarded grants, or verified scores.
5. Keep runtime, presentation, recovery, and audio ownership above renderer lifetimes; preserve durable encrypted journals and late observers.
6. Update the manifest, brief, and acceptance guidance when capabilities or handoff contracts change.
7. Run focused checks, then `pnpm check`, `pnpm build`, and `pnpm accept` for target handoffs.
8. Preserve generated JSON/Markdown acceptance and release evidence.

Read a target skill declared in the manifest before changing its release flow.
Use official target documentation or the configured MCP for SDK and submission requirements.
Keep the lite game free of Phaser, preserve native scrolling and history restoration, and verify Devvit inline budget.
Do not commit tokens, credentials, signing material, personal MCP configuration, or platform login state.
