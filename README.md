# mpgd-kit

`mpgd-kit` is a Multi-Platform Game Distribution / Development kit for Phaser games.

It starts with a Phaser 4 + Vite game and keeps platform, store, ads,
leaderboard, localization, release-target, and backend ledger concerns behind
typed contracts. The goal is to let a game stay game-shaped while each
distribution target gets the right adapter and validation path.

## What Works Today

- Phaser 4 browser game shell and validation demo.
- Browser preview, optional Microsoft Store PWA, Verse8 iframe, Capacitor
  Android/iOS, Apps in Toss WebView, and Reddit Devvit Web target builds.
- Single-source PNG/SVG app icon generation with versioned profiles and release evidence for every target.
- `PlatformGateway` contracts for identity, storage, IAP, ads, leaderboard, and lifecycle.
- Target-specific feature availability through `@mpgd/target-config`.
- Effective target config bundles for products, ad placements, storage, release profile, and localization.
- Stateful cross-platform identity, launch, share, and notification contracts; see [Shared Platform Game Flow](docs/PLATFORM_GAME_FLOW.md).
- Paraglide-backed `@mpgd/i18n` translation-key/message catalog.
- Ledger-first game-services backend contracts, client orchestration, in-memory store, D1 store, HTTP endpoints, oRPC v2 beta procedures, and Cloudflare Worker starter.
- Agent-facing Phaser starter manifests, generated-game `AGENTS.md`, a kit workflow
  router skill, target-specific release skills, repository skills, and Apps in
  Toss MCP adapter guidance.
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

Microsoft Store is an explicit optional target for new games:

```sh
pnpm create @mpgd/game my-store-game --microsoft-store
```

Enable it later in an existing generated game without replacing game-owned
files:

```sh
pnpm exec mpgd target init microsoft-store --game . --kit-path ../mpgd-kit
```

Every generated game receives `AGENTS.md`, `agent/game-manifest.json`,
`.agents/skills/use-mpgd-kit`, and `docs/MPGD_KIT_WORKFLOWS.md`. Together they
route game and agent work across the platform boundary, target config, icons,
i18n, analytics, game services, build/smoke, acceptance, and target-specific
release evidence. Selecting Microsoft Store also adds its dedicated release
skill, config, scripts, and PWA runtime hook.

For local kit development inside this repository:

```sh
pnpm install
pnpm mpgd game create examples/my-game --title "My Game" --workspace
cd examples/my-game
pnpm install --filter . --filter ./apps/target-devvit
pnpm exec mpgd game accept . --targets default --profile staging --kit-path ../..
```

Use `--workspace` for local kit development. Omit it when generating an external
game repo that should consume published `@mpgd/*` packages.

The starter wires `PlatformGateway`, target-config/effective-config, i18n, asset
manifest loading, and optional game-services client creation without copying the
demo game's score/coin loop.

`mpgd game accept` provides one reusable handoff gate for game check, optional
test and browser `playtest` scripts, game build, ttsc graph preflight, the target
build/smoke matrix, and an optional target `gameplay:e2e` script. It writes both
JSON and Markdown reports under `artifacts/acceptance` by default. Games keep
state inspection and platform automation in their own package; the CLI validates
the shared manifest plan and attaches hashed gameplay evidence without
inventing game-specific behavior. See [Gameplay E2E](docs/GAMEPLAY_E2E.md).
Each command has a 30-minute timeout by default; use `--timeout-ms` for a
different per-step limit.

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
  `@mpgd/adapter-devvit`, `@mpgd/adapter-verse8`: target adapters.
- `@mpgd/target-config`: target runtime, capability, release profile, and platform policy availability.
- `@mpgd/catalog`: product catalog and ad placement config schemas plus sample JSON.
- `@mpgd/i18n`: Paraglide-backed localized messages.
- `@mpgd/analytics`: typed analytics events and sink helpers for platform integrations.
- `@mpgd/game-services`: client orchestration, oRPC v2 beta contract, HTTP/oRPC handlers,
  memory/D1 store integration points, authenticated cursor-paginated verified
  leaderboard reads, and backend service assembly.
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
`MPGD_STORE = "d1"`. The same D1 binding durably stores verified leaderboard
definitions, idempotent attempt decisions, optional bounded numeric metrics,
and retained ranked entries.

Verse8 rewarded ads use `@verse8/ads` only to collect a correlated
`requestId`. The adapter ignores client-reported reward values, and
`@mpgd/adapter-verse8/server` consumes `/ads/verify` before the catalog-backed
game-services ledger decides the grant. The Worker remains fail-closed unless
`VERSE8_ADS_VERIFIER_AUTHORIZATION` is configured as a secret containing the
complete server Authorization header issued for that endpoint.

Verse8 purchases use a separate authority path. The iframe adapter opens
VXShop and returns `pending`; it never manufactures a transaction or grants an
entitlement. `@mpgd/adapter-verse8/agent8` consumes the reserved Agent8
`$onItemPurchased` event under a per-account lock, ignores client metadata, and
writes the catalog grant with its consume-once marker in the same user-state
update. See [Verse8 VXShop and Agent8 Commerce](docs/VERSE8_COMMERCE.md).

Apps in Toss purchase and rewarded-ad callbacks use a public fail-closed
game-services verifier boundary. The purchase authority normalizes the
partner-server mTLS order-status lookup and authenticated Toss-login identity;
the reward authority stays game-owned instead of assuming an undocumented
server callback. Both paths match server evidence before the replay-safe ledger
can grant. See [Apps in Toss Production Evidence](docs/APPS_IN_TOSS_PRODUCTION_EVIDENCE.md).

Authenticated-encrypted Agent8 cloud saves are opt-in through a game-owned RPC
client, so the Phaser starter does not install the React browser SDK. The same
server-only adapter export provides a collection-backed verified leaderboard
with game-specific submission verification and opaque bounded cursor pages. It
remains separate from the platform-native leaderboard capability. See
[Verse8 Agent8 Storage and Verified Leaderboards](docs/VERSE8_AGENT8_SERVICES.md).

Read:

- [Game Services Backend](docs/GAME_SERVICES_BACKEND.md)
- [Verse8 VXShop and Agent8 Commerce](docs/VERSE8_COMMERCE.md)
- [Verse8 Agent8 Storage and Verified Leaderboards](docs/VERSE8_AGENT8_SERVICES.md)
- [Apps in Toss Production Evidence](docs/APPS_IN_TOSS_PRODUCTION_EVIDENCE.md)
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
ads, leaderboard, and localization. Each target supplies a localization
`fallbackLocale`; `@mpgd/i18n` can resolve a locale from a saved value, device
preferences, then that configured fallback without assigning defaults to
platform names.

Builds embed `mpgd-effective-target.json` into each target payload and record the
bundle path, version, and sha256 digest in the release manifest.

```sh
pnpm validate:target-config
pnpm validate:effective-config
pnpm build:web
pnpm smoke:target web-preview
pnpm build:microsoft-store
pnpm smoke:target microsoft-store
pnpm build:verse8
pnpm smoke:target verse8
pnpm build:devvit
pnpm smoke:target reddit
```

For generated games, prefer the CLI wrapper so `${MPGD_KIT_PATH}` target-file
tokens are resolved before the existing target scripts run:

```sh
pnpm mpgd target build-all --targets-file ./mpgd.targets.json --targets web,microsoft-store,verse8,ait,reddit --ait-variant wrapper --kit-path <path-to-mpgd-kit>
pnpm mpgd target smoke-all --targets-file ./mpgd.targets.json --targets web,microsoft-store,verse8,ait,reddit --kit-path <path-to-mpgd-kit>
```

Generated Phaser starters own their Reddit Devvit app root in
`apps/target-devvit`; run `pnpm devvit:init` once after login before live
playtest/upload. They also own an Apps in Toss wrapper in `apps/target-ait`, so
app identity, console state, community devtools, icons, and review metadata stay
with the game. Capacitor targets continue to use kit reference shells for smoke
builds until a game creates production-owned Android and iOS shells.

Optional Microsoft Store support is modeled as a PWA/web target, not a separate native
SDK adapter. `pnpm build:microsoft-store` builds the Phaser game with the
browser gateway, embeds the `microsoft-store` effective target config, and
writes `artifacts/microsoft-store` with a linked web app manifest for
PWABuilder packaging and Partner Center submission. A dedicated Microsoft Store
commerce adapter should be added only when wiring Microsoft Edge's Digital Goods
API and Payment Request API through backend ledger verification.

After reserving the product in Partner Center and building the target, copy the
Product Identity values into the game-owned `mpgd.microsoft-store.json` and run
`pnpm exec mpgd target preflight microsoft-store`. The preflight rejects
placeholder identity, missing listing screenshots, incomplete privacy or age
rating declarations, and commerce modes that do not yet have server-side ledger
verification. Desktop screenshots must be valid PNG files, no larger than
50 MB, and at least 1366 x 768 in landscape or portrait orientation. It writes
deterministic submission evidence under
`release-output/microsoft-store`.

After deploying the exact preflighted PWA, set `PWA_URL` and `MANIFEST_URL` to
its public production endpoints, then download a PWABuilder package ZIP with
distinct modern and classic package versions:

```sh
pnpm exec mpgd target generate-package microsoft-store \
  --targets-file ./mpgd.targets.json \
  --pwa-url "$PWA_URL" \
  --manifest-url "$MANIFEST_URL" \
  --package-version 1.2.3.0 \
  --classic-version 1.2.2.0
```

The command calls PWABuilder's fixed production package endpoint without
credentials. It requires the deployed manifest and every manifest icon to
match the preflight evidence both before and after generation, and requires the
PWA URL to stay inside that manifest's deployed scope. Local icon inputs are
also hash-checked and monitored for changes. The hash-verified local manifest
is pinned directly in the generator request using PWABuilder's custom-manifest
mode; the manifest URL remains its relative-resource base for those deployed
icons. The command bounds every network response, rejects redirects and unsafe
ZIP structure, and atomically writes the archive plus request, source-revision,
manifest, icon, and SHA-256 provenance. PWABuilder's API and the deployed icon
URLs are mutable external-service boundaries, so the before/after probes detect
changes but cannot make those resources content-addressed. The ZIP is not
extracted or accepted as submission-ready; inspect its contained packages with
the Microsoft Store acceptance flow before uploading it.

After PWABuilder produces `.msix`, `.msixbundle`, `.appx`, or `.appxbundle`
files, run `mpgd target accept-package microsoft-store --packages <paths>` on
Windows with the Windows SDK installed. The acceptance command uses MakeAppx
to verify every bundle and payload `Identity` against the preflight
evidence and records package hashes. WACK is a recommended optional local check:
from an active administrator user session, pass
`--appcert <path-to-appcert.exe>` to run it, require its XML `OVERALL_RESULT`
to be `PASS`, and add the report hash to the evidence.

The starter dependency range is derived from the released `@mpgd/cli` package
version. Release PRs that bump the fixed public package group therefore update
new starter `@mpgd/*` pins without a separate hard-coded template version edit.

## What Is Sample or Mock

- `packages/catalog/catalog.json` uses sample product IDs.
- `packages/catalog/placements.json` uses sample ad placement IDs.
- Browser, Capacitor, Apps in Toss, and Devvit adapters include mock or bridge-contract
  behavior suitable for local validation.
- Worker `MPGD_STORE = "memory"` is a starter default, not production persistence.
- The development backend verifier accepts sample evidence. Production AdMob
  rewards can use the reusable [SSV verification boundary](docs/ADMOB_SSV.md);
  each deployment must still provide callback persistence and rotating public
  keys. Production Apps in Toss
  verifier ports are included, while each game still supplies its authenticated
  mTLS purchase authority and independently verified reward authority. Google
  Play and App Store verification adapters remain production follow-ups.

## Known Production Gaps

- A production-authenticated Google Play API client and real package/product
  configuration for the shared one-time-product verification plus
  acknowledge/consume boundary; subscriptions remain separate.
- StoreKit/App Store signed transaction or Server API verification.
- Deployment-owned AdMob SSV callback persistence and public-key refresh wiring.
- Game-specific Apps in Toss mTLS/login transport and independently verified
  reward-authority implementations behind the included public ports.
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

## App Icons

Games declare one PNG or SVG canonical source in `mpgd.game.json`. Run
`mpgd game icons generate <game>`, `verify`, or `inspect` to prepare versioned
Devvit, Microsoft PWA, Apps in Toss, Android, iOS, and web-preview outputs.
Target builds run the same generator automatically and embed source/profile
evidence in their release artifacts. See [the app icon pipeline](docs/APP_ICON_PIPELINE.md)
for target overrides, native staging, and the Apps in Toss console URL gate.

## Apps in Toss

The Apps in Toss target uses the SDK 3 `apps-in-toss.config.ts` contract and
`ait build` scripts. The reusable production host resolves a stable game-scoped
player id with the game-only `getUserKeyForGame`, persists gateway state with
native `Storage`, and delegates sharing, Game Center, and Ads 2.0 to the official SDK. Purchases
stay fail-closed, and rewarded-ad callbacks remain evidence until a game-owned
authority verifies them. Generated wrappers use SDK 3 only; the removed SDK 2
Granite configuration is not generated or supported. Before releasing the first
SDK 3 bundle, follow the [SDK 3 release and CORS checklist](docs/APPS_IN_TOSS_SDK_3.md).

## Reddit Devvit

The Reddit target uses Devvit Web 0.13.x. `pnpm build:devvit` builds the
configured Phaser game with `APP_TARGET=reddit`, copies it to
`apps/target-devvit/dist/client`,
builds the Devvit server bridge to CJS, and writes the release manifest. Live
`devvit playtest`, `devvit upload`, and `devvit publish` remain local commands
because they depend on Reddit auth state in `~/.devvit/token`.

Repeatable server-side custom-post flows can use the
[`@mpgd/adapter-devvit/server` durable operation coordinator](docs/DEVVIT_DURABLE_POST_OPERATIONS.md).
It is duplicate-safe and ambiguity-safe rather than exactly-once: an uncertain
Reddit response enters reconciliation and does not authorize a blind repost.

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
- [PWABuilder Microsoft Store package service source](https://github.com/pwa-builder/PWABuilder/tree/ded7914e84d1509c901d2899a3f654f5d44ef08f/apps/pwabuilder-microsoft-store)
- [Provide in-app purchases with Digital Goods API](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/digital-goods-api)
