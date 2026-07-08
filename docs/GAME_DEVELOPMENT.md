# Game Development Guide

This repository is ready for real Phaser game iteration when the game stays inside
clear boundaries:

- `examples/phaser-starter/src/game` demonstrates the minimal in-repo game
  boundaries used by the starter.
- Generated games own stable asset keys, authored tuning, input verbs, and save
  models inside their own project roots.
- `packages/game-core` owns deterministic simulation and scoring rules.
- Phaser scenes adapt state into Phaser objects, cameras, tweens, and scene
  transitions.

## Starter vs Demo

Use the create package when starting a new standalone game:

```sh
pnpm create @mpgd/game my-game
cd my-game
pnpm install --filter . --filter ./apps/target-devvit
pnpm dev
pnpm check
pnpm build
```

The `@mpgd/game` initializer name resolves to the public `@mpgd/create-game`
package. The reusable command implementation lives in `@mpgd/cli`.

Use `examples/phaser-starter` when developing the starter inside this
repository. It is a private example workspace that shows the reusable mpgd
wiring without inheriting the demo game's score, coin, result, or mock purchase
loop.

Use `examples/phaser-starter` when validating kit-level starter wiring. The
starter keeps gameplay intentionally small and lets target build tools read
`examples/phaser-starter/mpgd.targets.json`, matching the generated-project
model without keeping a separate repo-owned demo game app.

Starter loop:

```sh
pnpm mpgd game create examples/my-game --title "My Game" --workspace --kit-path .
cd examples/my-game
pnpm install --filter . --filter ./apps/target-devvit
pnpm check
pnpm build
cd ../..
pnpm validate:starter-workflow
pnpm --dir examples/phaser-starter dev
pnpm --dir examples/phaser-starter check
pnpm --dir examples/phaser-starter build
```

The generated starter includes browser, Capacitor, Apps in Toss, and Reddit
Devvit adapter selection through `APP_TARGET`, local translation keys,
best-effort analytics, optional game-services client wiring, and a rewarded ad
smoke action. It stays intentionally small; real scoring, economy, content, and
save models should be added by each game.

Generated games own their Reddit Devvit app root in `apps/target-devvit`.
Run `pnpm devvit:login`, `pnpm devvit:init`, and `pnpm devvit:playtest` from the
game root when you are ready to create the Reddit-side app record and test it.
The starter still uses kit reference shells for Apps in Toss and Capacitor
artifact smoke checks. The final smoke artifacts are copied back under the
game app's `artifacts/` and `release-output/` directories, but copy or create
game-owned shells before real Toss, App Store, or Google Play submission
metadata is needed.

Use the kit CLI for generated target builds because it resolves
`${MPGD_KIT_PATH}` tokens in the game's `mpgd.targets.json` before invoking the
existing kit target scripts:

```sh
pnpm mpgd target build-all --targets-file examples/my-game/mpgd.targets.json --targets web,microsoft-store,ait,reddit --ait-variant wrapper --kit-path .
pnpm mpgd target smoke-all --targets-file examples/my-game/mpgd.targets.json --targets web,microsoft-store,ait,reddit --kit-path .
```

For a private sibling game repo, run the same commands from the game repo or kit
checkout and pass an absolute or relative `--targets-file` plus `--kit-path`.

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
pnpm build:web
pnpm smoke:target web-preview
pnpm build:microsoft-store
pnpm smoke:target microsoft-store
pnpm build:devvit
pnpm smoke:target reddit
```

Use `pnpm graph:starter` before changing broad starter/platform flows. The root
`tsconfig.json` intentionally points at `tsconfig.graph.json` so local ttsc graph
tools and Codex MCP graph inspection can see the same TypeScript surface.

## Agentic Starter Workflow

The starter includes an agent-facing brief, manifest, and acceptance loop:

- `examples/phaser-starter/agent/brief.template.md`
- `examples/phaser-starter/agent/game.manifest.json`
- `examples/phaser-starter/agent/acceptance.md`
- `.codex/agents/*`
- `.agents/skills/*`

Use [Agentic Game Workflow](AGENTIC_GAME_WORKFLOW.md) when asking Codex to add a
new reusable mechanic, evolve the starter, or plan a platform adapter. The
workflow keeps reusable blocks capability-named and keeps platform SDK imports
behind adapters, native plugins, or target wrappers.

## Adding Gameplay

1. Add deterministic rules to the generated game's serializable game modules.
2. Add authored data and input verbs inside the generated game project.
3. Keep Phaser scenes thin: scenes should dispatch input actions and render state,
   not become the source of truth for progression.
4. Save serializable state through `PlatformGateway.storage`; never save Phaser
   objects, sprites, tweens, cameras, or DOM nodes.

## Adding Assets

Generated games own their asset conventions. The template demonstrates
manifest-driven Phaser loading through `@mpgd/phaser-assets`, while the game
project decides which public assets, remote assets, and bundle budgets apply.

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

Devvit Web launches should treat client fetch and storage limits as first-class
constraints. Keep persistent game state behind `/api/` endpoints and Redis-backed
server storage rather than relying on browser-only localStorage.
