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
- After the initial local publish, configure npm Trusted Publishing/OIDC for `.github/workflows/release.yml`, add the package to `.sampo/config.toml`, and use Sampo changesets for subsequent releases.
- `@mpgd/adapter-devvit` was initial-published as `0.1.0`; keep its npm Trusted Publishing/OIDC settings aligned with `.github/workflows/release.yml` before relying on automated Devvit adapter releases.

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
