# Game Development Guide

Generated games are ready for real Phaser iteration when the game stays inside
clear boundaries:

- The generated repository owns its game modules, assets, wrappers, target
  configuration, and release evidence.
- Generated games own stable asset keys, authored tuning, input verbs, and save
  models inside their own project roots.
- `packages/game-core` owns deterministic simulation and scoring rules.
- Phaser scenes adapt state into Phaser objects, cameras, tweens, and scene
  transitions.

Repository ownership and command routing differ between a single-game
repository, a multi-game workspace, and a kit contributor checkout. Read
[Game Project Models](GAME_PROJECT_MODELS.md) before adapting these commands to
a workspace.

## Generated Game vs Reference Fixture

Use the create package when starting a new single-game repository:

```sh
pnpm create @mpgd/game my-game
cd my-game
pnpm install --filter . --filter ./apps/target-devvit
pnpm dev
pnpm check
pnpm build
```

The `@mpgd/game` initializer name resolves to the public `@mpgd/create-game`
package. The reusable command implementation lives in `@mpgd/cli`. For a
multi-game workspace, generate or place the same game-shaped project under
`games/<game>` and select it through its own `mpgd.targets.json`.

Pass `--microsoft-store` when the new game should include the Microsoft Store
PWA target and release workflow. For a game created without it, run
`pnpm exec mpgd target init microsoft-store --game . --kit-path
<path-to-mpgd-kit>` later. The initializer is idempotent and stops instead of
overwriting conflicting scripts, target configuration, bootstrap wiring, or
agent workflow ownership. This migration applies to generated Phaser starters
whose `src/platform/runtimeDetector.ts` and `vite.shared.ts` files are still
present; custom game layouts must add equivalent runtime and Vite routing
manually.

Do not copy `examples/phaser-starter` to create a downstream game. The public
initializer reads `packages/cli/templates/phaser-game`; the checked-in example
is a private reference fixture that kit contributors use to validate the same
generated-project contract.

Kit contributor fixture loop:

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

Downstream users can skip that fixture loop. Multi-game workspaces may add thin
game-selection wrappers, but should continue to delegate target builds to the
public CLI or kit builder.

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
import {
  measureTargetViewport,
  resolveTargetViewportSnapshot,
  waitForTargetViewportMeasurement,
} from '@mpgd/target-config';

const measured = await waitForTargetViewportMeasurement({
  measure: measureGameViewport,
  subscribe: subscribeToGameViewportChanges,
});
const viewport = resolveTargetViewportSnapshot({
  ...measured,
  runtime: runtime.config.runtime,
});
```

For browser-hosted games, measure the mount element first.
`measureTargetViewport` falls back to `visualViewport` and then the window, and
returns `null` while every surface is still zero-sized. A hidden iframe, a
collapsed embed or a background tab can boot before layout; waiting for the
first usable size keeps it from failing viewport validation:

```ts
function measureGameViewport() {
  return measureTargetViewport({
    container: document.querySelector<HTMLElement>('#game'),
    visualViewport: window.visualViewport,
    window,
  });
}

function subscribeToGameViewportChanges(listener: () => void): () => void {
  const container = document.querySelector<HTMLElement>('#game');
  const observer = container === null ? undefined : new ResizeObserver(listener);

  if (container !== null) {
    observer?.observe(container);
  }
  window.addEventListener('resize', listener);
  window.visualViewport?.addEventListener('resize', listener);
  document.addEventListener('visibilitychange', listener);

  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', listener);
    window.visualViewport?.removeEventListener('resize', listener);
    document.removeEventListener('visibilitychange', listener);
  };
}
```

`waitForTargetViewportMeasurement` resolves immediately when the surface is
already measurable, unsubscribes once it settles and accepts an optional
`AbortSignal`. Later resize handlers can call `measureTargetViewport` and skip
an update while it returns `null`.

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

Generated Apps in Toss wrappers replace those browser fallbacks with the
official WebView `SafeArea.get()` snapshot and keep them synchronized through
`SafeArea.subscribe()`. They also expose
`--mpgd-ait-navigation-content-top`, the first full-width content position
below the transparent game navigation controls. A custom AIT wrapper should
install the same bridge before mounting its game:

```ts
import { installAitSafeAreaCssVariables } from '@mpgd/adapter-ait/safe-area';

installAitSafeAreaCssVariables();
```

Use `--mpgd-ait-navigation-content-top` for a persistent top HUD when the AIT
navigation bar is transparent. Continue using the ordinary
`--mpgd-safe-area-*` variables for device cutouts and the home indicator. The
bridge leaves the CSS `env(safe-area-inset-*)` values untouched when the native
snapshot is unavailable, so local browser playtests keep a safe fallback.
The default 52px navigation band and 10px edge gap match the current game
navigation treatment. A wrapper with measured custom host geometry can pass
`navigationControlBandHeightPx` and `navigationControlEdgeGapPx` overrides.

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
initially uses kit reference Capacitor shells for Android and iOS artifact smoke
checks. Initialize a game-owned shell from an installed game before preparing
App Store or Google Play submissions:

```sh
pnpm exec mpgd target init capacitor --game . \
  --app-id dev.example.mygame --display-name "My Game" \
  --icon-source public/icon.png \
  --backend-url https://api.example.com \
  --providers play-billing,storekit,identity
```

Run with `--dry-run` first to see managed file changes without installing or
adding native platforms. The count excludes files generated by pnpm or
Capacitor: the real run may also update the root `pnpm-lock.yaml`, create a
shell-local lockfile, and add native project files. Native target keys must
remain `android` and `ios` because the build CLI uses those canonical names.
The initializer writes a private shell under
`apps/mobile-capacitor`, installs its pinned dependencies, adds missing Android
and iOS projects, and updates both `mpgd.targets.json` entries. Rerunning is
safe after an interrupted dependency install and does not overwrite existing
native projects, signing files, or custom controllers. It rejects a preserved
native project whose app ID differs, or a dynamic Capacitor config whose
identity and web directory cannot be checked safely. Existing file permissions
are retained when managed content changes. If `cap add` created an
incomplete `android` or `ios` directory, repair or remove only that game-owned
directory before retrying; the initializer refuses to replace it.

`--providers` takes comma-separated ids and records all of them in
`mpgd.native-shell.json`. Two ids also install a kit store plugin:
`play-billing` (`@mpgd/capacitor-play-billing`, Android) and `storekit`
(`@mpgd/capacitor-storekit`, iOS). For each, the initializer pins one exact
version in the shell package and the game package (the game's installed copy
when it has one, otherwise the version this CLI release ships with), lets the
shell install and `cap add` or `cap sync` register the native code, and
records the pin under `providers` in the manifest. It refuses a store id
when the game has no matching `android` or `ios` target, a plugin the game
declares but has not installed, a shell that pins another version than the
game, and an installed plugin whose `@mpgd/adapter-capacitor` or
`@mpgd/platform` peer the game's kit packages do not satisfy (run
`mpgd kit upgrade` first). The gateway files are wired only when they are
still the unwired gateway earlier templates generated: the initializer then
writes the template's `capacitorAndroid.ts` or `capacitorIos.ts` and the
`commerceProducts.ts` and `commerceAccountBinding.ts` modules they import
(when the game has none). A gateway the game changed is never rewritten; the
initializer prints a warning naming the factory to register instead, and
likewise warns when the shell keeps a store plugin that is no longer
requested (it never uninstalls one). The dry run lists every file it would
write, including game sources, and the plugins it would install. Other ids
(`identity`, `game-platform`, ...) stay selection metadata: nothing installs
or enables them. `--providers` is rejected for every target other than
`capacitor`. A store plugin never grants anything: purchases are verified by
the game-owned backend through the commerce v2 reconciler, so a production
build still needs the backend's evidence entries and account binding.
For a newly added iOS project, the initializer also writes a shared App archive
scheme tied to the generated App target. Preserved iOS projects must already
have a matching shared scheme and Release plist identity placeholders; the
initializer checks these but does not replace them.
Preserved Android launchers must be exported and inherit from a recognized
Android Activity class (directly or through game-owned source). Manifest
Activity and Application classes must be public and concrete. The initializer
rejects unresolved Gradle-generated `app_name` overrides, including eager task
configuration; keep the release display name in checked manifest and resource
files. Preserved iOS projects cannot preprocess the Release Info.plist, skip
installing the App target into an archive, or link a game-owned helper target
implicitly through the App frameworks phase. Remove those unsupported build
customizations before initializing or packaging a production shell.

#### Store-facing shell settings

The initializer writes these into a newly generated native project only; a
native build checks an existing (preserved) shell against them, printing
warnings and failing a `production` build on errors, so a shell made earlier
needs the same edits by hand:

- **Export compliance (iOS).** `ITSAppUsesNonExemptEncryption` = `false` in
  `Info.plist` (kept when the game already set it) and `arm64` instead of the
  template's 32-bit `armv7` in `UIRequiredDeviceCapabilities`. Missing keys
  are warnings.
- **Design orientation.** `native.orientation` in `mpgd.game.json`
  (`portrait`, `landscape` or `any`; the Phaser template uses `landscape`, the
  lite template `any`)
  sets the iPhone `UISupportedInterfaceOrientations` and the Android launcher
  activity's `android:screenOrientation` (`portrait`, `sensorLandscape`, or
  none for `any`). iPad keeps all four orientations: Apple deprecated
  `UIRequiresFullScreen` in iPadOS 26 and asks iPad apps to support every
  orientation ([TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key));
  the runtime orientation policy (`orientationPolicy` in `src/main.ts`)
  letterboxes or asks the player to rotate. New Android projects also get
  `android:appCategory="game"`, because Android 16 ignores orientation locks on
  tablets and foldables for apps targeting API 36 unless they are games
  ([behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)).
  A shell that contradicts a configured orientation fails a production build;
  without `native.orientation` nothing is enforced.
- **iOS devices.** The App Store offers the app on iPhone and iPad
  (`TARGETED_DEVICE_FAMILY = "1,2"`) unless the ios target in
  `mpgd.targets.json` sets `"metadata": { "iosDeviceFamily": "iphone" }`
  (`"1"`). An iPad build needs iPad screenshots in App Store Connect and iPad
  QA (see [the mobile launch checklist](./MOBILE_LAUNCH_CHECKLIST.md)). A
  shell whose App target disagrees with a configured family fails a
  production build.
- **iOS push (`--providers notifications`).** A newly generated iOS project
  gets `App/App.entitlements` with `aps-environment` (`CODE_SIGN_ENTITLEMENTS`
  on the App target), the AppDelegate's APNs token forwarding, and the
  reference shell's cold-start tap forwarder in `SceneDelegate`. A shell that
  installs `@capacitor-firebase/messaging` without one of them fails a
  production build; a missing `GoogleService-Info.plist` in the App target is
  a warning ([Firebase notifications](./FIREBASE_NOTIFICATIONS.md#4-ios)).

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

### Store products from the catalog

Commerce v2 (RFC PR C3) wires every store target from one catalog:
`platformProductIds[<key>]` of each product in the game's `catalog.json`
(`MPGD_PRODUCT_CATALOG_FILE`, or the `@mpgd/catalog` default) is that
product's SKU for the store, and a product without a key is not sold there.

| Key | Read by | Shape |
| --- | --- | --- |
| `android` | `buildGateways/capacitorAndroid.ts`: `createCapacitorPlayBillingServiceProvider({ products })` | `{ logicalId, storeSku, kind }`; subscriptions skipped |
| `ios` | `buildGateways/capacitorIos.ts`: `createCapacitorStoreKitServiceProvider({ products })` | `{ logicalId, storeSku, kind }`; subscriptions skipped |
| `ait` | the Apps in Toss wrapper (`apps/target-ait/vite.config.ts`): `extractAitIapProductConfig` from `@mpgd/adapter-ait/iap-config` | `AitIapProductConfig` `{ productId, sku }` for `installAitHostBridge({ iapProducts })` |
| `reddit` | the Devvit server: `createDevvitCommerceBridgeProducts`; the webview: `createDevvitCommerceProducts` (both `@mpgd/adapter-devvit`) | `{ productId, sku }` for `createDevvitCommerceV2BridgeHandler`; `DevvitCommerceProduct` for the gateway |
| `microsoft-store` | `buildGateways/microsoftStore.ts`: `createMicrosoftStoreCommerceProvider({ products })` | Partner Center add-on id as `inAppOfferToken`; consumables only |
| `verse8` | `buildGateways/verse8.ts`: `createVerse8CommerceProducts` | VXShop product ids |

`gameServices.ts` also hands every product, with its kind and the SKU for the
build's target, to the reconciler (`createGameServicesRuntime({
commerceProducts })`), so a store purchase resolves its catalog kind without
a store read. The Apps in Toss and Devvit host lists always read the `ait`
and `reddit` keys, whatever the deployment target is called; the webview's
Devvit products read `reddit` too, so both sides agree. `pnpm
validate:catalog` derives both host lists and rejects a subscription with an
`ait` or `reddit` SKU and a blank, padded, or duplicate SKU, and `pnpm
validate:effective-config` rejects an IAP-enabled `ait` or `reddit` target
whose effective products or SKUs differ from its host list. Derivation never
enables selling: the Apps in Toss wrapper still needs its server hooks
(`prepareIap`, `verifyIapProductGrant`), the Devvit
server needs `permissions.payments` and a `payments` block whose SKUs match
the `reddit` keys and whose `endpoints.fulfillOrder` names the handler that
writes the ledger grant, and every store needs the backend evidence entries.

The starter journals every purchase and rewarded ad in
`createStorageMonetizationOperationStore` (`src/platform/monetizationJournal.ts`),
the reference durable journal over `gateway.storage`, unless the game passes
its own `operationStore`. See [Recovering purchases and rewarded
ads](MONETIZATION_RECOVERY.md#phaser-starter-assembly).

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
`VITE_MPGD_GAME_SERVICES_URL` to identify an authoritative backend. Hosted
`kind: web` targets with runtime `web` or `microsoft-store-pwa` may use `/api`
or a clean path below it, such as `/api/game-services`, for a same-origin
Pages/edge proxy. The host must forward to its environment-matched service
binding and fail closed if it is absent. Relative URLs must be resolved against
the actual page origin before passing them to clients that require absolute URLs.
This build check does not verify the deployed proxy, identity, or reward ledger.
AIT, Android, iOS and externally hosted runtimes still require a public HTTPS
URL without credentials; they may use the public Pages ingress URL. Protocol-relative,
encoded, dot-segment and query/fragment-bearing relative paths are rejected.
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

Every generated game includes an agent-facing brief, manifest, and acceptance
loop at these game-relative paths:

- `agent/brief.md`
- `agent/game-manifest.json`
- `agent/acceptance.md`
- `.agents/skills/*`

Kit contributors maintain the generated-game source at:

- `packages/cli/templates/phaser-game/agent/brief.md`
- `packages/cli/templates/phaser-game/agent/game-manifest.json`
- `packages/cli/templates/phaser-game/agent/acceptance.md`
- `packages/cli/templates/phaser-game/.agents/skills/*`

The checked-in reference fixture and kit-only agent configurations live at:

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

### Nine-slice UI assets

Phaser 4's `NineSlice` keeps corners fixed and stretches edges and the center.
Its source is an ordinary image; slice insets come from constructor arguments
or from a `scale9Borders` rectangle (the stretchable center) on a JSON Hash or
JSON Array atlas frame:

```json
"button": {
  "frame": { "x": 0, "y": 0, "w": 96, "h": 48 },
  "trimmed": false,
  "scale9Borders": { "x": 16, "y": 12, "w": 64, "h": 24 }
}
```

```ts
this.add.nineslice(x, y, 'ui', 'button', 240, 64);
```

- Keep nine-slice frames untrimmed; Phaser does not support trimmed frames here.
- A frame whose `scale9Borders` has `y: 0` and full height is a 3-slice that
  only stretches horizontally.
- Edges must be uniform along their stretch axis, or seamless when `tileX` /
  `tileY` repeat them.
- Extrude or pad atlas frames so linear filtering does not bleed neighbors into
  the seams.

Creating and checking that art is outside mpgd-kit. The external
[slicewright](https://github.com/imjlk/slicewright) tool covers generation
prompts, inset detection, stretch checks, previews, and `scale9Borders` output.

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
