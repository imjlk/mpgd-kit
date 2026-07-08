# mpgd-kit

`mpgd-kit` is a Multi-Platform Game Distribution / Development kit for Phaser games.

It starts with a Phaser 4 + Vite game and keeps platform, store, ads,
leaderboard, localization, release-target, and backend ledger concerns behind
typed contracts. The goal is to let a game stay game-shaped while each
distribution target gets the right adapter and validation path.

## What Works Today

- Phaser 4 browser game shell and validation demo.
- Browser preview, Capacitor Android/iOS, Apps in Toss WebView, and Reddit Devvit Web target builds.
- `PlatformGateway` contracts for identity, storage, IAP, ads, leaderboard, and lifecycle.
- Target-specific feature availability through `@mpgd/target-config`.
- Effective target config bundles for products, ad placements, storage, release profile, and localization.
- Paraglide-backed `@mpgd/i18n` translation-key/message catalog.
- Ledger-first game-services backend contracts, client orchestration, in-memory store, D1 store, HTTP endpoints, oRPC v2 beta procedures, and Cloudflare Worker starter.
- Agent-facing Phaser starter manifest, Codex custom agents, repository skills, and Apps in Toss MCP adapter workflow guidance.
- Target artifact smoke tests, package pack smoke tests, public-readiness checks, and ttsc graph presets.

## Quick Start

Create a standalone game starter:

```sh
pnpm create @mpgd/game my-game
pnpm --dir my-game install
pnpm --dir my-game dev
```

Under npm/pnpm/yarn/bun create conventions, the `@mpgd/game` initializer is
provided by the `@mpgd/create-game` package. The reusable command implementation
lives in `@mpgd/cli`.

For local kit development inside this repository:

```sh
pnpm install
pnpm mpgd game create examples/my-game --title "My Game" --workspace
cd examples/my-game
pnpm install --filter . --filter ./apps/target-devvit
pnpm check
pnpm build
pnpm exec mpgd target build-all --targets-file ./mpgd.targets.json --targets web,microsoft-store,ait,reddit --ait-variant wrapper --kit-path ../..
pnpm exec mpgd target smoke-all --targets-file ./mpgd.targets.json --targets web,microsoft-store,ait,reddit --kit-path ../..
```

Use `--workspace` for local kit development. Omit it when generating an external
game repo that should consume published `@mpgd/*` packages.

The starter wires `PlatformGateway`, target-config/effective-config, i18n, asset
manifest loading, and optional game-services client creation without copying the
demo game's score/coin loop.

For a minimum repo confidence check:

```sh
pnpm validate:public
pnpm check
pnpm test
```

For day-to-day work on the in-repo starter:

```sh
pnpm dev:game
pnpm --dir examples/phaser-starter check
pnpm --dir examples/phaser-starter build
pnpm graph:starter
```

## Starter And Target Configs

- `examples/phaser-starter` is the clean starting point for a new game.
  It is private, not publishable, and intentionally small. The repo's root
  target build scripts use this example's `mpgd.targets.json` so the kit does
  not own a separate sample game app.
- Generated games own their own `mpgd.targets.json`. The CLI resolves that file
  into a local generated target config before invoking the kit target tools.

See [Game Development Guide](docs/GAME_DEVELOPMENT.md) for boundaries and the
starter workflow. See [Agentic Game Workflow](docs/AGENTIC_GAME_WORKFLOW.md) for
Codex agents, skills, starter manifests, and Apps in Toss MCP guidance.

## Package Map

- `@mpgd/platform`: shared platform gateway surface.
- `@mpgd/bridge`: typed native bridge request/response protocol.
- `@mpgd/adapter-browser`, `@mpgd/adapter-capacitor`, `@mpgd/adapter-ait`,
  `@mpgd/adapter-devvit`: target adapters.
- `@mpgd/target-config`: target runtime, capability, release profile, and platform policy availability.
- `@mpgd/catalog`: product catalog and ad placement config schemas plus sample JSON.
- `@mpgd/i18n`: Paraglide-backed localized messages.
- `@mpgd/analytics`: typed analytics events and sink helpers for platform integrations.
- `@mpgd/game-services`: client orchestration, oRPC v2 beta contract, HTTP/oRPC handlers,
  memory/D1 store integration points, and backend service assembly.
- `@mpgd/capacitor-game-services`: Capacitor native plugin bridge surface.
- `@mpgd/cli`: Gunshi-based local CLI surfaced as `pnpm mpgd` for starter
  generation and target build/smoke matrix orchestration.
- `@mpgd/create-game`: thin create-package wrapper for
  `npm create @mpgd/game` / `pnpm create @mpgd/game`.

Internal game/economy/save/release-manifest/backend-ledger packages stay private
until their APIs become useful as standalone SDK surface. Pure packages do not
import Phaser, DOM APIs, network clients, or platform SDKs. Platform SDK calls
belong in adapters, native plugins, or target wrappers.

## Game Services Backend

Reusable purchase, rewarded ad, and leaderboard flows are ledger-first:

1. A target adapter collects platform evidence.
2. `@mpgd/game-services` sends that evidence to backend APIs.
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
- [Cloudflare Pages Host Runbook](docs/CLOUDFLARE_PAGES_HOST.md)
- [Production Integration Roadmap](docs/PRODUCTION_INTEGRATION_ROADMAP.md)

## Cloudflare Pages Host and Legal Site

`@mpgd/bridge/cloudflare-pages` exposes a reusable Pages advanced-mode host
helper. New game starters include `legal/privacy.html`, `legal/support.html`,
`legal/terms.html`, `mpgd legal build/check`, and
`apps/target-cloudflare-pages` for local Pages validation. The worker source is
TypeScript and bundles to Cloudflare's required `dist/_worker.js` output while
static legal pages stay in stable `/privacy/`, `/support/`, and `/terms/`
paths.

Cloudflare Pages is a host option for web/PWA targets that need same-origin APIs
or stable legal URLs. Native SDK capabilities remain target-adapter work:
Apps in Toss leaderboard APIs belong in the AIT wrapper, and Devvit
leaderboard/storage APIs belong in the Devvit wrapper. Authoritative grants and
score records still go through `@mpgd/game-services`.
The default Pages bridge intentionally does not expose cloud save or player
identity from client-controlled headers; add a custom bridge handler when a game
has authenticated identity/session infrastructure.

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
pnpm build:microsoft-store
pnpm smoke:target microsoft-store
pnpm build:devvit
pnpm smoke:target reddit
```

For generated games, prefer the CLI wrapper so `${MPGD_KIT_PATH}` target-file
tokens are resolved before the existing target scripts run:

```sh
pnpm mpgd target build-all --targets-file ./mpgd.targets.json --targets web,microsoft-store,ait,reddit --ait-variant wrapper --kit-path <path-to-mpgd-kit>
pnpm mpgd target smoke-all --targets-file ./mpgd.targets.json --targets web,microsoft-store,ait,reddit --kit-path <path-to-mpgd-kit>
```

Generated Phaser starters own their Reddit Devvit app root in
`apps/target-devvit`; run `pnpm devvit:init` once after login before live
playtest/upload. Apps in Toss and Capacitor targets currently use kit reference
shells for smoke builds, but release artifacts and manifests are copied back
under the game app's `artifacts/` and `release-output/` directories. Production
app metadata should still move into game-owned wrappers before store or Toss
submission.

Microsoft Store support is modeled as a PWA/web target, not a separate native
SDK adapter. `pnpm build:microsoft-store` builds the Phaser game with the
browser gateway, embeds the `microsoft-store` effective target config, and
writes `artifacts/microsoft-store` with a linked web app manifest for
PWABuilder packaging and Partner Center submission. A dedicated Microsoft Store
commerce adapter should be added only when wiring Microsoft Edge's Digital Goods
API and Payment Request API through backend ledger verification.

The starter dependency range is derived from the released `@mpgd/cli` package
version. Release PRs that bump the fixed public package group therefore update
new starter `@mpgd/*` pins without a separate hard-coded template version edit.

## What Is Sample or Mock

- `packages/catalog/catalog.json` uses sample product IDs.
- `packages/catalog/placements.json` uses sample ad placement IDs.
- Browser, Capacitor, Apps in Toss, and Devvit adapters include mock or bridge-contract
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
- Microsoft Store Digital Goods API and Payment Request integration.
- Devvit production payments/ad reward mapping and publish/playtest credentials.
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
pnpm validate:starter-workflow
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
pnpm build:microsoft-store
pnpm smoke:target microsoft-store
pnpm build:ait
pnpm build:devvit
pnpm smoke:target reddit
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
pnpm graph:starter
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

## Reddit Devvit

The Reddit target uses Devvit Web 0.13.x. `pnpm build:devvit` builds the
configured Phaser game with `APP_TARGET=reddit`, copies it to
`apps/target-devvit/dist/client`,
builds the Devvit server bridge to CJS, and writes the release manifest. Live
`devvit playtest`, `devvit upload`, and `devvit publish` remain local commands
because they depend on Reddit auth state in `~/.devvit/token`.

## Microsoft Store

The Microsoft Store target is a PWA distribution path. Microsoft's current
guidance is to package an existing PWA with PWABuilder and submit the generated
package through Partner Center. The repo therefore treats `microsoft-store` as a
store-reviewed web artifact that reuses `@mpgd/adapter-browser`; Store-specific
commerce remains disabled until a Digital Goods API/Payment Request integration
is added behind `PlatformGateway` and backend ledger APIs. The artifact includes
a linked `manifest.webmanifest`; game projects should replace the starter icon
and manifest metadata before Store submission.

Official references:

- [Publish a PWA to the Microsoft Store](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store)
- [Turn your website into a high quality PWA](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/pwa/turn-your-website-pwa)
- [Provide in-app purchases with Digital Goods API](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/digital-goods-api)
