# Generated Lite Game Agent Instructions

This is a Canvas2D game generated with the mpgd lite template.

## Start here

- Read `agent/game-manifest.json`, `agent/brief.md`, and `agent/acceptance.md`.
- Use `.agents/skills/use-mpgd-kit/SKILL.md` for platform, target, acceptance, and release work.
- Read `docs/MPGD_KIT_WORKFLOWS.md` for capability ownership.

## Boundaries

- Keep deterministic rules in `src/game`; rendering and input belong in `src/lite`.
- Use `@mpgd/lite-shell` and Canvas2D. Keep the lite template free of Phaser.
- Put platform SDK imports in adapters or target wrappers; use `PlatformGateway` from game code.
- Keep pure game packages free of DOM, network calls, and SDK imports.
- Purchases and rewarded-ad callbacks are evidence; backend ledger grants precede durable state changes.
- Create one game runtime above renderer lifetimes. Renderer disposal must not release another owner's native presentation or audio.
- Keep safe-area geometry reserved once and preserve native scrolling in Devvit inline mode.
- Do not commit secrets, signing keys, personal MCP configuration, or platform authentication state.

## Tooling and checks

- Use `ttsx`, `ttsc`, and `@ttsc/lint`; do not add `tsx`, ESLint, or Prettier.
- Run focused checks, then `pnpm check` and `pnpm build`.
- Run `pnpm accept` for a target handoff; preserve its generated evidence.
- Keep the manifest, brief, and acceptance guidance aligned with material changes.
