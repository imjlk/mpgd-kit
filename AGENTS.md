# Agent Instructions

This repository is `mpgd-kit`: a Multi-Platform Game Distribution / Development kit for Phaser games.

## Primary Stack

- Phaser 4
- Vite
- TypeScript 7 RC
- ttsc / ttsx
- @ttsc/lint
- @ttsc/unplugin
- @ttsc/graph
- typia
- Capacitor v8
- Apps in Toss Web Framework 2.x

## Hard Rules

- Do not introduce Cocos Creator.
- Do not introduce React Native as the mobile baseline.
- Do not use `tsx` for TypeScript scripts. Use `ttsx`.
- Root scripts invoke `ttsx` through `node tools/run-ttsx.mjs` so TypeScript-Go's native binary is resolved consistently under pnpm.
- Do not introduce ESLint or Prettier for TypeScript files. Use `@ttsc/lint`.
- The active `@ttsc/lint` config is `lint.config.js`; keep it as the single lint config file unless ttsc config loading changes.
- The active `@ttsc/strip` config is `strip.config.js` for the same reason.
- Do not put Phaser, Capacitor, Apps in Toss, Google Play Billing, StoreKit, or ad SDK imports in pure packages.
- Do not call platform SDKs directly from Phaser scenes. Use `PlatformGateway`.
- Do not grant purchases or ad rewards solely from client callbacks. All grants must go through backend ledger APIs.
- Do not put side effects inside debug calls that may be removed by `@ttsc/strip`.

## Pure Packages

These packages must stay independent of Phaser, DOM, network calls, and platform SDKs:

- `packages/game-core`
- `packages/game-economy`
- `packages/game-save`
- `packages/game-anti-cheat`
- `packages/catalog`
- `packages/analytics`

## Platform SDK Boundary

Platform SDK imports belong only in:

- `adapters/*`
- `native-plugins/*`
- `apps/target-*`

## Release And Changesets

- For PR-based work that will merge to `main`, add a Sampo changeset under `.sampo/changesets/` whenever the PR changes a publishable package's public API, runtime behavior, package metadata, generated release artifacts, or user-facing integration contract.
- If a PR intentionally does not need a changeset, state that in the PR summary or final handoff.
- Keep changesets focused on publishable packages. Do not add changesets for docs-only, private app-only, CI-only, or generated-output-only changes unless they affect a published package contract.
- Before merging a newly added publishable npm package to `main`, register the package with one local initial publish using the intended starting version. Use the maintainer's local npm auth environment, loaded through `mise`, and verify with `npm view <package> version` afterward. If the package is not ready for initial publish yet, keep it non-publishable, for example with npm `"private": true`, until the registration is complete.
- A PR that introduces a new publishable package must include its `.sampo/config.toml` release-group entry in the same PR once initial publish and OIDC readiness are done. Otherwise, keep the package private until a follow-up PR can safely add it to Sampo release automation.
- After the initial local publish, configure npm Trusted Publishing/OIDC for `.github/workflows/release.yml` and use Sampo changesets for subsequent releases.
- `@mpgd/adapter-devvit` was initial-published as `0.1.0` and has npm Trusted Publishing/OIDC configured for `.github/workflows/release.yml`; keep that setting aligned before relying on automated Devvit adapter releases.

## Preferred Commands

- `pnpm check`
- `pnpm validate:catalog`
- `pnpm validate:ads`
- `pnpm validate:target-config`
- `pnpm validate:effective-config`
- `pnpm validate:targets`
- `pnpm smoke:effective-config`
- `pnpm smoke:adapter-effective-config`
- `pnpm build:web`
- `pnpm build:ait`

## MCP

Use the `ttsc-graph` MCP server before broad TypeScript source exploration once the workspace has dependencies installed.

For Reddit Devvit work, register the official Devvit MCP server once in the
developer's global Codex configuration:

```sh
codex mcp add devvit -- npx -y @devvit/mcp
```

- Use `devvit_search` before broad web searches or loading large Devvit
  documentation pages into context.
- Use the experimental `devvit_logs` tool when investigating an app deployed to
  a specific subreddit, then verify any proposed fix with repository tests and
  the normal Devvit CLI playtest flow.
- Do not vendor personal MCP configuration or authentication state into this
  repository or generated games. MCP is an agent-side development aid, not a
  runtime or build dependency.
- If the server was just registered and its tools are not visible, restart
  Codex or begin a new task before falling back to official Devvit web docs.
