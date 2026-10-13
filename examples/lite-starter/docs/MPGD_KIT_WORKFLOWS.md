# mpgd-kit Lite Workflows

Start with `agent/game-manifest.json`; enabled targets are build paths and future targets are design directions.

| Concern | Owner |
| --- | --- |
| Deterministic rules and state | `src/game` |
| Canvas2D rendering and input | `src/lite` through `@mpgd/lite-shell` |
| Renderer mounting and teardown | `src/runtime/createGame.ts` |
| Platform services | `src/platform` through `PlatformGateway` |
| Target build configuration | `mpgd.targets.json` and `@mpgd/target-config` |
| Runtime, recovery, and audio ownership | bootstrap and `@mpgd/game-runtime` |
| Acceptance | `agent/acceptance.md` and `pnpm accept` |

Use the generated icon and localization commands. Load browser images and fonts directly or through lite-shell font helpers; this template has no Phaser asset manifest.
Keep deterministic state independent of Canvas2D, DOM, network, and SDKs.
Reserve safe-area geometry once through CSS or viewport content bounds.
Never call SDKs from renderer code or grant purchases/rewards from client callbacks.

## Platform integration

Choose the owning adapter in `src/platform/buildGateways`. Configure target features and service availability rather than bypassing them in game code.
Keep commerce verification and grants in the backend ledger; use authenticated sessions and durable encrypted recovery journals.
Construct one game runtime above renderer lifetimes, preserve native presentation ownership, and reconcile existing operations without reopening checkout.
Use generated target build/smoke and effective-config checks before changing a release contract.

## Devvit

`apps/target-devvit` owns Reddit SDK and deployment files. The lite inline entry is playable and the expanded entry uses the same Canvas2D game.
Preserve native feed gestures. Keep optional heavy engines behind declared dynamic imports; static imports, HTML preloads, and CSS imports count toward first-load budget.
Use configured Devvit documentation/MCP for SDK or publish-flow changes and run real playtest for platform acceptance.

## Target handoff

Run focused checks, `pnpm check`, `pnpm build`, and `pnpm accept`. Preserve generated evidence.
Use official target tooling and configured skills for native signing, Apps in Toss, ONE play, and Verse8 acceptance.
Keep credentials, signing material, and personal MCP configuration out of source control.
