# Agentic Game Workflow

`mpgd-kit` uses Phaser 4 directly, but borrows the useful operating pattern from agent-first game tools: keep the framework surface small, make reusable blocks manifest-driven, and give agents narrow workflows with acceptance checks.

## Model

The repository separates four concerns:

- `PlatformGateway` is the only game-facing platform boundary.
- `@mpgd/target-config` describes target feature availability.
- `@mpgd/game-services` owns authoritative purchase, ad reward, and leaderboard ledger flows.
- `examples/phaser-starter/agent` gives agents a brief, manifest, and acceptance loop for new games.
- `@mpgd/cli` provides a Gunshi CLI for starter generation and target
  build/smoke matrix orchestration.
- `@mpgd/create-game` provides the create-package wrapper for
  `npm create @mpgd/game` / `pnpm create @mpgd/game`.
- Every generated game receives its own `AGENTS.md`, capability manifest,
  `.agents/skills/use-mpgd-kit` router, and `docs/MPGD_KIT_WORKFLOWS.md` so the
  game can discover and preserve kit contracts outside this repository.
- Optional targets may add a generated target skill. Selecting or initializing
  Microsoft Store adds `.agents/skills/release-microsoft-store` together with
  its PWA build and evidence workflow.
- Generated games own their Reddit Devvit app root in `apps/target-devvit` and
  their Apps in Toss wrapper in `apps/target-ait`. Capacitor shells remain kit
  references for smoke builds until a game creates production-owned Android and
  iOS shells and app metadata.

Generated game projects remain private by default. The public packages are the
generator and reusable SDK surfaces. New publishable packages should be added
only when their API is stable enough to publish; add a Sampo changeset, perform
the initial local npm registration, configure npm Trusted Publishing/OIDC, and
include the package in `.sampo/config.toml` release groups before relying on the
GitHub release workflow.

## Custom Agents

Project-scoped custom agents live in `.codex/agents`:

- `codebase_explorer`: read-only package and symbol mapping.
- `phaser_scene_builder`: thin Phaser scene changes.
- `game_block_author`: capability-named blocks and manifests.
- `platform_adapter_author`: browser, Capacitor, AIT, Devvit, Telegram, and Tauri adapter work.
- `apps_in_toss_integrator`: AIT-specific docs and review flow.
- `monetization_guard`: IAP, ad reward, entitlement, and ledger review.
- `reviewer`: correctness and boundary review.

Use subagents for review or exploration, not as a substitute for local validation.

## Skills

Repository skills live in `.agents/skills`:

- `create-game-block`
- `evolve-phaser-starter`
- `add-platform-adapter`
- `validate-agentic-game-workflow`

These skills are intentionally procedural. They tell an agent which files to touch, which boundaries to preserve, and which checks to run.

Generated-game skills are intentionally smaller. The `use-mpgd-kit` skill
routes platform, target, content, service, acceptance, and release tasks through
the generated workflow guide. A target-specific skill is included only when its
target is configured.

## Starter Manifest

The starter manifest is `examples/phaser-starter/agent/game.manifest.json`.

It describes:

- game intent
- target list
- future target placeholders
- agent MCP requirements
- reusable blocks
- acceptance commands

Block ids must be capability names such as `simulation.loop.phase` or `services.backend.game-services`. Do not use game clone, brand, or copyrighted reference names.

## Apps in Toss Workflow

For AIT work, use the apps-in-toss MCP before implementation. Search Korean documentation keywords such as:

- `웹뷰 개발`
- `인앱 결제`
- `인앱 광고`
- `샌드박스`
- `심사`
- `저장소`

The AIT payment guide requires pending order restore and grant-completion handling for real purchases. In mpgd terms, the AIT SDK callback is evidence, while `@mpgd/game-services` backend ledger APIs remain the source of truth for granting purchases, rewarded ads, and leaderboard records.

Games may skip TDS, but non-game mini-apps must use TDS.

## Reddit Devvit Target

Reddit Devvit is introduced as a target adapter and wrapper, not as a scene dependency.

For Devvit work, enable the official Devvit MCP server from `.mcp.json` and use
`devvit_search` before implementation. Useful searches include:

- `Devvit Web`
- `devvit.json`
- `Vite`
- `Redis`
- `playtest`
- `payments`

Implemented shape:

- target-config entry
- `adapters/devvit`
- `apps/target-devvit`
- bridge fixtures
- `/api/mpgd/rpc` oRPC server boundary
- duplicate-safe, ambiguity-safe durable post operations through the
  `@mpgd/adapter-devvit/server` entry
- smoke tests

Generated games keep Devvit SDK imports in their own `apps/target-devvit`
directory, while game-facing code should continue to use `PlatformGateway`.
Durable custom-post operations must persist a stable attempt marker before a
Reddit call and reconcile uncertain outcomes without reposting. They must not be
described as exactly-once. See
[Devvit durable post operations](DEVVIT_DURABLE_POST_OPERATIONS.md).

## Validation

```sh
pnpm validate:starter-workflow
pnpm create @mpgd/game my-game
pnpm --dir my-game dev

pnpm create @mpgd/game my-store-game --microsoft-store
pnpm --dir my-game exec mpgd target init microsoft-store --game . --kit-path ../mpgd-kit

pnpm mpgd game create examples/my-game --title "My Game" --workspace --kit-path .
pnpm --dir examples/phaser-starter check
pnpm --dir examples/phaser-starter build
```

Use `pnpm check` before finishing broad changes.
