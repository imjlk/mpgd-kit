# Game Development Guide

This repository is ready for real Phaser game iteration when the game stays inside
clear boundaries:

- `apps/game-phaser/src/game/assets` owns stable asset keys and public asset paths.
- `apps/game-phaser/src/game/content` owns authored tuning such as stage duration,
  target bounds, and win/loss thresholds.
- `apps/game-phaser/src/game/input` maps pointer and keyboard input into named
  gameplay actions.
- `packages/game-core` owns deterministic simulation and scoring rules.
- `apps/game-phaser/src/scenes` adapts state into Phaser objects, cameras, tweens,
  and scene transitions.

## Starter vs Demo

Use `examples/phaser-starter` when starting a new game. It is a private example
workspace that shows the reusable mpgd wiring without inheriting the demo game's
score, coin, result, or mock purchase loop.

Use `apps/game-phaser` when validating the kit itself. The demo intentionally
exercises player identity, save/load, target feature availability, localization,
purchase, rewarded ad, leaderboard, and backend ledger paths.

Starter loop:

```sh
pnpm --dir examples/phaser-starter dev
pnpm --dir examples/phaser-starter check
pnpm --dir examples/phaser-starter build
```

To connect the starter to a local or deployed game-services backend, set:

```sh
VITE_MPGD_GAME_SERVICES_URL=http://localhost:5173
VITE_MPGD_GAME_SERVICES_TARGET=android
VITE_MPGD_GAME_SERVICES_TRANSPORT=http
```

Use `VITE_MPGD_GAME_SERVICES_TRANSPORT=orpc` with a `/rpc` URL when testing the
oRPC client path.

## Daily Loop

```sh
pnpm dev:game
pnpm check
pnpm test
pnpm validate:game-assets
pnpm build:web
pnpm smoke:target web-preview
```

Use `pnpm graph:demo` before changing broad scene/platform flows. The root
`tsconfig.json` intentionally points at `tsconfig.graph.json` so local ttsc graph
tools and Codex MCP graph inspection can see the same TypeScript surface.

## Adding Gameplay

1. Add deterministic rules to `packages/game-core`.
2. Add authored data to `apps/game-phaser/src/game/content`.
3. Add input verbs to `apps/game-phaser/src/game/input/actions.ts`.
4. Keep Phaser scenes thin: scenes should dispatch input actions and render state,
   not become the source of truth for progression.
5. Save serializable state through `PlatformGateway.storage`; never save Phaser
   objects, sprites, tweens, cameras, or DOM nodes.

## Adding Assets

Place runtime assets under `apps/game-phaser/public/assets`, then register each
file in `apps/game-phaser/src/game/assets/manifest.ts`.

```sh
pnpm validate:game-assets
```

The validator checks that every manifest entry exists, every public asset is
registered, keys are unique, and registered assets stay under the default
100 MB public asset budget. Override the budget for local experiments with
`MPGD_GAME_ASSET_BUDGET_MB=120`.

## Platform Readiness

Builds embed the effective target config into each payload as
`mpgd-effective-target.json`, so game code can rely on the same feature
availability model that release smoke tests validate.

For native or Apps in Toss release checks:

```sh
pnpm smoke:targets:build
pnpm smoke:android:emulator
pnpm smoke:ios:simulator
```

Apps in Toss game launches should treat bundle size as a first-class constraint.
Keep the app bundle small, prefer manifest-driven assets, and move large optional
content behind a later remote-content strategy instead of silently adding it to
the initial WebView bundle.
