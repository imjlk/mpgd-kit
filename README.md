# mpgd-kit

`mpgd-kit` is a Multi-Platform Game Distribution / Development kit for Phaser games.

It starts with a Phaser 4 + Vite game and keeps platform, store, ads,
leaderboard, localization, release-target, and backend ledger concerns behind
typed contracts. The goal is to let a game stay game-shaped while each
distribution target gets the right adapter and validation path.

## What Works Today

- Phaser 4 browser game shell and validation demo.
- Browser preview, Capacitor Android/iOS, and Apps in Toss WebView target builds.
- `PlatformGateway` contracts for identity, storage, IAP, ads, leaderboard, and lifecycle.
- Target-specific feature availability through `@mpgd/target-config`.
- Effective target config bundles for products, ad placements, storage, release profile, and localization.
- Paraglide-backed `@mpgd/i18n` translation-key/message catalog.
- Ledger-first game-services backend contracts, client orchestration, in-memory store, D1 store, HTTP endpoints, oRPC v2 beta procedures, and Cloudflare Worker starter.
- Target artifact smoke tests, package pack smoke tests, public-readiness checks, and ttsc graph presets.

## Quick Start

```sh
pnpm install
pnpm --dir examples/phaser-starter dev
```

The starter is the smallest "new game" path. It wires `PlatformGateway`,
target-config/effective-config, i18n, asset manifest loading, and optional game
services client creation without copying the demo game's score/coin loop.

For a minimum repo confidence check:

```sh
pnpm validate:public
pnpm check
pnpm test
```

For day-to-day work on the SDK demo app:

```sh
pnpm dev:game
pnpm dev:game:ait
pnpm validate:game-assets
pnpm graph:demo
```

## Demo App vs Starter

- `examples/phaser-starter` is the clean starting point for a new game.
  It is private, not publishable, and intentionally small.
- `apps/game-phaser` is the SDK validation demo. It exercises player identity,
  save/load, target feature availability, localized UI, purchases, rewarded ads,
  leaderboard submission, and backend ledger flow.

See [Game Development Guide](docs/GAME_DEVELOPMENT.md) for boundaries and the
starter workflow.

## Package Map

- `@mpgd/platform-contract`: shared platform gateway surface.
- `@mpgd/adapter-browser`, `@mpgd/adapter-capacitor`, `@mpgd/adapter-ait`: target adapters.
- `@mpgd/target-config`: target runtime, capability, release profile, and platform policy availability.
- `@mpgd/product-catalog`, `@mpgd/ad-placements`: sample catalog and ad placement config.
- `@mpgd/i18n`: Paraglide-backed localized messages.
- `@mpgd/game-services-contract`: oRPC v2 beta contract for backend game services.
- `@mpgd/game-services-client`: client orchestration for purchase, rewarded ad, and leaderboard flows.
- `@mpgd/backend-game-services`: HTTP/oRPC handlers, memory/D1 store, and backend service assembly.
- `@mpgd/backend-purchase-verifier`, `@mpgd/backend-ad-reward-ledger`,
  `@mpgd/backend-leaderboard-ledger`, `@mpgd/backend-entitlement-ledger`:
  reusable ledger and verification primitives.
- `@mpgd/release-manifest`: target release artifact manifest types and validators.

Pure game/economy/save/catalog packages do not import Phaser, DOM APIs, network
clients, or platform SDKs. Platform SDK calls belong in adapters, native plugins,
or target wrappers.

## Game Services Backend

Reusable purchase, rewarded ad, and leaderboard flows are ledger-first:

1. A target adapter collects platform evidence.
2. `@mpgd/game-services-client` sends that evidence to backend APIs.
3. Backend services decide whether a grant or score is accepted.
4. Game save state changes only after the backend response is accepted.

`apps/game-services-worker` is a Cloudflare Vite plugin Worker starter. It exposes
public JSON endpoints, `/rpc/*` oRPC procedures, `/health`, and
`WorkerEntrypoint` service binding methods. The default Worker store is
`memory` for local smoke tests; production persistence should enable D1 and
`MPGD_STORE = "d1"`.

Read:

- [Game Services Backend](docs/GAME_SERVICES_BACKEND.md)
- [Cloudflare Worker Deploy Runbook](docs/CLOUDFLARE_WORKER_DEPLOY.md)
- [Production Integration Roadmap](docs/PRODUCTION_INTEGRATION_ROADMAP.md)

## Target Config and Release Targets

`packages/target-config/targets.json` is the source of truth for target-specific
platform feature availability, runtime metadata, release profiles, and nested
platform policy restrictions. Features include IAP, rewarded ads, interstitial
ads, leaderboard, and localization.

Builds embed `mpgd-effective-target.json` into each target payload and record the
bundle path, version, and sha256 digest in the release manifest.

```sh
pnpm validate:target-config
pnpm validate:effective-config
pnpm build:web
pnpm smoke:target web-preview
```

## What Is Sample or Mock

- `packages/product-catalog/catalog.json` uses sample product IDs.
- `packages/ad-placements/placements.json` uses sample ad placement IDs.
- Browser, Capacitor, and Apps in Toss adapters include mock or bridge-contract
  behavior suitable for local validation.
- Worker `MPGD_STORE = "memory"` is a starter default, not production persistence.
- The in-repo backend verifier accepts sample evidence. Real Google Play, App
  Store, AdMob SSV, and Apps in Toss verification adapters are production
  follow-ups.

## Known Production Gaps

- Google Play purchase token verification plus acknowledge/consume.
- StoreKit/App Store signed transaction or Server API verification.
- AdMob rewarded ad server-side verification callbacks.
- Apps in Toss production IAP/ad callback verification.
- Real product, ad placement, leaderboard, app, package, and bundle IDs.
- Cloudflare D1 provisioning and deployment credentials for persistent Worker
  deployments.
- PR required checks and review gates can be enabled after the public operating
  model is decided.

## Validation and Release Commands

Minimum quick check:

```sh
pnpm validate:public
pnpm check
pnpm test
```

Full release check:

```sh
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
pnpm smoke:game-services
pnpm smoke:game-services:worker
pnpm graph:preflight
pnpm pack:packages
pnpm build:web
pnpm smoke:target web-preview
pnpm build:ait
```

Package versioning and release PRs use Sampo:

```sh
pnpm sampo:add
pnpm sampo:release:dry-run
pnpm sampo:release
pnpm sampo:publish
```

npm publishing is intended to use trusted publishing/OIDC with provenance. Use a
token-based publish path only as a fallback.

## ttsc Graph Workflow

Use graph presets before changing broad TypeScript flows:

```sh
pnpm graph:target
pnpm graph:package
pnpm graph:bridge
pnpm graph:demo
pnpm graph:game-services
pnpm graph:target-config
pnpm graph:preflight
```

`pnpm graph:preflight` runs every preset against `tsconfig.graph.json` and fails
if a preset no longer returns answer-ready anchors.

## Apps in Toss

The Apps in Toss target currently uses SDK 2.x compatible `granite.config.ts`
and `ait build` scripts. SDK 3.x keeps the feature interface compatible but
renames the config file to `apps-in-toss.config.ts`, so that migration should be
handled as a dedicated follow-up.
