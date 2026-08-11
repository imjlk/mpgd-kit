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

Pass `--microsoft-store` when the new game should include the Microsoft Store
PWA target and release workflow. For a game created without it, run
`pnpm exec mpgd target init microsoft-store --game . --kit-path
<path-to-mpgd-kit>` later. The initializer is idempotent and stops instead of
overwriting conflicting scripts, target configuration, bootstrap wiring, or
agent workflow ownership. This migration applies to generated Phaser starters
whose `src/platform/runtimeDetector.ts` and `vite.shared.ts` files are still
present; custom game layouts must add equivalent runtime and Vite routing
manually.

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

The generated starter includes `AGENTS.md`, an agent capability manifest, a
kit-workflow router skill, and a shared workflow guide so downstream agents can
discover target config, icons, localization, analytics, game services,
acceptance, and release evidence without depending on this repository's local
instructions. The starter also includes browser, Capacitor, Apps in Toss, and Reddit
Devvit adapter selection through `APP_TARGET`, local translation keys,
best-effort analytics, optional game-services client wiring, and a rewarded ad
smoke action. Microsoft Store files are generated only when selected or later
initialized. It stays intentionally small; real scoring, economy, content, and
save models should be added by each game.

## Viewport And UI Composition

Use the rendered game container size as the source of truth for layout, not the
target name or user agent. `visualViewport` and `window.innerWidth` are useful
fallbacks, but the container is the safest measurement when a target shell adds
chrome, padding, safe-area insets, iframe constraints, or a resized playtest
frame. Reddit Devvit can appear as a narrow mobile card, a wider desktop embed,
or a resized playtest frame, so game UI should treat it as an embedded webview
and then choose layout from measured space.

`@mpgd/target-config` exports target viewport helpers for this first pass:

```ts
import { resolveTargetViewportSnapshot } from '@mpgd/target-config';

const measured = measureGameViewport();
const viewport = resolveTargetViewportSnapshot({
  width: measured.width,
  height: measured.height,
  source: measured.source,
  runtime: runtime.config.runtime,
});
```

For browser-hosted games, measure the mount element first:

```ts
function measureGameViewport() {
  const rect = document.querySelector<HTMLElement>('#game')?.getBoundingClientRect();

  if (rect !== undefined && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height, source: 'container' as const };
  }

  const visualViewport = window.visualViewport;

  if (
    visualViewport !== undefined &&
    visualViewport !== null &&
    visualViewport.width > 0 &&
    visualViewport.height > 0
  ) {
    return {
      width: visualViewport.width,
      height: visualViewport.height,
      source: 'visual-viewport' as const,
    };
  }

  return { width: window.innerWidth, height: window.innerHeight, source: 'window' as const };
}
```

`resolveTargetViewportSnapshot` is intentionally a pure helper. It classifies
measured dimensions and target shell family, returns starter recommendations
such as bottom controls for compact/portrait layouts, and exposes a
`safeArea.contentBounds` rectangle for persistent HUD placement. Games should
override those recommendations when their playfield has stronger constraints.

### Safe-area coordinate contract

The generated HTML documents declare `viewport-fit=cover`, and the generated
CSS exposes the browser values through `--mpgd-safe-area-top`, `right`,
`bottom`, and `left`. The values passed to `safeAreaInsets` must be in the
**same coordinate space as the measured viewport**.

The starter measures `#game` after its outer CSS has already reserved the safe
area, so its default snapshot correctly reports a full-content rectangle with
zero local insets. Do not pass the browser insets again in that case: doing so
would shrink the game board twice.

For a full-bleed game that measures the browser viewport directly and places
its own Phaser/DOM HUD, opt in explicitly:

```ts
import {
  readTargetViewportSafeAreaInsets,
  resolveTargetViewportSnapshot,
} from '@mpgd/target-config';

const viewport = resolveTargetViewportSnapshot({
  width: window.innerWidth,
  height: window.innerHeight,
  runtime: runtime.config.runtime,
  source: 'window',
  safeAreaInsets: readTargetViewportSafeAreaInsets(
    getComputedStyle(document.documentElement),
  ),
});

const hudBounds = viewport.safeArea.contentBounds;
```

This keeps a bottom number pad, pause/menu control, or side rail out of phone
cutouts, home indicators, and embedded-webview chrome without assuming a
specific target or device. Keep DOM and Phaser layout on the same choice of
coordinate space; either reserve insets in the outer CSS **or** consume
`contentBounds` in the game, not both.

The default width classes are:

- `compact`: `<= 599px`, covering phones and narrow Devvit embeds.
- `medium`: `600px` through `899px`, covering larger phones, small tablets, and
  moderate embeds.
- `expanded`: `>= 900px`, covering desktop-like canvases and wide embeds.

Portrait and landscape are intentionally simple: `portrait` means height is
greater than width, and `landscape` means width is greater than or equal to
height. That keeps the same rule usable for Phaser scenes, DOM overlays, Apps in
Toss WebViews, Capacitor shells, and Devvit Web cards.

Recommended starter composition:

- Compact or portrait: keep primary controls at the bottom, put secondary
  panels behind a drawer or below the board, and reserve safe-area padding.
- Medium landscape: keep the primary play surface centered; side controls are
  acceptable only when hit targets remain large.
- Expanded landscape: side panels and side controls are fine, but the primary
  play surface should stay readable without relying on page scroll.
- Devvit: design compact-first, avoid assuming the card has full browser height,
  and keep persistent state behind `/api/` and server storage as described
  below.

Games that keep a stable playfield aspect on wide screens can resolve concrete
shell bounds without duplicating CSS breakpoints:

```ts
import { resolveTargetViewportComposition } from '@mpgd/target-config';

const composition = resolveTargetViewportComposition({
  viewport,
  gameAspectRatio: 3 / 4,
  expandedLayout: 'side-rails',
  minRailWidth: 160,
});

mountGame(composition.gameBounds);

if (composition.mode === 'side-rails') {
  mountLeftRail(composition.leftRailBounds);
  mountRightRail(composition.rightRailBounds);
} else {
  unmountRails();
}
```

`side-rails` is selected only when the game can use the full safe content height
and both rails meet `minRailWidth`. Otherwise landscape layouts fall back to
`bottom-controls`. Compact portrait layouts return `compact-portrait` and use
the complete safe content bounds, so a desktop aspect preference never creates
phone letterboxing. Treat all returned bounds as CSS-pixel coordinates relative
to the measured viewport, and keep authoritative gameplay rules independent
from the selected composition mode.

Generated games own their Reddit Devvit app root in `apps/target-devvit`.
Run `pnpm devvit:login`, `pnpm devvit:init`, and `pnpm devvit:playtest` from the
game root when you are ready to create the Reddit-side app record and test it.
The starter owns its Apps in Toss wrapper in `apps/target-ait`, including app
identity, Granite configuration, community devtools, and console metadata. It
still uses kit reference Capacitor shells for Android and iOS artifact smoke
checks. Copy or create game-owned mobile shells before App Store or Google Play
submission metadata is needed.

Use the kit CLI for generated target builds because it resolves
`${MPGD_KIT_PATH}` tokens in the game's `mpgd.targets.json` before invoking the
existing kit target scripts:

```sh
pnpm mpgd target build-all --targets-file examples/my-game/mpgd.targets.json --targets web,microsoft-store,verse8,ait,reddit --profile staging --ait-variant wrapper --kit-path .
pnpm mpgd target smoke-all --targets-file examples/my-game/mpgd.targets.json --targets web,microsoft-store,verse8,ait,reddit --kit-path .
```

Target names are game-owned identifiers. `browser` and an unconfigured `web`
alias continue to select `web-preview`. A configured `web` target, or any other
explicitly configured target with `kind: "web"`, is passed to `target build`,
`target smoke`, and their matrix variants unchanged. This supports independent
browser deployments without adding deployment-specific names to the kit.

### Direct-file offline test play

Use `offline-playtest` only when a tester needs to double-click one local HTML
file without running a server. It packages an already-built `web-preview` and
does not add an offline target to `mpgd.targets.json`:

```sh
pnpm exec mpgd target build web-preview staging \
  --targets-file ./mpgd.targets.json \
  --kit-path ../mpgd-kit
pnpm exec mpgd game offline-playtest .
```

The output defaults to `artifacts/offline-playtest`; custom outputs must also
stay below the game-owned `artifacts` directory. Its `index.html` contains
the bundled JavaScript, styles, and statically discoverable local assets, while
a content security policy and runtime guards deny network APIs. The adjacent
`README.txt` and `offline-playtest.json` label the artifact `test-play-only`,
record its hash, and state that it is not a release target, deployable PWA, or
store-submission package. It is intentionally excluded from target release
manifests and acceptance evidence.

Packaging success is not proof that every game flow supports offline play.
Server-backed login, purchases, ads, reward grants, leaderboards, and cloud
saves are unavailable, and `file://` storage varies by browser. The packager
rejects unsupported external styles, Workers, service-worker registration,
WebAssembly streaming, dynamic imports, import maps, HTML base elements, CSS
`@import`, runtime-computed `import.meta` asset URLs, retained inline-module
imports, and script-driven navigation. Meta-refresh navigation is removed from
the copy. glTF files must embed their dependencies as data URIs; use GLB for
models with external buffers or textures. Wrap server calls behind game-service
or platform helpers and render a disabled or local fallback when those helpers
report that the capability is unavailable.

When a game needs an additional runtime policy for one of those web targets,
place a schema-versioned `mpgd.target-config.json` beside `mpgd.targets.json`.
The CLI loads that file as an additive target-config extension; it cannot
replace built-in target policies. Use runtime and release profile `web` for a
deployed, game-owned browser target whose adapter supplies server-backed
commerce, identity, ads, or leaderboard capabilities. Keep `web-preview` for a
local browser target without those production integrations. A web target may
declare `installable: false` to omit its web app manifest while retaining icon
evidence and a favicon. It may also declare `staticDir` to
copy game-owned hosting metadata or other static files over the Vite artifact.

Use `staging` while a Capacitor entry points at a kit reference shell.
Production AIT, Android, and iOS builds fail closed unless their wrapper or
shell resolves to a dedicated directory inside the game root. An AIT target
with `authoritativeGameServices: false` keeps native identity, storage, sharing,
and Game Center while disabling IAP and ads, so it does not require a backend
URL. Enabling authoritative AIT grants, monetization on a deployed `web`
runtime, or producing Android and iOS releases requires
`VITE_MPGD_GAME_SERVICES_URL` to be a public HTTPS URL without credentials.
Canonical path validation blocks symbolic-link escapes; localhost and literal
private or reserved IP addresses are also rejected.

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

The starter delegates this policy to `createGameServicesRuntime` and derives
authority from the Vite profile (`production` exactly; `staging` stays
non-production). Production mode is fail-closed: a missing URL returns
`missing_authoritative_backend`, while a non-HTTPS, credential-bearing, local,
or private-address URL returns `invalid_authoritative_backend`; neither result
exposes a client. An explicitly supplied process-local backend is available
only in `non-production` mode with `allowLocalBackend: true`; it must never be
used to grant production purchases or ad rewards, or to accept production
leaderboard records.

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

Use [Gameplay E2E](GAMEPLAY_E2E.md) when promoting a browser playtest into a
target acceptance gate. Keep the manifest states shared, but keep Playwright,
ADB, XCUITest, Appium, and state-inspection code in the game-owned driver.

## Adding Gameplay

1. Add deterministic rules to the generated game's serializable game modules.
2. Add authored data and input verbs inside the generated game project.
3. Keep Phaser scenes thin: scenes should dispatch input actions and render state,
   not become the source of truth for progression.
4. Save serializable state through `PlatformGateway.storage`; never save Phaser
   objects, sprites, tweens, cameras, or DOM nodes.

`StorageAdapter` values must be JSON serializable. A missing key resolves to
`null`, while provider, identity, quota, serialization, and transport failures
reject. Remote adapters must not hide those failures by switching to a local
browser store because that can split progress across two authorities. Run the
same local/remote contract against every target adapter with:

```sh
pnpm smoke:storage-adapter-conformance
```

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
server storage rather than relying on browser-only localStorage. The starter
bridge rejects missing player identity, Redis failures, malformed values, and
values above its conservative 256 KiB per-value limit; it never falls back to
browser storage.
