# mpgd-kit

`mpgd-kit` is a Multi-Platform Game Distribution / Development kit.

It starts with a Phaser 4 + Vite game and keeps platform concerns behind contracts and adapters:

- Browser preview
- Capacitor Android/iOS shell
- Apps in Toss WebView target
- Shared monetization, ads, leaderboard, save, and bridge protocols
- Backend ledger skeletons for purchase and ad reward grants

## Fixed Naming

- Repository: `mpgd-kit`
- npm scope: `@mpgd`

## First Commands

```sh
pnpm install
pnpm check
pnpm validate:catalog
pnpm validate:ads
pnpm validate:policy
pnpm validate:targets
pnpm smoke:policy
pnpm graph:preflight
pnpm pack:packages
pnpm build:web
pnpm smoke:target web-preview
pnpm build:ait
```

## Versioning and Changesets

This repo uses Sampo for changesets, SemVer bumps, changelogs, release PR automation, and npm publishing.

```sh
sampo add
sampo release
sampo publish
```

Convenience scripts are also available:

```sh
pnpm sampo:add
pnpm sampo:release:dry-run
pnpm sampo:release
pnpm sampo:publish
```

Before publishing, run the package smoke locally:

```sh
pnpm pack:packages
```

This builds publishable workspaces into `dist/` and verifies the npm pack payload
contains `dist/index.js`, `dist/index.d.ts`, and any exported JSON/native files.
The root `pnpm test` command also builds package `dist/` output first so workspace
tests resolve the same package entrypoints that publishing uses.

## ttsc graph workflow

Use graph presets before changing broad TypeScript flows:

```sh
pnpm graph:target
pnpm graph:package
pnpm graph:bridge
pnpm graph:demo
pnpm graph:policy
pnpm graph:preflight
```

`pnpm graph:preflight` runs every preset against `tsconfig.graph.json` and fails
if a preset no longer returns answer-ready anchors.

## Platform policy

`packages/policy-matrix/policy.json` is the source of truth for platform-gated
features such as IAP, ads, and leaderboard. The Phaser app wraps each installed
`PlatformGateway` with policy enforcement, so disabled features are removed from
capabilities and return unavailable/no-op results at runtime.
Policy-enforced gateways also expose a runtime snapshot for demo diagnostics and
smoke checks:

```sh
pnpm smoke:policy
```

Target artifact smoke can validate either every release target or one target
after a focused build:

```sh
pnpm smoke:targets
pnpm smoke:target web-preview
```

## ttsc lint config

`ttsc@0.16.9` currently evaluates this workspace reliably with `lint.config.js`, so the repo uses that file as the active `@ttsc/lint` config.
The production strip config follows the same rule with `strip.config.js`.

## Architecture Rule

Game rules live outside Phaser scenes. Scenes adapt simulation state to rendering and input. Platform SDK calls live in adapters, native plugins, or target wrappers.

## Apps in Toss

The Apps in Toss target currently uses SDK 2.x compatible `granite.config.ts` and `ait build` scripts. SDK 3.x keeps the feature interface compatible but renames the config file to `apps-in-toss.config.ts`, so that migration should be handled as a dedicated follow-up.
