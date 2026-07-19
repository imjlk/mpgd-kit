# Generated Game Agent Instructions

This repository is a standalone Phaser game generated with `@mpgd/create-game`.

## Start here

- Read `agent/game-manifest.json` for enabled targets, capability ownership, and
  target-specific skills.
- Use `.agents/skills/use-mpgd-kit/SKILL.md` for game, platform, target, build,
  acceptance, or release work.
- Read `docs/MPGD_KIT_WORKFLOWS.md` only for the relevant capability or target.
- Keep `agent/brief.md` and `agent/acceptance.md` aligned with material changes.

## Boundaries

- Keep deterministic game state outside Phaser scenes.
- Keep platform SDK imports in adapters or target wrappers.
- Use `PlatformGateway` from game-facing code; do not call platform SDKs from
  scenes.
- Keep pure game packages free of Phaser, DOM, network, and platform SDKs.
- Send purchases, rewarded-ad grants, and verified scores through backend
  ledger or verifier APIs before changing durable state.
- Do not put side effects inside debug calls that a production strip pass may
  remove.
- Do not commit secrets, signing keys, personal MCP configuration, or platform
  authentication state.

## Tooling and checks

- Use `ttsx`, not `tsx`, for TypeScript scripts.
- Use `ttsc` and `@ttsc/lint`; do not add ESLint or Prettier for TypeScript.
- Run focused checks, then `pnpm check` and `pnpm build`.
- Run `pnpm accept` before a target handoff or release. Keep its evidence and
  any target-specific release evidence with the handoff.
