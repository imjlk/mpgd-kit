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
pnpm validate:i18n
pnpm validate:target-config
pnpm validate:effective-config
pnpm validate:targets
pnpm validate:game-assets
pnpm smoke:i18n
pnpm smoke:target-config
pnpm smoke:effective-config
pnpm smoke:adapter-effective-config
pnpm smoke:liveops
pnpm graph:preflight
pnpm pack:packages
pnpm build:web
pnpm smoke:target web-preview
pnpm build:ait
```

For day-to-day game work:

```sh
pnpm dev:game
pnpm validate:game-assets
pnpm graph:demo
```

See [Game Development Guide](docs/GAME_DEVELOPMENT.md) for the Phaser game
module boundaries, asset workflow, and platform readiness checks.

Reusable purchase, rewarded ad, and leaderboard flows are documented in
[LiveOps Vertical Slice](docs/LIVEOPS_VERTICAL_SLICE.md). The demo uses the same
ledger-first path: platform callbacks provide evidence, and save changes happen
only after backend verifier or ledger APIs accept the action.

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
contains `dist/index.js`, `dist/index.d.ts`, and every exported subpath file.
The root `pnpm test` command also builds package `dist/` output first so workspace
tests resolve the same package entrypoints that publishing uses.

## i18n Messages

`@mpgd/i18n` owns the translation-key/message catalog in
`packages/i18n/messages`. Paraglide generates typed message functions into
`packages/i18n/src/paraglide`, and package builds copy that runtime into
`dist/paraglide` so consumers can import `@mpgd/i18n`, `@mpgd/i18n/messages`,
or `@mpgd/i18n/runtime`.

```sh
pnpm i18n:build
pnpm smoke:i18n
```

## ttsc graph workflow

Use graph presets before changing broad TypeScript flows:

```sh
pnpm graph:target
pnpm graph:package
pnpm graph:bridge
pnpm graph:demo
pnpm graph:target-config
pnpm graph:preflight
```

`pnpm graph:preflight` runs every preset against `tsconfig.graph.json` and fails
if a preset no longer returns answer-ready anchors.

## Target Config

`packages/target-config/targets.json` is the source of truth for target-specific
platform feature availability, runtime metadata, release profiles, and nested
platform policy restrictions. Features include IAP, ads, leaderboard, and
localization. The Phaser app wraps each installed `PlatformGateway` with target
availability, so disabled features are removed from capabilities and return
unavailable/no-op results at runtime.
The demo resolves localized UI text through `@mpgd/i18n` only when the
target-configured gateway keeps `localizedContent` available; otherwise it falls
back to English.
Target-configured gateways also expose a runtime snapshot for demo diagnostics and
smoke checks across every configured release target:

```sh
pnpm smoke:target-config
```

Effective target config combines `targets.json`, product catalog, ad placements,
and platform target metadata into per-target SDK configuration bundles. Builds
write those bundles to `artifacts/target-config/*.json`, embed the active bundle
as `mpgd-effective-target.json` in each target's web/native payload, and record
each bundle path, version, and sha256 digest in the release manifest. The Phaser
demo receives the same effective config through its target-configured gateway, so
purchase, rewarded ad, leaderboard, storage, and localization actions follow the
same availability model that release artifacts validate.

```sh
pnpm validate:effective-config
pnpm build:effective-config
pnpm smoke:effective-config
pnpm smoke:adapter-effective-config
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
