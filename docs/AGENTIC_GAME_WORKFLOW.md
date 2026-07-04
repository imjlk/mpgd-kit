# Agentic Game Workflow

`mpgd-kit` uses Phaser 4 directly, but borrows the useful operating pattern from agent-first game tools: keep the framework surface small, make reusable blocks manifest-driven, and give agents narrow workflows with acceptance checks.

## Model

The repository separates four concerns:

- `PlatformGateway` is the only game-facing platform boundary.
- `@mpgd/target-config` describes target feature availability.
- `@mpgd/game-services` owns authoritative purchase, ad reward, and leaderboard ledger flows.
- `examples/phaser-starter/agent` gives agents a brief, manifest, and acceptance loop for new games.

The starter remains private. New public packages should be added only when their API is stable enough to publish. If a new public package is added, create a Sampo changeset and publish the new package locally first; already-published fixed packages can flow through the GitHub OIDC release workflow.

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
- `/api/mpgd/bridge` server boundary
- smoke tests

The starter manifest still reserves `reddit` in `futureTargets` because the
starter example is browser-first. Devvit SDK imports must stay in
`apps/target-devvit`, while game-facing code should continue to use
`PlatformGateway`.

## Validation

```sh
pnpm validate:starter-workflow
pnpm --dir examples/phaser-starter check
pnpm --dir examples/phaser-starter build
```

Use `pnpm check` before finishing broad changes.
