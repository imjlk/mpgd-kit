# @mpgd/cli

## 0.56.0 — 2026-10-24

### Patch changes

- [79f28520](https://github.com/imjlk/mpgd-kit/commit/79f2852070b591ebaa5fb7a35fda1ddf3a4032d2) Allow an explicitly enabled Devvit Realtime permission during target artifact smoke checks. Preserve boolean validation, disabled defaults, and separate payment-readiness checks for custom multiplayer wrappers.

  Allow an empty Devvit product catalog for historical order/refund callbacks when the effective target also exposes no enabled products. Continue requiring the products file, internal fulfillment/refund endpoints, IAP readiness, unique SKUs, and exact catalog agreement. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.20.4, adapter-capacitor@0.12.4, adapter-devvit@0.13.6, adapter-verse8@0.7.8, analytics@0.5.0, capacitor-play-billing@0.3.8, capacitor-storekit@0.3.8, game-runtime@0.8.1, game-services@0.28.0

### Added

- [fc9158f3](https://github.com/imjlk/mpgd-kit/commit/fc9158f34c54c1d88cafc040e7584e0fa9ebb69b) The starter's `serverSession.ts` recommends `createGuestServerSession(coordinator)` from `@mpgd/game-services`: it answers the coordinator's stable `sessionFamilyId`, which the notifications runtime and the game-services Worker need, instead of a view's rotating `sessionId`.

  Generated games gain `src/platform/developmentServerSession.ts`. On the Vite dev server in the development mode, `VITE_MPGD_DEV_NOTIFICATION_SESSION=<playerId>` (or `<playerId>.<installationId>`) signs the game in with an unauthenticated development session, so the notification settings record consent against a local Worker run with `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS` before the game has an identity service. It applies to the notifications backend only: the commerce client keeps the session the game set, or none. A normal `vite build` drops it. Any `setStarterServerSession` call turns it off, and the first call after it was in use warns. The game's notifications guide gains a "Try it locally" section. `mpgd target init capacitor --providers notifications` writes the new module next to `serverSession.ts`, and leaves it out, with a warning, for a game whose own `serverSession.ts` does not import it. — Thanks @imjlk!

### Changed

- [6f735409](https://github.com/imjlk/mpgd-kit/commit/6f73540926badd80b98e4ae547c5a1a279154033) The generated game's notifications guide ("Try it locally") binds the local game-services Worker to `127.0.0.1` and points at mpgd-kit's live test runbook (`docs/NOTIFICATIONS_LIVE_TEST.md`) for real pushes, instead of suggesting the service-account key go into `.dev.vars` in the checkout. — Thanks @imjlk!

## 0.55.0 — 2026-10-21

### Minor changes

- [a2f31f14](https://github.com/imjlk/mpgd-kit/commit/a2f31f141434f432121c90a7c7511d6ef9cd1196) Check current stable Devvit SDK and CLI versions before target upload, publish, and playtest, including every directly declared `devvit` / `@devvit/*` package and the adapter-resolved SDK. Fail before upload on stale installs or unavailable registry checks; preserve exact pins and require rebuilding after upgrades. Update the adapter and starter to Devvit 0.15.0. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/adapter-ait@0.20.3, @mpgd/adapter-browser@0.11.7, @mpgd/adapter-capacitor@0.12.3, @mpgd/adapter-devvit@0.13.5, @mpgd/adapter-verse8@0.7.7, @mpgd/analytics@0.4.16, @mpgd/bridge@0.15.0, @mpgd/capacitor-play-billing@0.3.7, @mpgd/capacitor-storekit@0.3.7, @mpgd/catalog@0.10.7, @mpgd/game-runtime@0.8.0, @mpgd/game-services@0.27.2, @mpgd/i18n@0.6.21, @mpgd/platform@0.27.2, @mpgd/target-config@0.23.7

## 0.54.1 — 2026-10-21

### Patch changes

- [fef49ab1](https://github.com/imjlk/mpgd-kit/commit/fef49ab1919026405c27c3d8466825c346a4dcaa) `mpgd target build` and `mpgd target build-all` no longer record `uncommitted` or the kit commit as the game revision when the game checkout cannot be resolved. A missing or invalid `MPGD_SOURCE_GIT_SHA` fails those builds. Verification and preparation commands (`target smoke`, `smoke-all`, `doctor`, icon operations, and submission preflight) do not require a resolvable game revision. Release manifests now require `gitSha` to be a lowercase 40-character SHA, matching `kitGitSha`, and require effective-config and icon digests to be lowercase 64-character SHA-256 hex. — Thanks @imjlk!
- [dbc4e240](https://github.com/imjlk/mpgd-kit/commit/dbc4e2401f39563fc65ab0fb0663ff772297b8e9) `mpgd legal build` keeps legal sources and the generated site inside the project. A symlinked `artifacts` directory, a symlinked legal page such as `legal/privacy.html`, or any other symlink component on `legal-dir` or `out-dir`, is refused, including when the link target is also inside the project. The site is published by renaming a temporary directory created on the destination filesystem, so a crash cannot leave a truncated page and a mounted `artifacts` directory does not fail the rename with `EXDEV`.
  
  `mpgd kit upgrade` re-checks the planned game root, manifests, and lockfiles for symlink components immediately before each write, including rollback, and publishes those writes by renaming a temporary file. A game directory or parent swapped for a symlink after planning is no longer followed, and a `package.json` or lockfile swapped for a same-bytes symlink is no longer followed. — Thanks @imjlk!
- Updated dependencies: @mpgd/adapter-ait@0.20.2, @mpgd/adapter-browser@0.11.6, @mpgd/adapter-capacitor@0.12.2, @mpgd/adapter-devvit@0.13.4, @mpgd/adapter-verse8@0.7.6, @mpgd/analytics@0.4.15, @mpgd/bridge@0.14.3, @mpgd/capacitor-play-billing@0.3.6, @mpgd/capacitor-storekit@0.3.6, @mpgd/catalog@0.10.6, @mpgd/game-runtime@0.7.6, @mpgd/game-services@0.27.1, @mpgd/i18n@0.6.20, @mpgd/platform@0.27.1, @mpgd/target-config@0.23.6

## 0.54.0 — 2026-10-21

### Patch changes

- [38a4983d](https://github.com/imjlk/mpgd-kit/commit/38a4983d1abc03b5e7f151b12a2e57b9c1d834ad) `mpgd game create` and `pnpm create @mpgd/game` keep `$&`, `$'`, `` $` ``, and `$$` in a display title literal. Those sequences are no longer read as replacement patterns, so a title such as `Hit $&` no longer leaves `__GAME_TITLE__` in `notifications/topics.json` or injects the rest of a JSON file. Titles may also contain quotes and backslashes. Generated JSON, including `public/manifest.webmanifest`, escapes them, and single-quoted TypeScript titles escape quotes and backslashes, so the generated source still parses. Control characters and angle brackets are still refused.
  
  The generated notification settings scene wraps the outcome strip to the same 840px column as the list and moves the list down when that strip wraps, so the English stale-night consent message stays on the 960x540 canvas. — Thanks @imjlk!
- Updated dependencies: @mpgd/adapter-ait@0.20.1, @mpgd/adapter-browser@0.11.5, @mpgd/adapter-capacitor@0.12.1, @mpgd/adapter-devvit@0.13.3, @mpgd/adapter-verse8@0.7.5, @mpgd/analytics@0.4.14, @mpgd/bridge@0.14.2, @mpgd/capacitor-play-billing@0.3.5, @mpgd/capacitor-storekit@0.3.5, @mpgd/catalog@0.10.5, @mpgd/game-runtime@0.7.5, @mpgd/game-services@0.27.0, @mpgd/i18n@0.6.19, @mpgd/platform@0.27.0, @mpgd/target-config@0.23.5

### Added

- [f772a896](https://github.com/imjlk/mpgd-kit/commit/f772a8964437d512349736e609668792b480fbc1) A game created with `--providers notifications` gets a notifications backend once it has one to talk to: `createStarterNotificationBackend` now builds the notifications runtime (`@mpgd/platform/notifications-runtime`) over the game-services Worker's notification routes (`@mpgd/game-services/notifications/client`) when the game has `VITE_MPGD_GAME_SERVICES_URL` (a public https URL in production, the commerce client's rule) and has set its server-backed session with the new `setStarterServerSession`, and the target exposes a notifications provider. The runtime keeps its registration state in the platform storage, and the settings screen then shows the reminder, advertising, and night switches from the player's consent records. The runtime also loads the Worker's registry entry for its target (`GET /providers`) in the background and compares the provider with it; a Worker it cannot reach is logged and the runtime runs without the check. A Reddit game gets no Worker backend, since its notifications backend is the Devvit server. Without a URL or a session it returns `undefined`, as before, and warns once when the URL is set without a session. The Worker wiring lives in the new `src/platform/notificationBackend.ts`.
  
  Every generated game gains `src/platform/serverSession.ts` (`StarterServerSession`, `setStarterServerSession`, `resolveStarterServerSession`); when a session is set, the commerce client in `gameServices.ts` sends its header too. Nothing changes for a game that sets none. `mpgd target init capacitor --providers notifications` writes `serverSession.ts` into a game created by an earlier release that lacks it, next to the other notifications modules. `sessionId` must be the stable session-family id the identity service answers to `authenticateNotificationSession`, not a rotating one such as a `GuestSessionCoordinator` view's. — Thanks @imjlk!

## 0.53.0 — 2026-10-20

### Added

- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) `mpgd game create --providers notifications` (and `@mpgd/create-game --providers notifications`) adds the notifications v2 starter to a new Phaser or lite game:
  
  - `notifications/topics.json`, a topic catalog with the starter topics `daily-ready` and `streak-at-risk` (`requested`: off until the player turns them on), `friend-challenge` (`service`), a sample `advertising` topic for iOS (an Android FCM push cannot carry the opt-out action until the shell renders advertising natively, a follow-up), and the `consent-notice` topic with every `notices.copy` variant in Korean and English (decree art. 62-2 and 62-3 wording, `{{consentDate}}` in each);
  - `notifications/deployment.json` with `advertisingRules: "kr"` and an advertising sender whose contact placeholder `pnpm validate:notifications` refuses until it is replaced;
  - the Android and iOS gateways register the Capacitor notifications provider (FCM and local reminders, named Android channels, the opt-out action, and `openCapacitorNotificationSettings`); the Reddit gateway exposes the game-rendered opt-in and the Reddit login prompt; the generated Devvit server serves the opt-in and runs the notifications service in its scheduler tasks; the Apps in Toss wrapper reads the catalog's `targets.ait` mappings;
  - `integrations.notifications: "available"` for `android`, `ios`, and `ait` (Reddit stays `approval-required` until Reddit approves the app) and `integrations.identityUpgrade: "available"` for `reddit`;
  - a game-rendered notification settings screen (a Phaser scene, or a DOM panel in the lite template) for the OS or host permission, reminder topics, 광고성 정보 수신동의, and night consent, recorded through the notifications runtime and shown from the player's latest backend consent records (never a device-side copy); night consent is offered only while advertising consent is granted and is withdrawn with it; and `docs/NOTIFICATIONS.md`.
  
  The game declares `@capacitor-firebase/messaging` 8.5.2, `@capacitor/local-notifications` 8.3.1, and `firebase` 12.19.0. Without `--providers notifications` a generated game is unchanged. — Thanks @imjlk!
- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) `mpgd target init capacitor --providers notifications` adds notifications to an existing game's game-owned Capacitor shell: it installs `@capacitor-firebase/messaging` and `@capacitor/local-notifications` into the shell (at the game's installed versions, else 8.5.2 and 8.3.1) and declares them and `firebase` in the game (a game's own `firebase` must be in the messaging plugin's peer range, `^12.6.0` for the starter's plugin, or the initializer stops before writing), syncs a preserved native project, and, when a Capacitor gateway is still the template's (store-wired or not), wires the notifications provider into it and writes the starter modules and catalog the gateway reads, keeping any the game already has. A game-owned gateway is only checked. It refuses a game or shell that lists `@capacitor/push-notifications`, drops `SCHEDULE_EXACT_ALARM` from a newly generated Android project's manifest, and warns about an existing manifest that keeps it, about missing `google-services.json` and `GoogleService-Info.plist`, and that the settings screen is not added to an existing game. `mpgd.native-shell.json` records the plugins under `providers.notifications`. — Thanks @imjlk!

### Changed

- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) `@mpgd/adapter-ait/notification-config` exports `extractAitNotificationTopicConfig(catalog, { target, sourceLabel })`, which reads the `notificationTopics` of `installAitHostBridge` from a notification topic catalog's `targets.ait` mappings (`templateSetCode`, `agreement`). The catalog is checked with `validateNotificationTopicCatalog` from `@mpgd/catalog` (now a dependency) and the Apps in Toss registry entry, so for the Apps in Toss target the wrapper refuses what `pnpm validate:notifications` refuses, including an advertising topic mapped for Apps in Toss; other targets' mappings and the deployment are left to `pnpm validate:notifications`.
  
  The generated Apps in Toss wrapper reads the game's notification topic catalog at build time (`MPGD_NOTIFICATION_TOPICS_FILE`, else `notifications/topics.json` when it exists) and passes its Apps in Toss topics to the host bridge, so notifications v2 agreements and landings work once the game maps its console templates. Without a catalog or a mapping the wrapper behaves as before. — Thanks @imjlk!

### Patch changes

- [51c191fb](https://github.com/imjlk/mpgd-kit/commit/51c191fba835645cc6d4b09aa8ff11b16d06ff4f) Document the official ONEstore Web SDK skill installation and explicit refresh workflow for ONEplay consumers, with a local SDK version drift check and game-owned lifecycle/authentication acceptance requirements.
  
  Check the actual exported SDK URL rather than comments, and correct the installed sample with a shared browser bootstrap and mandatory server purchase verification hook. Preserve these local corrections when refreshing the official skill. — Thanks @imjlk!
- Updated dependencies: @mpgd/adapter-ait@0.20.0, @mpgd/adapter-browser@0.11.4, @mpgd/adapter-capacitor@0.12.0, @mpgd/adapter-devvit@0.13.2, @mpgd/adapter-verse8@0.7.4, @mpgd/analytics@0.4.13, @mpgd/bridge@0.14.1, @mpgd/capacitor-play-billing@0.3.4, @mpgd/capacitor-storekit@0.3.4, @mpgd/catalog@0.10.4, @mpgd/game-runtime@0.7.4, @mpgd/game-services@0.26.0, @mpgd/i18n@0.6.18, @mpgd/platform@0.26.0, @mpgd/target-config@0.23.4

## 0.52.0 — 2026-10-19

### Patch changes

- Updated dependencies: adapter-ait@0.19.0, adapter-browser@0.11.3, adapter-capacitor@0.11.1, adapter-devvit@0.13.1, adapter-verse8@0.7.3, analytics@0.4.12, bridge@0.14.0, capacitor-play-billing@0.3.3, capacitor-storekit@0.3.3, catalog@0.10.3, game-runtime@0.7.3, game-services@0.25.1, i18n@0.6.17, platform@0.25.0, target-config@0.23.3

## 0.51.0 — 2026-10-19

### Changed

- The generated Devvit server bridge (`apps/target-devvit/src/server/bridge.ts`) takes an optional `notifications` handler, `createDevvitNotificationsV2BridgeHandler` from `@mpgd/adapter-devvit/server`, which serves the `notifications.v2.*` methods. The generated entrypoint does not pass one yet, so every v2 method keeps answering `NOTIFICATIONS_V2_UNAVAILABLE` there; a handler that throws answers a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
- The Devvit notifications service's own work runs on the Devvit scheduler. `@mpgd/adapter-devvit/server` adds `devvitNotificationSchedulerTasks` (`mpgd-notifications-dispatch` every minute and `mpgd-notifications-purge` every five minutes, with their `/internal/scheduler/...` endpoints), `devvitNotificationTaskForEndpoint`, and `runDevvitNotificationTask(service, task)`. A dispatch run is one `runScheduler` run of the service, so server reminders fire on Devvit along with the due sends: rounds of at most 10 due schedule entries and 10 due sends, starting no round after 20 seconds; the result counts the sends the run `touched`. A purge run deletes at most the store's `purgeLimit` rows of each kind; `createDevvitNotificationService` now builds its Redis store with `purgeLimit` 200 unless `storeOptions` names one. The generated Devvit app declares both tasks in `devvit.json` and routes them through `src/server/notificationTasks.ts`; without a notifications service the tasks do no work.

### Patch changes

- Updated dependencies: adapter-ait@0.18.0, adapter-browser@0.11.2, adapter-capacitor@0.11.0, adapter-devvit@0.13.0, adapter-verse8@0.7.2, analytics@0.4.11, bridge@0.13.2, capacitor-play-billing@0.3.2, capacitor-storekit@0.3.2, catalog@0.10.2, game-runtime@0.7.2, game-services@0.25.0, i18n@0.6.16, platform@0.24.0, target-config@0.23.2

## 0.50.1 — 2026-10-17

### Fixed

- [a4279dcd](https://github.com/imjlk/mpgd-kit/commit/a4279dcdc1f30e5f45efa93124288dc44685b88e) Read independently versioned runtime dependencies from the published CLI manifest when generating standalone Phaser and Lite games, instead of substituting the CLI version for packages such as `@mpgd/platform` and `@mpgd/target-config`. — Thanks @imjlk!

## 0.50.0 — 2026-10-16

### Added

- [94fcb2b4](https://github.com/imjlk/mpgd-kit/commit/94fcb2b458d4d8860741ffaf87ff47aaa98b47d7) Enable standalone Lite game generation with the independently versioned
  `@mpgd/lite-shell` package. Record its version in the packed CLI manifest so
  generation outside a Kit checkout never substitutes the CLI version. Validate
  the shell's installed ESM and NodeNext declarations and exercise packed Lite
  consumers in Windows acceptance. — Thanks @imjlk!

### Fixed

- [a95a29f5](https://github.com/imjlk/mpgd-kit/commit/a95a29f567267680cd3fe41fbbe4b9b75d29ccda) Fix Windows asset-pack path containment so sibling output directories are accepted while overlapping source/output roots and symlinked output paths remain rejected. — Thanks @imjlk!

## 0.49.0 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Generate TypeScript acceptance tools and a dedicated strict tools project for Phaser and Lite games. Include tools in check, lint, format, and fix commands, and document runtime-based JavaScript exceptions instead of using `.mjs` as the scripting default. — Thanks @imjlk!
- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Added

- [143326c5](https://github.com/imjlk/mpgd-kit/commit/143326c5c36ddcfee0fe20522119fc6f5a3605af) Validate Devvit bundle names before writing files, including case collisions on
  Windows and conflicts with the configured public directory. Improve workspace
  build diagnostics for dependencies linked to another game's installation or the
  Kit store when a different workspace owns the active build.
  
  Expose the shared collision guard through `@mpgd/cli/devvit` and register it in
  shipped wrapper Vite configurations so staging watch/playtest builds enforce the
  same output rules as production builds.
  
  Workspace-generated wrappers load the guard from Kit TypeScript source without
  requiring prebuilt CLI output; standalone wrappers use the published subpath. — Thanks @imjlk!
- [7e495bc1](https://github.com/imjlk/mpgd-kit/commit/7e495bc140c0802374eb245beb425aa19b5cf1e7) Add a preview-first TypeScript tooling migration for existing generated games, with JavaScript and TypeScript runner customization detection, stale-plan protection, rollback limited to migration-owned lockfile updates, and parent-workspace boundaries.
  
  Block mixed child-package compiler versions and conflicting non-dev or peer
  toolchain declarations; recheck nested manifests and workspace configuration
  before applying a preview.
  
  Preserve untouched and concurrently edited files during rollback. Record lock
  ownership and explain safe manual recovery after an interrupted migration.
  
  Preserve modified lockfiles for inspection after refresh failure, reject nested
  parent-workspace migrations whose shared toolchain is not verified, and isolate
  lockfile refresh from inherited pnpm workspace selection. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.17.1, adapter-browser@0.11.1, adapter-capacitor@0.10.1, adapter-devvit@0.12.1, adapter-verse8@0.7.1, analytics@0.4.10, bridge@0.13.1, capacitor-play-billing@0.3.1, capacitor-storekit@0.3.1, catalog@0.10.1, game-runtime@0.7.1, game-services@0.24.1, i18n@0.6.15, phaser-assets@0.9.1, platform@0.23.1, target-config@0.23.1

## 0.48.0 — 2026-10-15

### Patch changes

- [d8486b02](https://github.com/imjlk/mpgd-kit/commit/d8486b0279dd6b1e6d83e4bef192e62413aa1636) Notifications v2, PR N3: transports without v2 answer every
  `notifications.v2.*` method with `NOTIFICATIONS_V2_UNAVAILABLE`, which is not
  retryable, instead of `UNSUPPORTED_METHOD`. No adapter serves notifications v2
  yet; P1–P3 add the providers.
  
  - `@mpgd/adapter-ait`: the host bridge and the sandbox bridge, in every build,
    answer the code without reaching the host's agreement API. The commerce v2
    provider over the bridge validates events with the commerce envelope and
    ignores notifications envelopes. The commerce event channel
    (`GamePlatformBridge.commerceV2`), `AitCommerceV2BridgeHandler`, and
    `CreateAitBridgeCommerceProviderInput.subscribe` keep the commerce envelope
    type (`BridgeCommerceEvent`) they had before `BridgeEvent` became a union.
  - `@mpgd/adapter-capacitor`: the gateway's request path answers the code for
    a method no registered provider serves, before it pauses the game or
    reaches the base plugin, and a provider cannot declare those methods. For
    the provider P2 adds, `notifications.v2.requestPermission` and
    `notifications.v2.openSettings` pause the game, and the registry passes
    `notifications.v2.*` through `assertMethodReady` as it does `commerce.v2.*`.
    A launched commerce v2 purchase ends its pause on commerce events only, and
    the gateway hands its commerce provider only the commerce envelopes of the
    provider's channel. The commerce v2 provider over the bridge reports an
    envelope that names no protocol as a purchase error, as the Apps in Toss
    provider does, instead of dropping it. `CommerceProviderBridge.subscribe` and
    `CreateBridgeCommerceProviderInput.subscribe` keep the commerce envelope
    type (`BridgeCommerceEvent`) they had before `BridgeEvent` became a union.
  - `@mpgd/adapter-devvit`: the sandbox bridge answers the code.
  - `@mpgd/cli` and `@mpgd/create-game`: the generated Devvit server bridge
    answers the code, and the Apps in Toss sandbox gateway says so. — Thanks @imjlk!
- [785fd583](https://github.com/imjlk/mpgd-kit/commit/785fd58375ae9e60498a480317dbc26cd5fb6fbd) Fix Windows target builds by launching the active pnpm executable or JavaScript
  entrypoint directly instead of a global pnpm.cmd shim. Generated Phaser games
  enable pnpm's shell emulator so Microsoft Store scripts resolve their KIT path
  and POSIX environment defaults correctly on Windows. — Thanks @imjlk!
- [57862a64](https://github.com/imjlk/mpgd-kit/commit/57862a649f03c359a149ed9540a5fce58a320864) Make Devvit inline budget checks follow HTML attributes, JavaScript imports and
  CSS values instead of matching source text. Count inline style assets and distinct
  query URLs, and reject unverifiable external first-load resources when an inline
  budget is configured. Inspection reports external references without enforcing a
  budget. Entries with base href must emit artifact-relative URLs instead. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.17.0, adapter-browser@0.11.0, adapter-capacitor@0.10.0, adapter-devvit@0.12.0, adapter-verse8@0.7.0, analytics@0.4.9, bridge@0.13.0, capacitor-play-billing@0.3.0, capacitor-storekit@0.3.0, catalog@0.10.0, game-runtime@0.7.0, game-services@0.24.0, i18n@0.6.14, platform@0.23.0, target-config@0.23.0

### Minor changes

- [0234f853](https://github.com/imjlk/mpgd-kit/commit/0234f853cffff19e181587cef79fd0465144ed61) - The Microsoft Store submission preflight now checks the manifest's
    `start_url`, `scope`, and icon `src` with `normalizeRootRelativeRoute` from
    `@mpgd/platform/routes`: `.` followed by a route already in its normalized
    form. It now also refuses a URL whose path a client that percent-decodes it
    could read as another host, such as `./%2F%2Fevil.example/`. `@mpgd/platform`
    is now a dependency of the CLI.
  - Generated games pass the game's Apps in Toss app name to
    `createAitSandboxBridge({ appName })` in `pnpm dev:ait`. It is
    `MPGD_AIT_APP_NAME`, else the `ait` target's `metadata.appName`, else the game
    name, the same name the wrapper's host bridge uses. Before, the sandbox
    defaulted to `mpgd-kit` and refused the game's own `intoss://<app>` share
    links. — Thanks @imjlk!
- [8de63811](https://github.com/imjlk/mpgd-kit/commit/8de6381120ab6c7393cec3d6ec65190d3b63873d) Ship reusable C# Microsoft Store native bridge sources and a public locator.
  Game-owned callbacks provide login and commerce policy; common helpers validate
  the protocol and typed results, dispatch on the window UI thread, and cancel
  queued operations and suppress stale responses after navigation or closure.
  Align native catalog display-text validation with localized joiners, emoji and
  RTL price marks while preserving strict identifiers and rejecting unsafe controls. — Thanks @imjlk!
- [0b8cef09](https://github.com/imjlk/mpgd-kit/commit/0b8cef09fbcbc35bfc9982626f2ce5b873364425) Ship reusable PowerShell MSIX native acceptance helpers and expose their installed
  module path through @mpgd/cli/windows-native-tools. Consumers supply package
  identity, verified source metadata and optional payload/readiness/evidence callbacks.
  KIT and game CI share installation, process/runtime checks, receipts and cleanup. — Thanks @imjlk!
- [10199c08](https://github.com/imjlk/mpgd-kit/commit/10199c08b193a0cb01917f24d0b9760845062063) `mpgd game create` adds `--template lite` (default `phaser`) and
  `--renderer canvas` for a Phaser-free starter. The lite template reuses every
  platform gateway, target wrapper, and release workflow of the Phaser template,
  drops the Phaser scenes and asset manifest, depends on `@mpgd/lite-shell`, and
  makes the Devvit inline surface playable with the same lite shell. Devvit
  targets accept optional `inlineEntry` and `inlineBudget`
  (`maxGzipKb`, `forbidModules`, `deferredChunks`); `mpgd target smoke` checks
  the inline first-load graph only when `inlineEntry` is set, so existing
  targets are unchanged.
  
  Until the private lite-shell package is initially published, lite generation
  requires `--workspace`. Generated lite guidance identifies Canvas2D ownership.
  
  Lite generation configures its Reddit inline budget, preserves feed and history
  lifecycle, removes visibility listeners on disposal, and verifies HTML content
  and artifact boundaries along with linked first-load resources.
  Windows template paths are normalized before overlay selection, and persisted
  browser history navigation keeps the game alive. Inline budgets include static
  and stylesheet imports even when a filename appears in `deferredChunks`; only
  dynamic-import edges can be deferred.
  
  Explicit game disposal releases its owned audio binding, runtime and shell once. HTML first-load asset tags and attributes are matched case-insensitively.
  
  HTML media and preload bytes count toward the inline budget. LiteShell size and resize notifications report the Canvas renderer's effective DPR, and repeated fits skip redundant backing-store resizes.
  
  Responsive image candidates count conservatively toward the first-load budget, while data URLs remain embedded in the HTML byte count. Canvas DPR caps must be positive and finite. Inline layouts reserve all four native safe-area insets, including short screens, in both the example and generated lite template.
  
  Only primary pointer activations trigger gameplay taps. Generated Devvit guides substitute the game's title and slug. — Thanks @imjlk!
- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: Commerce v2, PR C4: the generated game template (and the private
  starter it mirrors) follows the removal of the commerce v1 surface. A game
  created or upgraded with this release builds against `gateway.commerce` (the
  renamed `commerceV2`) and the required `commerce` capability block.
  
  - The Microsoft Store build gateway's purchase authority no longer declares
    `getEntitlements()`; entitlements come from the backend ledger through
    game-services.
  - The Verse8 build gateway no longer passes `loadEntitlements`, and the
    game-owned `StarterVerse8Agent8Client` port lost `getCommerceSnapshot()`;
    only `listPurchases()` is read.
  - The Apps in Toss wrapper (`apps/target-ait`) no longer passes the removed
    `readIapEntitlements` host option, and the Devvit server bridge
    (`apps/target-devvit/src/server/bridge.ts`) drops the `commerce.getEntitlements`
    case and the `nativeIap` capability key; its `runtime.getCapabilities` answer
    carries the `commerce` block.
  - `pnpm validate:starter-workflow` fails a starter or template that names a
    removed v1 commerce API (`nativeIap`, `getEntitlements`,
    `createMicrosoftStoreCommerceAdapter`, ...). — Thanks @imjlk!

### Changed

- [295435cd](https://github.com/imjlk/mpgd-kit/commit/295435cd3f960901596f21c6e60df4edfc749825) Reuse ait-kit for SDK 3.6 single-use anonymous authentication: expose a host code issuer and a server mTLS exchange method while retaining response bounds, cancellation, and authoritative session boundaries.
  
  Align generated AIT hosts and starter validation on official WebView SDK and CLI 3.6.0 so new projects can issue anonymous authentication codes. — Thanks @imjlk!

## 0.47.0 — 2026-10-12

### Minor changes

- [5871a314](https://github.com/imjlk/mpgd-kit/commit/5871a31405de4caddd7fbb5d252b452310dd44df) Commerce v2, PR C3: generated games wire every store provider from the
  catalog, and `mpgd target init capacitor --providers` installs the native
  store plugins.
  
  - Template wiring. `src/platform/buildGateways/capacitorAndroid.ts` registers
    `createCapacitorPlayBillingServiceProvider` and `capacitorIos.ts` registers
    `createCapacitorStoreKitServiceProvider` for the one-time catalog products
    with an `android` or `ios` SKU (`src/platform/commerceProducts.ts`), bound
    through the reference `src/platform/commerceAccountBinding.ts` (Play: the
    hex SHA-256 of `mpgd-commerce-account:<playerId>`; StoreKit: the same
    digest as a version 5 UUID; a guest binds nothing). A shell built without
    the native plugin still runs and the store answers
    `configuration-required`. `reddit.ts` passes `commerce` to the Devvit
    gateway from the catalog's `reddit` SKUs, `verse8.ts` passes
    `vxShop.purchases` from the game's Agent8 client (`verse8Agent8Client.ts`,
    absent by default, so VXShop stays off), and `microsoftStore.ts` uses
    `withMicrosoftStoreCommerceProvider` with the catalog's consumables. The
    Apps in Toss wrapper installs `iapProducts` from the catalog, and the
    Devvit server serves `createDevvitCommerceV2BridgeHandler` only when
    `devvit.json` sets `permissions.payments` and `payments.endpoints.fulfillOrder`
    and the catalog names a Reddit SKU (the shipped `devvit.json` keeps it off). New games depend on
    `@mpgd/capacitor-play-billing` and `@mpgd/capacitor-storekit`.
  - Game services. `createStarterGameServices` runs the commerce v2 reconciler
    over `createStorageMonetizationOperationStore`
    (`src/platform/monetizationJournal.ts`), the reference durable journal over
    `gateway.storage` (serialized compare-and-swap, `listRecoverable`,
    `listGranted`, `findByTransaction`, terminal records kept for 30 days and
    at most 100, an unreadable document never replaced), unless the game
    passes its own `operationStore`, and hands the catalog kinds and SKUs to
    the reconciler as `commerceProducts`. With a journal always present,
    versioned rewarded display is no longer policy-disabled by default;
    grants still come only from the backend ledger.
  - `mpgd target init capacitor --providers play-billing,storekit` pins one
    exact plugin version in the game-owned shell and the game (the game's
    installed copy, else the version this CLI ships with), lets `cap add` or
    `cap sync` register it, records it under `providers` in
    `mpgd.native-shell.json`, and replaces an unwired template gateway with the
    wired one (writing `commerceProducts.ts` and `commerceAccountBinding.ts`
    when missing); a game-owned gateway is never rewritten and gets a warning.
    It refuses a store id without its native target, a declared but
    uninstalled plugin, a shell pinned to another version than the game, and
    an installed plugin whose kit peers the game does not satisfy. The dry run
    lists every file it would write and the plugins it would install. Other
    provider ids stay selection metadata, and `--providers` is now refused
    with a clear message for every target other than `capacitor`. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.16.0, adapter-capacitor@0.9.3, adapter-devvit@0.11.0, adapter-verse8@0.6.1, capacitor-play-billing@0.2.3, capacitor-storekit@0.2.3, game-runtime@0.6.6, game-services@0.23.0

## 0.46.1 — 2026-10-12

### Patch changes

- [2149670d](https://github.com/imjlk/mpgd-kit/commit/2149670dec731cf244ae05121dc87c5ee361adee) The generated Devvit target README now registers the optional Devvit MCP
  server with `mise --no-config exec node@22 -- npx -y @devvit/mcp@0.0.27`.
  `@devvit/mcp` 0.0.27 depends on `better-sqlite3` 11.9.1, which ships prebuilt
  binaries for Node 22 but not 24 and does not build on 26, and `--no-config`
  keeps mise-managed environment out of the server. The README also gives the
  plain `npx` form for hosts without mise. — Thanks @imjlk!

## 0.46.0 — 2026-10-12

### Patch changes

- Updated dependencies: adapter-ait@0.15.2, adapter-browser@0.10.2, adapter-capacitor@0.9.2, adapter-devvit@0.10.1, adapter-verse8@0.6.0, analytics@0.4.8, bridge@0.12.3, catalog@0.9.3, game-runtime@0.6.5, game-services@0.22.0, i18n@0.6.13, platform@0.22.0, target-config@0.22.1

## 0.45.0 — 2026-10-12

### Patch changes

- Updated dependencies: adapter-ait@0.15.1, adapter-browser@0.10.1, adapter-capacitor@0.9.1, adapter-devvit@0.10.0, adapter-verse8@0.5.0, analytics@0.4.7, bridge@0.12.2, catalog@0.9.2, game-runtime@0.6.4, game-services@0.21.1, i18n@0.6.12, platform@0.21.0, target-config@0.22.0

## 0.44.0 — 2026-10-12

### Patch changes

- Updated dependencies: adapter-ait@0.15.0, adapter-browser@0.10.0, adapter-capacitor@0.9.0, adapter-devvit@0.9.20, adapter-verse8@0.4.6, analytics@0.4.6, bridge@0.12.1, catalog@0.9.1, game-runtime@0.6.3, game-services@0.21.0, i18n@0.6.11, platform@0.20.0, target-config@0.21.3

## 0.43.0 — 2026-10-11

### Patch changes

- [6c0cdf1e](https://github.com/imjlk/mpgd-kit/commit/6c0cdf1e8bbd3a786db61fc12a8a02f29f69f3b5) Generated games now document how to ship stretchable UI art for Phaser 4
  `NineSlice`: untrimmed atlas frames carry `scale9Borders`, so scenes create
  them with `this.add.nineslice(x, y, key, frame)` instead of hard-coding slice
  insets. The workflow guide and `use-mpgd-kit` skill point to the optional
  external slicewright tool for generating and checking that art. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.14.1, adapter-browser@0.9.2, adapter-capacitor@0.8.0, adapter-devvit@0.9.19, adapter-verse8@0.4.5, analytics@0.4.5, bridge@0.12.0, catalog@0.9.0, game-runtime@0.6.2, game-services@0.20.0, i18n@0.6.10, platform@0.19.0, target-config@0.21.2

## 0.42.0 — 2026-10-11

### Patch changes

- Updated dependencies: adapter-ait@0.14.0, adapter-browser@0.9.1, adapter-capacitor@0.7.5, adapter-devvit@0.9.18, adapter-verse8@0.4.4, analytics@0.4.4, catalog@0.8.1, game-runtime@0.6.1, game-services@0.19.1, i18n@0.6.9, platform@0.18.0, target-config@0.21.1

## 0.41.0 — 2026-10-10

### Minor changes

- [03cb45e2](https://github.com/imjlk/mpgd-kit/commit/03cb45e2b6583934e04d758dab53fb451ec82b42) Add optional foreground performance collection to game acceptance, with bounded
  consumer-authored budgets, sample/cadence checks and fresh artifact provenance. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.13.3, adapter-capacitor@0.7.4, adapter-verse8@0.4.3, game-runtime@0.6.0, phaser-assets@0.9.0, target-config@0.21.0

## 0.40.0 — 2026-10-10

### Minor changes

- [6f9c7c8e](https://github.com/imjlk/mpgd-kit/commit/6f9c7c8ee1d1170ce228230179c3a5573dfd2d24) Publish verified remote asset-pack objects through a bounded deployment-only S3
  surface using conditional PUT, checksum/metadata HEAD verification and an immutable
  manifest snapshot written last. Keep storage credentials in named environment
  variables and preserve pinned live revisions with explicit collision failures. — Thanks @imjlk!
- [0e7ecd56](https://github.com/imjlk/mpgd-kit/commit/0e7ecd56988cdcf08a63d55e051bfe39712c9d33) Add provider-neutral per-target asset-pack placement, offline dependency closure
  and revision-pinned URL routing. Build and stage verified local and remote objects
  with actual byte reports, configurable packaged-asset limits and bundle checks;
  wire the same policy into web, embedded-web and installed target builds. — Thanks @imjlk!
- [3ccec624](https://github.com/imjlk/mpgd-kit/commit/3ccec62425163c6e7fcd560670e3a3f01ace37e7) Prepare single-format audio assets through the verified file/ZIP delivery path
  with shared audio-cache leases, decoded PCM/duration bounds and explicit playback
  unlock ownership. Add an opt-in idle-gated prefetch scheduler with cancellable
  foreground admission and bounded, deduplicated warm resource ownership. The asset
  pack builder and delivery manifest now support audio file roles and MIME types. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.3, phaser-assets@0.8.0, target-config@0.20.0

## 0.39.0 — 2026-10-09

### Added

- [537c6168](https://github.com/imjlk/mpgd-kit/commit/537c6168a902332e6c62ab0585d2cdfac946e51a) Add the ONE play H5 Web SDK target and browser adapter subpath, asynchronous host loading acknowledgements, synchronous exit checkpoints, platform asserted identity, audio/safe-area integration, and interstitial presentation handling that keeps uncertain native outcomes quarantined. Include target build, hosting headers, generated starter wiring and explicit server authority gates for subsequent monetization integrations. — Thanks @imjlk!
- [a483af3f](https://github.com/imjlk/mpgd-kit/commit/a483af3fb7f789a9edc71cc513e7c122d0b1e4b6) Add ONE play managed purchases with authenticated checkout intents, independent API V7 verification, ledger-before-consume or acknowledge finalization, signed PNS recovery and authoritative cancellation hooks. Map partial product detail batches and expose trusted native checkout presentation facts through the shared commerce contract and runtime. Keep subscriptions unsupported and server integrations required. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.13.2, adapter-browser@0.9.0, adapter-capacitor@0.7.2, adapter-devvit@0.9.17, adapter-verse8@0.4.2, analytics@0.4.3, catalog@0.8.0, game-runtime@0.5.0, game-services@0.19.0, i18n@0.6.8, platform@0.17.0, target-config@0.19.0

## 0.38.0 — 2026-10-09

### Minor changes

- [2d35eb0e](https://github.com/imjlk/mpgd-kit/commit/2d35eb0ecd89eef1058e4b9983eb284f7ba38adc) Add a CrazyGames web target and the browser adapter's `/crazygames` entry point with official v3 SDK initialization, loading/gameplay reporting, and interstitial ads using the shared presentation contract. Basic Launch keeps monetization disabled; Full Launch enables configured interstitial placements. Rewarded ads and purchases remain unavailable pending independent backend verification. Generated starters enter free play directly and retain scene, lifecycle, and native presentation ownership through game-owned gameplay scopes. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.13.1, adapter-browser@0.8.0, adapter-capacitor@0.7.1, adapter-devvit@0.9.16, adapter-verse8@0.4.1, analytics@0.4.2, catalog@0.7.8, game-runtime@0.4.0, game-services@0.18.1, i18n@0.6.7, platform@0.16.0, target-config@0.18.0

## 0.37.0 — 2026-10-09

### Added

- [b453182e](https://github.com/imjlk/mpgd-kit/commit/b453182e07aafc5e6db636422faa1bc29e3a97b7) Add a game-owned platform runtime and audio projection shared above scene lifetimes. Wire generated Phaser games to coordinated native presentation, registered late evidence recovery, application-owned journals and reconciliation, and scene-scoped action views. Preserve physical ownership after deadlines and prevent scene teardown from unmuting live ads. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.13.0, adapter-browser@0.7.9, adapter-capacitor@0.7.0, adapter-devvit@0.9.15, adapter-verse8@0.4.0, analytics@0.4.1, bridge@0.11.0, catalog@0.7.7, game-runtime@0.3.0, game-services@0.18.0, i18n@0.6.6, platform@0.15.0, target-config@0.17.1

## 0.36.2 — 2026-10-04

### Patch changes

- Updated dependencies: adapter-capacitor@0.6.2, adapter-devvit@0.9.14, adapter-verse8@0.3.12, game-services@0.17.2

## 0.36.1 — 2026-10-04

### Patch changes

- [f6d8f7e4](https://github.com/imjlk/mpgd-kit/commit/f6d8f7e41f46a34f7b20c99810f717d244631bbf) Harden the Apps in Toss host bridge: reject game `storage.save`/`storage.load` keys under the adapter-reserved `mpgd:ait:` prefix so game code cannot forge completed purchase or promotion markers, bound the client-supplied rewarded-ad `idempotencyKey` to 1-256 visible characters and document it as evidence the backend reward authority must verify, restrict `fetchAitAuthority` to `https:` resources (plain `http:` only for `localhost`/`127.0.0.1`) while accepting only a string, a URL-like object (string `href`, recognized by shape so a cross-realm `URL` is covered), or a same-realm `Request`, and forwarding only the validated representation to the transport (the resolved `href` string, or the `Request` instance after its `url` validated), and cap launch-intent `puzzleId`/`challengeToken` values and nested `queryParams` size and entry count.
  
  The `@mpgd/cli` `phaser-game` template now selects the self-completing `aitSandbox` gateway only for a non-production build whose `BUILD_ID` is exactly `ait-sandbox` (the value `pnpm dev:ait` sets); every other AIT build, including other debug builds, uses the production `ait` gateway so purchases and rewards cannot be granted without the backend. — Thanks @imjlk!
- [c756ad82](https://github.com/imjlk/mpgd-kit/commit/c756ad8207ee79c31d183f0383603691539646e9) Patch security advisories in CLI runtime dependencies. `@mpgd/cli` now requires `undici` `^7.29.1` (TLS certificate validation bypass, cross-user information disclosure, and denial-of-service fixes) and `sharp` `0.35.5` (libheif fixes plus the librsvg use-after-free in GHSA-wq5f-xc86-pv6w, which affects SVG icon inputs on glibc-based Linux). These two bumps ship in the published package.
  
  The patched transitive versions of `postcss`, `nanoid`, `qs`, `brace-expansion`, `browserslist`, `baseline-browser-mapping`, and `protobufjs` are pinned through `pnpm-workspace.yaml` overrides, which apply only to this repository's workspace and CI; pnpm does not carry overrides into published packages. Consumers keep their own resolved transitive versions and should run `pnpm audit` and apply their own overrides as needed. — Thanks @imjlk!
- [a5f74351](https://github.com/imjlk/mpgd-kit/commit/a5f74351f967fe68d887785403d6a86949dc08dc) Harden the Capacitor shell and StoreKit finish path. `mpgd target init capacitor` now opts a freshly generated Android project out of cloud backups and Android 12+ device-to-device transfers: it sets `android:allowBackup="false"`, `android:fullBackupContent="@xml/backup_rules"` and `android:dataExtractionRules="@xml/data_extraction_rules"` on the manifest and writes both rule resources, which exclude the `root`, `file`, `database`, `sharedpref` and `external` domains. Native target builds inject a restrictive Content-Security-Policy meta tag into the staged shell `index.html` unless the game page already declares an enforcing `Content-Security-Policy` meta tag (a report-only policy does not count). `finishGrantedTransaction` on the StoreKit provider only finishes a transaction with the ledger entry ID that `recoverStoreKitPurchases` recorded from a backend answer in the current session, consumes that pair before the native call so overlapping finishes share one native call, and restores it when the native finish fails. This binds finishing to the recovery flow and blocks arbitrary or accidental finish calls; it is not a trust boundary against code that controls the recovery backend object, where the server-side `recoverPurchase` verification remains the real control. — Thanks @imjlk!
- [686ea3ab](https://github.com/imjlk/mpgd-kit/commit/686ea3ab494b30d1ffd81fe0d2132e43239d940c) Bound per-player cloud-save keys in generated Devvit targets. The `phaser-game` template now ships `apps/target-devvit/src/server/bridge.ts`, mirroring the kit wrapper: `storage.save` tracks each player's distinct keys in a `<game-name>:save-keys:<user>` hash, enforces `maxStorageKeysPerPlayer` inside a WATCH/MULTI/EXEC transaction, and rejects saves past the cap with `DEVVIT_STORAGE_KEY_LIMIT`, so one authenticated Reddit account can no longer exhaust the installation's shared Redis quota.
  
  Detect aborted Devvit Redis transactions correctly. `@devvit/redis` `TxClient.exec()` never resolves `null` for a WATCH conflict; it returns an empty array. The template bridge and the kit wrapper now treat an EXEC result with fewer entries than the queued commands as contention and retry instead of reporting an unwritten save as persisted. `createDevvitRedisPostOperationStore` applies the same rule: in addition to `null`, any EXEC result shorter than the number of queued mutations is retried as contention. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.12.7, adapter-browser@0.7.8, adapter-capacitor@0.6.1, adapter-devvit@0.9.13, adapter-verse8@0.3.11, game-services@0.17.1

## 0.36.0 — 2026-09-28

### Minor changes

- [631776aa](https://github.com/imjlk/mpgd-kit/commit/631776aace5a04e698605598f7f8a03f0683d84c) Add verified Android App Bundle submission to the Google Play internal test track, bind immutable build records to the artifact's actual signing certificate, and fail closed on uncertain uploads and commits. — Thanks @imjlk!
- [2822dedb](https://github.com/imjlk/mpgd-kit/commit/2822dedbe0e789517b69c2fb18c94340275b78dd) Prepare isolated iOS signing sessions for existing Capacitor archive and App Store export builds, including temporary P12 keychain import, provisioning profile preflight and cleanup, and generated export options. — Thanks @imjlk!
- [581a62f5](https://github.com/imjlk/mpgd-kit/commit/581a62f57d3f4cdfe4ca5b1c798322d582a0edd2) Add game-owned native deployment profiles, local environment diagnostics, and read-only deployment planning commands. — Thanks @imjlk!
- [48ac0949](https://github.com/imjlk/mpgd-kit/commit/48ac0949fcb7779e39b882cc706ed1b7dcf7b9ae) Add explicit native test deployment run, status and submit commands that reserve platform versions, build signed game-owned shells in pinned workspaces, persist immutable build records and resume Google Play or TestFlight submissions from leased remote checkpoints. — Thanks @imjlk!
- [1aff27ad](https://github.com/imjlk/mpgd-kit/commit/1aff27ad3dea6feccf5916cfcfd0e19323438585) Prepare Git-revision-pinned native release workspaces, verify installed Kit provenance and build outputs, and execute bounded build steps with redacted logs and cancellation cleanup. — Thanks @imjlk!
- [0f8c4f2c](https://github.com/imjlk/mpgd-kit/commit/0f8c4f2c7b3c545825c8e368d18737ee0e31af5d) Submit previously verified iOS IPA builds to App Store Connect and link processed builds to an internal TestFlight group using the pinned asc binary. Reinspect the staged IPA signature and release identity before any store mutation. — Thanks @imjlk!
- [e62c4ac8](https://github.com/imjlk/mpgd-kit/commit/e62c4ac836009814053da8d5d3bcedf15b4329c1) Build game-owned Android and iOS Capacitor targets from an installed CLI without requiring an mpgd-kit checkout. Preserve Kit package provenance in native release manifests. — Thanks @imjlk!
- [22f539e2](https://github.com/imjlk/mpgd-kit/commit/22f539e22dddf46b2adf4b984b905e75e1e4191c) Prepare isolated Android upload-signing sessions with temporary keystore restoration, certificate and private-key preflight, and an opt-in Gradle signing init script for existing native builds. — Thanks @imjlk!
- [35ca0077](https://github.com/imjlk/mpgd-kit/commit/35ca007769bcf76731a93d7938366de4f4a71557) Scaffold game-owned GitHub Actions workflows for protected-branch native test deployments using the packaged CLI, scoped credentials, artifact restore, and lightweight PR validation. — Thanks @imjlk!
- [12acab76](https://github.com/imjlk/mpgd-kit/commit/12acab763fdd1fbd8320a109bf2988a34fb25059) Reserve native platform versions in a game-owned Git release-state branch and persist immutable, content-hashed native build records for deployment orchestration. — Thanks @imjlk!

### Patch changes

- [721f6f9c](https://github.com/imjlk/mpgd-kit/commit/721f6f9cde3901e727ba2f7f7d11e344739a02e8) Add `measureTargetViewport` and `waitForTargetViewportMeasurement` so a game that boots inside a zero-sized surface (a hidden iframe, a collapsed embed or a background tab) starts once the host lays it out instead of failing viewport validation, and use them in the generated game template. — Thanks @imjlk!
- [2eab696f](https://github.com/imjlk/mpgd-kit/commit/2eab696f01af86e5ded41439ffd988e7c82a812d) Show non-blocking target configuration advisories alongside Kit dependency upgrade plans, including missing platform product and ad placement identifiers. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.12.6, adapter-browser@0.7.7, adapter-capacitor@0.6.0, adapter-devvit@0.9.12, adapter-verse8@0.3.10, analytics@0.4.0, catalog@0.7.6, game-services@0.17.0, i18n@0.6.5, platform@0.14.0, target-config@0.17.0

## 0.35.0 — 2026-09-25

### Minor changes

- [f01f6061](https://github.com/imjlk/mpgd-kit/commit/f01f6061abaf38ec914b6694cb35ee9db4e7324d) Add a game-owned Kit dependency upgrade planner that resolves each public Kit
  package's npm latest tag, checks declared peer compatibility, and can update
  configured target manifests and pnpm lockfiles with rollback on failure. — Thanks @imjlk!

## 0.34.0 — 2026-09-25

### Minor changes

- [13cd18f4](https://github.com/imjlk/mpgd-kit/commit/13cd18f432ca28cc89fc9e4da9828a24f0922042) Add isolated native target staging, explicit signed archive and iOS store export
  modes, and fail-closed inspection of the emitted binary identity and signature.
  Native release manifests now distinguish smoke artifacts from submission
  candidates; signed builds still require game-owned host signing credentials. — Thanks @imjlk!
- [3e01a3e8](https://github.com/imjlk/mpgd-kit/commit/3e01a3e8688a017e84a09854d35ee1f081db6e1d) Add a non-destructive game-owned Capacitor shell initializer that plans Android
  and iOS shell configuration, release identity, icon and backend inputs before
  writing. It does not bundle provider SDKs or overwrite existing native projects. — Thanks @imjlk!

### Patch changes

- [bd7d0125](https://github.com/imjlk/mpgd-kit/commit/bd7d0125fc8201e17f92988c4ad177563e004175) Connect Capacitor app state, Android back navigation, and classified cold/warm
  URL entry to the platform lifecycle contract. Keep OAuth redirects separate
  from game links, own and dispose only registered listeners, and hold game
  execution while optional external provider UI is still active. Include the
  App plugin in generated native projects. — Thanks @imjlk!
- [f6e47baa](https://github.com/imjlk/mpgd-kit/commit/f6e47baa9c84aee3b3ea67bdba192bbeae2ba4af) Add optional Capacitor provider composition with per-method bridge validation and
  fail-closed readiness reporting. Distinguish uninstalled, unconfigured,
  action-required, transient, and available features without changing existing
  purchase result states. Expose subscription and native/remote leaderboard
  availability separately while preserving legacy target configuration defaults.
  Fix the base plugin's ESM-relative export so the published tarball can be
  imported by Node-based consumers and native build tooling.
  Keep generated starter target-availability checks aligned with the new readiness states. — Thanks @imjlk!
- [7a27b7f8](https://github.com/imjlk/mpgd-kit/commit/7a27b7f8b033ca987eefe859a702d0c08eba0800) Expose an optional Capacitor viewport state and change subscription with
  separate safe-area, system-bar, keyboard, and named occupied-surface geometry.
  Resolve one usable CSS-pixel rectangle without double-counting overlapping
  native or CSS insets, and convert provider-owned physical-pixel surfaces at
  the adapter boundary.
  Align newly scaffolded games with the SystemBars CSS safe-area fallback. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.12.5, adapter-browser@0.7.6, adapter-capacitor@0.5.0, adapter-devvit@0.9.11, adapter-verse8@0.3.9, analytics@0.3.15, bridge@0.10.0, catalog@0.7.5, game-services@0.16.0, i18n@0.6.4, platform@0.13.0, target-config@0.16.0

## 0.33.2 — 2026-09-24

### Patch changes

- [52026ee](https://github.com/imjlk/mpgd-kit/commit/52026eed535a6414a53f88fa8f5db496beac3e68) Use the host's Capacitor core as a peer dependency throughout the native plugin and adapter, and include it in generated game dependencies. Allow compatible Capacitor 8 Swift Package Manager versions instead of pinning the native plugin to 8.5.1. The reference mobile shell now resolves Capacitor 8.5.2 consistently across npm, Android, and iOS. — Thanks @imjlk!
- [87d32f6](https://github.com/imjlk/mpgd-kit/commit/87d32f6098ad4b416c355dd5d802a9f556d8529e) Use nonblocking POSIX reads for FIFO delivery manifests so a stalled writer cannot hold verification past its deadline. Bound the initial wait for a FIFO writer to one second, so an empty writer that disconnects between read polls is rejected as an invalid manifest instead of consuming the full verification budget. Keep FIFO smoke writers owned by their tests and verify both stalled and streamed cases. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.12.4, adapter-browser@0.7.5, adapter-capacitor@0.4.12, adapter-devvit@0.9.10, adapter-verse8@0.3.8, analytics@0.3.14, catalog@0.7.4, game-services@0.15.3, i18n@0.6.3, platform@0.12.2, target-config@0.15.2

## 0.33.1 — 2026-09-24

### Patch changes

- Updated dependencies: adapter-ait@0.12.3

## 0.33.0 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- [b4b77b3](https://github.com/imjlk/mpgd-kit/commit/b4b77b3e4ab08b330d8ca67de8b0023fe143910d) Update generated Apps in Toss projects to use the 3.5.0 WebView SDK and CLI, and remove the archived SDK 2-only `@ait-co/devtools` package from the starter target. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.12.2, adapter-browser@0.7.4, adapter-capacitor@0.4.11, adapter-devvit@0.9.9, adapter-verse8@0.3.7, analytics@0.3.13, bridge@0.9.1, catalog@0.7.3, game-services@0.15.2, i18n@0.6.2, phaser-assets@0.7.0, platform@0.12.1, target-config@0.15.1

## 0.32.0 — 2026-09-21

### Minor changes

- [66e572d](https://github.com/imjlk/mpgd-kit/commit/66e572dce7eb4a0bbbd097bf40a9ee47db44ec6b) Add `mpgd assets build-packs` for deterministic asset pack delivery builds.
  A JSON build config (image, spritesheet and JSON atlas assets with pack ids,
  logical revisions, dependencies and per-asset compression overrides) produces
  individual files or per-pack ZIP artifacts plus an external versioned delivery
  manifest: per-file media types, original bytes and SHA-256 digests, archive
  digests, entry methods and counts. ZIP v1 uses STORE/DEFLATE only with fixed
  metadata for reproducible bytes; pack artifacts are immutable per revision
  while the manifest tracks the latest successful build. The new
  `@mpgd/phaser-assets/pack-format` subpath publishes the shared pure contract
  (types, untrusted-input validation, entry path rules) free of Node, DOM, Phaser
  and compression concerns, and the CLI now depends on the package at runtime. — Thanks @imjlk!
- [20e3583](https://github.com/imjlk/mpgd-kit/commit/20e3583394671dcb46157364f8bbac6799ba0dd3) Add `mpgd assets verify-delivery`, a local read-only pre-deployment check
  for built asset pack artifacts: `--manifest <asset-pack-delivery.json>
  --root <artifact-directory>`. The command validates the manifest against
  the shared pack-format contract, resolves every referenced path under the
  root (rejecting absolute paths, traversal, symlinks and non-regular
  files), streams and SHA-256-verifies every referenced file, decodes each
  ZIP archive through the same pure core that powers runtime delivery
  (exposing a narrow `@mpgd/phaser-assets/archive-validation` entry), and
  optionally checks static-host object limits (`--max-object-bytes`,
  `--max-files`, `--max-total-bytes`) against the full root inventory —
  distinguishing referenced integrity from deployment budget — and caps the
  largest archive it will read with `--max-archive-bytes` (512 MiB by
  default) plus decompression bounds `--max-entry-bytes` (256 MiB) and
  `--max-expanded-bytes` (1 GiB) that are independent of the manifest's own
  declared sizes, failing in the limits stage before reading or decoding
  oversized declarations. Reports carry
  per-stage failure codes; `--json` emits stdout as exactly one
  machine-readable JSON document (parseable with JSON.parse(stdout), no
  banner) on success and failure alike, framework argument errors move to
  stderr, and failures exit non-zero. The check never
  modifies inputs, extracts archives, or contacts a network. — Thanks @imjlk!

### Patch changes

- Updated dependencies: phaser-assets@0.6.0

## 0.31.0 — 2026-09-14

### Patch changes

- Updated dependencies: phaser-assets@0.5.0

## 0.30.1 — 2026-09-13

### Patch changes

- Updated dependencies: adapter-devvit@0.9.8, adapter-verse8@0.3.6, game-services@0.15.1

## 0.30.0 — 2026-09-13

### Fixed

- [d809efa](https://github.com/imjlk/mpgd-kit/commit/d809efad33722a2cba5d5f8d74b62313ad046be7) Preserve user-facing command summaries, instructions and diagnostic output in compiled CLI builds. Route those messages through the informational console level so debug stripping does not silently remove them, and verify compiled/source kit-doctor output.
  
  Make repeated offline-playtest packages byte-stable by minifying identifiers after random deferred asset markers are resolved. Keep collision-resistant markers, asset validation, tree shaking and network restrictions intact.
  
  Restore offline inlining for assets assigned to native elements created with document.createElement, accounting for the code mask retaining a string literal opening quote while preserving native-receiver and static-argument checks.
  
  Remove only evidence files or symbolic links when cleaning failed Microsoft Store acceptance output. This avoids leaving stale reports when a directory link causes non-recursive rmSync to fail, while preserving the linked target.
  
  Resolve the existing game root canonically before deriving managed Microsoft Store script paths, so initialization through a linked parent remains idempotent with game creation. — Thanks @imjlk!

### Minor changes

- [4f8c816](https://github.com/imjlk/mpgd-kit/commit/4f8c8161d05a6e01cf6d7e5483c6f6783b87222d) Add opt-in platform version allocation policies and a read-only preview
  command.
  
  `@mpgd/target-config` gains `allocatePlatformVersions`,
  `assertPlatformVersionLedger`, and `formatHostedPwaShellVersions`: pure
  computations that separate the game SemVer, the shared release revision
  label, Android/iOS upload counters, and the Microsoft Store numbers — either
  the legacy independent four-part policy or the opt-in
  `hosted-pwa-shell-revision-v1` schema where one shell revision derives both
  package numbers (`2.0.<r>.0` / `1.0.<r>.0`, third component bounded to
  65535). Existing immutable plans are revalidated and reused without
  consuming numbers; provenance changes allocate the next revision instead of
  mutating a plan; hosted-content-only Store work consumes no Store number.
  Inputs are validated up front (final SemVer, full Git SHAs, SHA-256 config
  digests, counter ceilings including the documented Android maximum of
  2100000000), and failures never partially update inputs. Results are
  candidates, not reservations.
  
  `mpgd target preview-versions` previews a ledger allocation as JSON or a
  human summary, exits non-zero on validation failure, and never modifies its
  input files. Ledger schema 1 is rejected rather than auto-migrated, and
  unknown version policies fail instead of falling back to a default. — Thanks @imjlk!

### Patch changes

- [c3a1bc3](https://github.com/imjlk/mpgd-kit/commit/c3a1bc37f44e6dbf2fc21ffd9306e154f8fe7c3b) Fix two correctness bugs in the hosted PWA deployment verifier's
  `mpgd target verify-deployment` reference scan:
  
  - External stylesheet checking never ran: the url()/@import pass iterated
    the normalized reference set before it was populated. Reference
    collection, normalization, stylesheet scanning, and the final existence
    check now run in that order, and chained `@import` files are followed
    with a visited set so circular imports terminate.
  - `srcset` extraction re-scanned the raw attribute string and could read
    `srcset`-looking text out of unrelated attribute values such as
    `title='See srcset="./missing.png"'`, rejecting valid deployments.
    Attributes are now tokenized once per start tag and every attribute-
    driven check (resource names, srcset, style, srcdoc, meta refresh)
    shares that single parse, including the iframe srcdoc override guard.
  
  Both regressions are covered by deployment smoke tests, including a
  passing control case proving the failure comes from the stylesheet
  reference check rather than stale release evidence. — Thanks @imjlk!
- Updated dependencies: adapter-devvit@0.9.7, adapter-verse8@0.3.5, game-services@0.15.0, target-config@0.15.0

## 0.29.0 — 2026-09-12

### Minor changes

- [6b3d3c6](https://github.com/imjlk/mpgd-kit/commit/6b3d3c62cb4e1c1a585291d8b2d10f71e2a8500a) Add `mpgd target verify-deployment` for hosted Cloudflare Pages PWA
  deployments. The command verifies that a deployment directory serves an
  already-verified PWA artifact unchanged: every source file must exist with an
  identical sha256 digest, the release evidence revision must recompute from
  the real bytes, unrecognized files are rejected as cross-build contamination,
  `_routes.json` must match one of the reviewed routing profiles
  (`api-only` or `api-canonical-index`), and `_headers`/`_redirects` are parsed
  and evaluated under the documented Cloudflare semantics (matching blocks apply
  in order, duplicate headers comma-join, `!` removals clear the header) to
  enforce the reviewed cache policy. Verification is read-only, writes JSON and
  Markdown evidence, and exits non-zero on failure. PWA release primitives moved
  from repo tooling into the package so the command works without a kit checkout. — Thanks @imjlk!
- [56dea12](https://github.com/imjlk/mpgd-kit/commit/56dea1260706a00ee2e641eba6663597c958e74a) Generated Phaser games now disable text selection game-wide by default.
  `mpgd.game.json` accepts a `ui.textSelection` setting (`'disabled'` default or
  `'enabled'` to restore the browser default), validated with the rest of the
  game config at build time. Input fields, textareas, and contenteditable
  elements remain selectable, and `markSelectable`/`unmarkSelectable` utilities
  re-enable selection for individual UI elements. — Thanks @imjlk!

### Patch changes

- Updated dependencies: i18n@0.6.1, target-config@0.14.1

## 0.28.1 — 2026-09-03

### Patch changes

- Updated dependencies: adapter-capacitor@0.4.10

## 0.28.0 — 2026-09-02

### Minor changes

- [95dde6f](https://github.com/imjlk/mpgd-kit/commit/95dde6f4f56a82c7d62d4e618e62f0bc1a309883) Add experimental WeChat Mini Game Canvas staging artifacts, static evidence and package-budget checks, and explicit production validation gates. — Thanks @imjlk!
- [916f648](https://github.com/imjlk/mpgd-kit/commit/916f648d113c975f8a2bf7074deb38d9506ce014) Add experimental WeChat and TikTok native mini-game target contracts, shared runtime classification, and notification target validation. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.12.1, adapter-browser@0.7.3, adapter-capacitor@0.4.9, adapter-devvit@0.9.6, adapter-verse8@0.3.4, analytics@0.3.12, catalog@0.7.2, game-services@0.14.0, i18n@0.6.0, platform@0.12.0, target-config@0.14.0

## 0.27.0 — 2026-08-29

### Minor changes

- [c1c39a2](https://github.com/imjlk/mpgd-kit/commit/c1c39a2aaaefcde6a2a04e5ae06c784df07d0fce) Preserve provider-neutral platform operation codes and retry hints across adapter boundaries. Apps in Toss now uses the current anonymous identity API, coalesces concurrent identity reads for one wrapper session, retries a rejected identity read after the host recovers, and gives generated games an explicit native Sandbox wrapper command without local SDK or identity mocks. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.12.0, adapter-browser@0.7.2, adapter-capacitor@0.4.8, adapter-devvit@0.9.5, adapter-verse8@0.3.3, analytics@0.3.11, catalog@0.7.1, game-services@0.13.1, i18n@0.5.7, platform@0.11.0, target-config@0.13.1

## 0.26.0 — 2026-08-27

### Patch changes

- Updated dependencies: adapter-devvit@0.9.4, adapter-verse8@0.3.2, game-services@0.13.0

## 0.25.0 — 2026-08-27

### Patch changes

- [8948cae](https://github.com/imjlk/mpgd-kit/commit/8948caee3600be457c4662ffab9947abfdb60685) Bridge the official Apps in Toss `SafeArea.get()` and `SafeArea.subscribe()` values into shared CSS custom properties, including a transparent-navigation content boundary, and install the bridge in generated AIT wrappers. — Thanks @imjlk!
- [4e92350](https://github.com/imjlk/mpgd-kit/commit/4e92350c4cf29d71c2a73aa164f814ef8ecd1c50) Add a preview-only Devvit view-mode contract and make generated games load Phaser only from the Expanded Mode entry by default. The existing inline-gameplay contract remains available as an explicit opt-in. — Thanks @imjlk!
- Updated dependencies: adapter-ait@0.11.0, adapter-devvit@0.9.3

## 0.24.1 — 2026-08-26

### Changed

- [d49be5b](https://github.com/imjlk/mpgd-kit/commit/d49be5b890f0a7058487f5763d2acc0433ac2b39) Align the Devvit adapter, generated target, and starter template on Devvit 0.14.1. Generated targets pin Vite 7.3.6 for compatibility with the current Devvit Vite plugin. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-devvit@0.9.2

## 0.24.0 — 2026-08-26

### Added

- [938e934](https://github.com/imjlk/mpgd-kit/commit/938e934bb53c3d18fda7c50da7e736fe6ccda351) Update generated Apps in Toss games to SDK/CLI 3.1.1 and support the SDK 3
  `navigationBar.withTitle` option in target validation. New starters hide the title and app icon when
  using transparent navigation, mirror the kit XML parser resolution policy, and document both legacy
  and replacement SDK 3 WebView origins. — Thanks @imjlk!

### Changed

- [17cbec9](https://github.com/imjlk/mpgd-kit/commit/17cbec9de406aae06949b1c9df832f3ae0446b95) Add provider-neutral inline banner placements and surface lifecycle methods. Apps in Toss hosts now
  initialize and attach Toss banner ads by game-owned surface ID, report rendered/no-fill/failure
  states, and destroy active attachments on unmount. Target configuration, effective artifacts,
  starter validation, and bridge contracts understand optional `bannerAds` capability flags while
  remaining compatible with previously published adapters and target matrices. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.10.0, adapter-browser@0.7.1, adapter-capacitor@0.4.7, adapter-devvit@0.9.1, adapter-verse8@0.3.1, analytics@0.3.10, bridge@0.9.0, catalog@0.7.0, game-services@0.12.1, i18n@0.5.6, platform@0.10.0, target-config@0.13.0

## 0.23.0 — 2026-08-21

### Patch changes

- Updated dependencies: adapter-browser@0.7.0

## 0.22.1 — 2026-08-13

### Changed

- [a70be9d](https://github.com/imjlk/mpgd-kit/commit/a70be9d5c8542eb87191ef3e82a4fc09a9d02eff) Keep generated game documentation focused on downstream target builds while the kit documentation separates single-game repositories, multi-game workspaces, and contributor-only reference fixtures. — Thanks @imjlk!

## 0.22.0 — 2026-08-12

### Added

- [fda83d0](https://github.com/imjlk/mpgd-kit/commit/fda83d01cc4b9ac2f62c646425c976de9720eddd) Add a test-only, direct-file offline playtest packager for existing web-preview artifacts.
  Generated Apps in Toss wrappers now use the available stable 3.0.2 framework and CLI packages,
  with a narrow pnpm peer allowance for the tested devtools integration. — Thanks @imjlk!
- [949dc45](https://github.com/imjlk/mpgd-kit/commit/949dc45be7ec60d4961bf26cc8cc0d0bf400c9ee) Add opt-in Apps in Toss IAP authority hooks, partner API contracts, and stable SDK 3 target support. — Thanks @imjlk!
- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!
- [8ca5064](https://github.com/imjlk/mpgd-kit/commit/8ca50644c67f54d6d8663d6aeb8add1e1d7d10bd) Allow Apps in Toss targets to configure validated navigation bar appearance, including transparent game chrome, from `mpgd.targets.json`. — Thanks @imjlk!

### Fixed

- [43a1936](https://github.com/imjlk/mpgd-kit/commit/43a19368ada63fbab2ce3c4079c28e697af2448b) Bound the generated Phaser starter's ttsc unplugin to Vite's public plugin type so monorepo typechecks do not exceed TypeScript's recursive comparison depth. — Thanks @imjlk!
- [9cc3538](https://github.com/imjlk/mpgd-kit/commit/9cc3538f61ecc8ed976118bc5c6544ebf1a24492) Pin generated Phaser starters to the verified Vite version so fresh installs do not resolve a patch release that exceeds TypeScript 7's recursive plugin-type comparison depth. — Thanks @imjlk!
- [70f7a95](https://github.com/imjlk/mpgd-kit/commit/70f7a955df00f913aff52088426921b48005336c) Render an accessible fallback instead of leaving generated Phaser game documents blank when a dynamic platform or gameplay entry module fails to load. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.9.0, adapter-browser@0.6.0, adapter-capacitor@0.4.6, adapter-devvit@0.9.0, adapter-verse8@0.3.0, analytics@0.3.9, bridge@0.8.0, catalog@0.6.0, game-services@0.12.0, i18n@0.5.5, platform@0.9.0, target-config@0.12.0

## 0.21.0 — 2026-08-08

### Added

- [c6f1ad2](https://github.com/imjlk/mpgd-kit/commit/c6f1ad2d293c4d75091c4a414a3df0433837d16d) Support deployed generic web runtimes with game-owned platform integrations — Thanks @imjlk!

### Patch changes

- Updated dependencies: target-config@0.11.0

## 0.20.1 — 2026-08-04

### Changed

- [6ae2720](https://github.com/imjlk/mpgd-kit/commit/6ae27206b4aaae601c7feaa4ca7946b7cad5c654) Allow safe game-owned `kind: "web"` target names in build, smoke, and matrix CLI workflows while preserving the existing browser and web aliases. Support additive game-owned target-config policies at build time and runtime, monetization identifiers, authoritative purchase and reward verification for custom deployments, verified non-installable browser artifacts, and bounded static web artifact overlays for custom browser deployments while reserving platform-specific PWA policy for its canonical target. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-devvit@0.8.6, adapter-verse8@0.2.3, catalog@0.5.2, game-services@0.11.1, target-config@0.10.1

## 0.20.0 — 2026-08-01

### Fixed

- [93221ea](https://github.com/imjlk/mpgd-kit/commit/93221eacd9990903d09ed11e4b63db7766a4b879) Route generated starter rewarded-ad flows through the authoritative game-services claim before presenting a granted reward. — Thanks @imjlk!

### Changed

- [e15d272](https://github.com/imjlk/mpgd-kit/commit/e15d272332d2c9db0a25ca32777f4f2a4f161157) Add a safe-area viewport snapshot for Phaser HUD layout and make generated game
  documents opt into `viewport-fit=cover` with reusable safe-area CSS variables.
  Register the single-reservation contract in generated agent manifests, briefs,
  and acceptance guidance so downstream games do not apply safe-area insets twice. — Thanks @imjlk!

### Patch changes

- Updated dependencies: target-config@0.10.0

## 0.19.0 — 2026-07-27

### Fixed

- [fb87690](https://github.com/imjlk/mpgd-kit/commit/fb876906f06d46b7692f9c236b02fb2ff0b2ce8e) Require `APP_VERSION` to match native Android and iOS release identities and
  validate the effective release configuration before packaging. — Thanks @imjlk!

## 0.18.0 — 2026-07-23

### Patch changes

- Updated dependencies: adapter-ait@0.8.0, adapter-browser@0.5.1, adapter-capacitor@0.4.5, adapter-devvit@0.8.5, adapter-verse8@0.2.2, analytics@0.3.8, bridge@0.7.0, catalog@0.5.1, game-services@0.11.0, i18n@0.5.4, platform@0.8.0, target-config@0.9.1

## 0.17.0 — 2026-07-22

### Changed

- [31655f0](https://github.com/imjlk/mpgd-kit/commit/31655f03b92ec6d59f43cde08f1d5dca5b9b9436) Migrate Apps in Toss adapters and generated game wrappers to the SDK 3 beta
  contract, including the new configuration file, package-script build flow,
  SDK 3 target metadata, and release CORS/rollback guidance. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.7.0

## 0.16.1 — 2026-07-20

### Changed

- [f890f96](https://github.com/imjlk/mpgd-kit/commit/f890f963d199a8db1d894dfbc23b123efa099709) Update generated Apps in Toss wrappers to @ait-co/devtools 0.1.140 and preserve its
  official SDK mock when Vite prebundles the Kit adapter. — Thanks @imjlk!

## 0.16.0 — 2026-07-20

### Patch changes

- Updated dependencies: adapter-ait@0.6.0

## 0.15.2 — 2026-07-20

### Patch changes

- Updated dependencies: adapter-ait@0.5.2

## 0.15.1 — 2026-07-20

### Patch changes

- Updated dependencies: adapter-ait@0.5.1

## 0.15.0 — 2026-07-20

### Added

- [dede158](https://github.com/imjlk/mpgd-kit/commit/dede158e343b1fa8494e3d28ae52a2f0a0b89a16) Add explicit Microsoft Store starter selection, conflict-safe idempotent target
  initialization, and generated agent workflow documentation and skills for
  discovering and validating mpgd-kit capabilities. — Thanks @imjlk!
- [5c39d37](https://github.com/imjlk/mpgd-kit/commit/5c39d376db59231d35740525f5cf85e4c7dd2df0) Add a reusable Apps in Toss production host bridge backed by the official game identity,
  Storage, Ads 2.0, sharing, lifecycle, and Game Center APIs. Rewarded ads load before display and
  forward callback evidence without issuing demo grants, while commerce stays fail-closed until a
  game installs its own verified purchase flow.
  
  Allow game targets to opt out of authoritative game services. Opted-out targets disable IAP and
  ad features in their effective configuration and no longer require a production backend URL,
  while targets that enable authoritative grants keep the public HTTPS backend release gate.
  
  Scaffold each generated game with its own Apps in Toss wrapper, Granite configuration, and
  `@ait-co/devtools` workflow. The wrapper reuses the adapter's exported bundle loader while
  keeping app identity, console state, icons, and review metadata owned by the game repository.
  Expose a shared AIT ad-placement extractor for wrapper builds, preserve configuration parse
  causes, and publish package metadata that the official `.ait` dependency collector can resolve
  from both installed packages and Kit workspaces. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.5.0, target-config@0.9.0

## 0.14.0 — 2026-07-19

### Added

- [dd2ad0c](https://github.com/imjlk/mpgd-kit/commit/dd2ad0cd4c2cffad32e3b38b50d3ab3b15daaefc) Add Windows package acceptance that verifies MSIX and AppX identity against submission evidence, records package hashes, and can optionally run the recommended Windows App Certification Kit check with report hashing. — Thanks @imjlk!
- [3b6e93a](https://github.com/imjlk/mpgd-kit/commit/3b6e93a025162253026f5a68cbb61e731177f60b) Add guarded Microsoft Store PWA package generation with scope-bound pinned manifests, public-only DNS-pinned downloads, local and deployed icon integrity checks, ZIP safety, transactional evidence, and provenance records. — Thanks @imjlk!
- [2c5046a](https://github.com/imjlk/mpgd-kit/commit/2c5046af170f7a31ab93c3f7d3ddb7dee94634ce) Add a game-owned Microsoft Store submission preflight that validates Partner Center identity, listing, privacy, age-rating, commerce, PWA manifest, and screenshot evidence. — Thanks @imjlk!

## 0.13.0 — 2026-07-17

### Patch changes

- Updated dependencies: adapter-devvit@0.8.4, adapter-verse8@0.2.1, game-services@0.10.0

## 0.12.0 — 2026-07-17

### Changed

- [f3ea335](https://github.com/imjlk/mpgd-kit/commit/f3ea335773e7e0812a65866800789cac0d85a34b) Add opt-in Verse8 Agent8 authenticated-encrypted cloud storage and a server-verified leaderboard provider with authenticated participant scoping, game-specific verification, server-secret-keyed persistence markers, and bounded opaque cursor pagination while keeping the generic native leaderboard disabled. — Thanks @imjlk!
- [0e7b585](https://github.com/imjlk/mpgd-kit/commit/0e7b585060a4f9cb39d4cd031d8b233090873644) Add generated Agent8 structured-server acceptance guidance and a CI smoke harness that exercises authenticated verified leaderboard submissions, scoped snapshots, effective Verse8 target configuration, and secret-free starter output. — Thanks @imjlk!

### Fixed

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!

### Added

- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.4, adapter-browser@0.5.0, adapter-capacitor@0.4.4, adapter-devvit@0.8.3, adapter-verse8@0.2.0, analytics@0.3.7, bridge@0.6.1, catalog@0.5.0, game-services@0.9.0, i18n@0.5.3, platform@0.7.0, target-config@0.8.0

## 0.11.0 — 2026-07-15

### Added

- [61f208f](https://github.com/imjlk/mpgd-kit/commit/61f208fa4c38df57ffd75e052913ac4d1b4cfe66) Add a reusable Playwright-compatible browser Gameplay E2E driver that shares normalized input and screenshot handling while keeping lifecycle and game-state inspection hooks consumer-owned. — Thanks @imjlk!
- [59640c1](https://github.com/imjlk/mpgd-kit/commit/59640c17c4189ae7f5550e3e7d23975dd9b99217) Add Playwright-compatible Microsoft Store PWA helpers for reading release evidence, requesting service worker updates, resolving deployment-scoped caches, and verifying atomic A-to-B cache transitions. — Thanks @imjlk!

### Fixed

- [8934ce1](https://github.com/imjlk/mpgd-kit/commit/8934ce1cb5c00a085ce59ea5c12f0813aad32c26) Share bounded evidence reads, path display normalization, Markdown formatting, error formatting, and deterministic JSON and Markdown report writes across CLI verification workflows. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-devvit@0.8.2, game-services@0.8.2

## 0.10.1 — 2026-07-15

### Patch changes

- Updated dependencies: adapter-devvit@0.8.1, game-services@0.8.1

## 0.10.0 — 2026-07-15

### Added

- [7d1108e](https://github.com/imjlk/mpgd-kit/commit/7d1108ef1d81262b5a707af6f7e57289b6c5f2b3) Add conservatively indexed durable Devvit post operations and scope-bound cursor
  pagination for bounded recovery workers. Stable registry membership is created
  before durable state and retained across every transition, preventing live work
  from disappearing through partial cross-key updates. Discovery remains read-only
  and keeps attempted and terminal outcomes fail-closed instead of restoring submit
  permission. Exact operation reads and transitions lazily backfill stable registry
  membership for durable records created before indexed discovery was enabled.
  Best-effort read backfills use the stored descriptor even on conflicts and never
  mask an already-readable durable result, while state mutations still require
  registry membership first. — Thanks @imjlk!
- [956b93c](https://github.com/imjlk/mpgd-kit/commit/956b93c28ca46899fb3acfda79d1abda072fdb4c) Add a manifest-driven target gameplay E2E contract with strict plan parsing,
  normalized input actions, fail-safe pause and resume handling, session
  continuity checks, per-state screenshots, and hashed plan, artifact, and release
  evidence. Game-owned automation drivers remain optional and outside Phaser
  scenes; when a `gameplay:e2e` script is configured, `mpgd game accept` now runs
  it after target smoke and requires a passing standard report for handoff. — Thanks @imjlk!

### Fixed

- [e4a89d7](https://github.com/imjlk/mpgd-kit/commit/e4a89d7d7788e7b103a17bbefc5389534c1e7b32) Stop advertising a native Devvit leaderboard and disable the generic client
  score submission path in both the shared target and generated starters. Devvit
  games continue to use the server-only verified leaderboard provider from
  authoritative completion handlers. — Thanks @imjlk!

### Changed

- [cddcba8](https://github.com/imjlk/mpgd-kit/commit/cddcba899e912b28e18fdca3b1520cbda992ccd7) Add an official-terminology Devvit view mode API with a concurrency-safe,
  retryable inline mode gameplay loader. Generated Phaser starters now keep their
  initial launch screen lightweight, start gameplay inside the post after an
  explicit click, and retain the separate expanded mode game entry. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.3, adapter-browser@0.4.3, adapter-capacitor@0.4.3, adapter-devvit@0.8.0, analytics@0.3.6, catalog@0.4.0, game-services@0.8.0, i18n@0.5.2, platform@0.6.0, target-config@0.7.0

## 0.9.0 — 2026-07-14

### Removed

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Upgrade generated Devvit targets to the stable 0.13.8 toolchain and remove the
  deprecated JSON fetch bridge API, JSON route, pre-namespace storage fallback,
  and split build strategy so Devvit targets use oRPC and the official Vite plugin
  exclusively. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-devvit@0.7.0, game-services@0.7.0

## 0.8.0 — 2026-07-14

### Added

- [2f06373](https://github.com/imjlk/mpgd-kit/commit/2f063737d518a19d93de0781bf44582c0a0bc78b) Add an opt-in official Devvit Vite build strategy for generated Phaser games,
  upgrade Devvit packages to 0.13.7, expose a direct oRPC Node HTTP bridge
  adapter, and remove the generated target's Express-based request conversion. — Thanks @imjlk!

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.2, adapter-browser@0.4.2, adapter-capacitor@0.4.2, adapter-devvit@0.6.0, analytics@0.3.5, bridge@0.6.0, catalog@0.3.5, game-services@0.6.0, i18n@0.5.1, phaser-assets@0.4.1, platform@0.5.1, target-config@0.6.1

## 0.7.0 — 2026-07-13

### Added

- [fd32478](https://github.com/imjlk/mpgd-kit/commit/fd3247854df451008b7c42d619977d8a09999ad2) Fail closed before production AIT, Android, and iOS builds unless the target uses a game-owned wrapper or shell and a public HTTPS game-services endpoint. — Thanks @imjlk!
- [fdacd52](https://github.com/imjlk/mpgd-kit/commit/fdacd52c510f09ea8723c1665e729515b64817a7) Add a single-source PNG/SVG app icon pipeline with versioned target profiles, per-target overrides, generated-game CLI commands, automatic target staging, and digest-linked release evidence. — Thanks @imjlk!
- [2a60e46](https://github.com/imjlk/mpgd-kit/commit/2a60e4688f5d15e2740c9219476a006eaf6f3ae7) Generate target-isolated platform gateway entrypoints so production bundles include only the selected platform adapter. — Thanks @imjlk!
- [420ad8f](https://github.com/imjlk/mpgd-kit/commit/420ad8fb5b54e4aa6b049aa5a220a2294ef4f2f6) Generate deterministic Microsoft Store PWA release evidence, atomic offline updates, and target-aware service worker registration in Phaser game starters. — Thanks @imjlk!
- [74bd3cc](https://github.com/imjlk/mpgd-kit/commit/74bd3cc38b769d3ee8622938815c0e8624d29b38) Add `mpgd game accept` for reusable check, test, build, graph, playtest, target-matrix, and JSON/Markdown handoff reporting. — Thanks @imjlk!

### Changed

- [5a4f259](https://github.com/imjlk/mpgd-kit/commit/5a4f259ff196db50f5bd53cbd4e9f91bae9b2bd5) Add a duplicate-safe, ambiguity-safe Devvit custom-post operation coordinator and include its Redis-backed server wrapper in generated starters. — Thanks @imjlk!
- [2f51b58](https://github.com/imjlk/mpgd-kit/commit/2f51b580aa5057d0d18e1820b1ed5b9d50d86d7e) Add reusable Devvit web-surface routing and generate physically separate lightweight inline and expanded Phaser entries. — Thanks @imjlk!
- [5fb3dca](https://github.com/imjlk/mpgd-kit/commit/5fb3dcaf9a6bc491a650221058595e505a725466) Merge target-specific integration overrides into effective target configuration and wire generated game runtimes to enforce the merged availability and presentation-mode contract. — Thanks @imjlk!
- [fd25ffe](https://github.com/imjlk/mpgd-kit/commit/fd25ffec5041036288c5aa4b10bd8ab5114b0499) Add a shared Game Services runtime factory that disables production clients without an authoritative backend URL and permits process-local backends only through explicit non-production opt-in. — Thanks @imjlk!

### Fixed

- [bfbcfaa](https://github.com/imjlk/mpgd-kit/commit/bfbcfaafd1f929962ca951e1e87cd5107212613a) Reject malformed app-icon options, clear stale Android monochrome resources during staging, and complete synthesized Microsoft Store PWA manifests. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.1, adapter-browser@0.4.1, adapter-capacitor@0.4.1, adapter-devvit@0.5.0, analytics@0.3.4, catalog@0.3.4, game-services@0.5.0, i18n@0.5.0, platform@0.5.0, target-config@0.6.0

## 0.6.0 — 2026-07-11

### Fixed

- [68c3d28](https://github.com/imjlk/mpgd-kit/commit/68c3d28b14508e32ddfd0fd3c5f3ed8147d4b40f) Resolve game-owned product catalogs, ad placements, package versions, and source revisions from the target config location so direct CLI builds match workspace wrapper builds. — Thanks @imjlk!

### Added

- [e15576b](https://github.com/imjlk/mpgd-kit/commit/e15576b36b2f2e01ae5a02b5bbbd2f9a5e180d71) Teach generated Phaser starters to resolve identity sessions and launch intents with legacy-host fallbacks and include readiness-accurate Devvit bridge responses. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.4.0, adapter-browser@0.4.0, adapter-capacitor@0.4.0, adapter-devvit@0.4.0, analytics@0.3.3, bridge@0.5.0, catalog@0.3.3, game-services@0.4.0, i18n@0.4.1, platform@0.4.0, target-config@0.5.0

## 0.5.0 — 2026-07-10

### Changed

- [dd4378f](https://github.com/imjlk/mpgd-kit/commit/dd4378f3fec3b66114a0ce661741f16736614206) Validate generated Phaser game orientation guidance and include the orientation-policy block in generated agent metadata. — Thanks @imjlk!

### Added

- [53f4e59](https://github.com/imjlk/mpgd-kit/commit/53f4e59ab9f2f82545981f4c19df6ff582378e86) Add viewport orientation policy planning and starter guidance. — Thanks @imjlk!

### Patch changes

- Updated dependencies: i18n@0.4.0, target-config@0.4.0

## 0.4.1 — 2026-07-09

### Added

- [fcb9501](https://github.com/imjlk/mpgd-kit/commit/fcb950101e70315d7c96e60f717b197082e416c2) Add target viewport breakpoint helpers and generated Phaser starter guidance for compact, medium, expanded, portrait, landscape, and Devvit embedded-webview layouts. The Phaser starter now measures the game container first and uses target viewport recommendations for control/panel placement. — Thanks @imjlk!

### Patch changes

- Updated dependencies: i18n@0.3.3, target-config@0.3.4

## 0.4.0 — 2026-07-08

### Fixed

- [33f2598](https://github.com/imjlk/mpgd-kit/commit/33f259881be5932e3f155dfc17c3b75f6f78da09) Copy iOS sync target artifacts into the game release-output directory before writing the release manifest, including local Swift package dependencies inside the advertised artifact root. — Thanks @imjlk!
- [d7d241b](https://github.com/imjlk/mpgd-kit/commit/d7d241bab37570c244cd2adfd08fe1735f7347c4) Render generated Phaser starter package manifests with per-package `@mpgd/*`
  versions so release automation can publish packages independently. — Thanks @imjlk!
- [33f2598](https://github.com/imjlk/mpgd-kit/commit/33f259881be5932e3f155dfc17c3b75f6f78da09) Keep AIT wrapper smoke artifacts game-owned, copy wrapper build output for skip-package smoke, and add target doctor ownership validation. — Thanks @imjlk!
- [acfa5f0](https://github.com/imjlk/mpgd-kit/commit/acfa5f0ea81fd179b9206c7baf500d0897cb025a) Preserve generated Devvit target bridge raw request body headers and align leaderboard lock expiration with the millisecond TTL. — Thanks @imjlk!

### Added

- [3069720](https://github.com/imjlk/mpgd-kit/commit/30697204ac97a7afe7bfce52982b31dd72c9f0a9) Add Apps in Toss starter scripts and docs for target-aware local development,
  AIT target build/smoke shortcuts, and the kit reference wrapper's community
  devtools flow. — Thanks @imjlk!
- [e8bdb67](https://github.com/imjlk/mpgd-kit/commit/e8bdb67ee6d086d890f00c453117595a0f6f6327) Add the Apps in Toss community Web API polyfill to generated Phaser starters
  and document the permission-aware AIT standard Web API flow. — Thanks @imjlk!
- [bb96043](https://github.com/imjlk/mpgd-kit/commit/bb96043a56aa7777a3d15028f7e3c68976504637) Add a Microsoft Store PWA target that reuses the browser adapter, ships effective target config and web app manifest metadata, and is available from generated Phaser game target builds while keeping matrix defaults compatible with older target files. — Thanks @imjlk!
- [11e5573](https://github.com/imjlk/mpgd-kit/commit/11e5573be744d61348cb0e502fc60e26bf34eec8) Add a Cloudflare Pages advanced-mode host helper for bridge JSON, bridge oRPC,
  optional game-services service binding proxy, and static asset fallback, plus
  generated Phaser game legal/support/terms HTML sources with `mpgd legal
  build/check` and a TypeScript Pages host that bundles to `_worker.js`. — Thanks @imjlk!
- [b5f9345](https://github.com/imjlk/mpgd-kit/commit/b5f93450062a4e347eb62e59700e5a2d2013ee03) Add Apps in Toss community console CLI scripts and docs to generated Phaser
  starters for project-local console login, app initialization, registration,
  status, package builds, and deploy automation. — Thanks @imjlk!

### Changed

- [33f2598](https://github.com/imjlk/mpgd-kit/commit/33f259881be5932e3f155dfc17c3b75f6f78da09) Generate Phaser starters with the public phaser-assets manifest loader, Vite-emitted starter assets, workspace-root install guidance, and a pnpm workspace root directory entry. — Thanks @imjlk!
- [f3bf2dd](https://github.com/imjlk/mpgd-kit/commit/f3bf2ddd7dc9e1a874e55a80fe3182308fd018c0) Add optional target release metadata plumbing so Apps in Toss builds can pass
  game-specific app names into Granite config, AIT artifact names, and release
  manifest entries. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-ait@0.3.3, adapter-capacitor@0.3.3, adapter-devvit@0.3.3, bridge@0.4.0, game-services@0.3.3, phaser-assets@0.4.0, target-config@0.3.3

## 0.3.2 — 2026-07-06

### Changed

- [80d35a2](https://github.com/imjlk/mpgd-kit/commit/80d35a2749094424c2d131c0ff1ba9fdae535714) Split generated Devvit init commands into browser-auth default and copy-paste fallback. — Thanks @imjlk!

## 0.3.1 — 2026-07-06

### Fixed

- [fd54514](https://github.com/imjlk/mpgd-kit/commit/fd545149b93c0aabfaed609b00ee433c7b951602) Sort generated Phaser starter catalog imports so `ttsc` checks pass immediately after game creation. — Thanks @imjlk!

## 0.3.0 — 2026-07-06

### Changed

- [12fb9df](https://github.com/imjlk/mpgd-kit/commit/12fb9dfe5b50a29f216538133f82e132651fcf07) Generate game-owned Devvit app roots in Phaser starters and derive starter
  `@mpgd/*` dependency pins from the released CLI package version. — Thanks @imjlk!

## 0.2.0 — 2026-07-06

### Added

- [0766fba](https://github.com/imjlk/mpgd-kit/commit/0766fbaa92381bc127ea7a8605ee1440884a79d9) Add a public Gunshi CLI for Phaser starter generation and target build/smoke orchestration, plus a create-package wrapper for `npm create @mpgd/game` style project bootstrapping. — Thanks @imjlk!

