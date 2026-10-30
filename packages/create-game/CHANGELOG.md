# @mpgd/create-game

## 0.66.0 — 2026-10-30

### Patch changes

- Updated dependencies: @mpgd/cli@0.67.0

## 0.65.0 — 2026-10-29

### Patch changes

- Updated dependencies: @mpgd/cli@0.66.0

## 0.64.0 — 2026-10-28

### Patch changes

- Updated dependencies: @mpgd/cli@0.65.0

## 0.63.0 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/cli@0.64.0

## 0.62.0 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/cli@0.63.0

## 0.61.0 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/cli@0.62.0

## 0.60.1 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/cli@0.61.1

## 0.60.0 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/cli@0.61.0

## 0.59.0 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/cli@0.60.0

## 0.58.0 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/cli@0.59.0

## 0.57.0 — 2026-10-26

### Added

- [6ce27613](https://github.com/imjlk/mpgd-kit/commit/6ce27613a430cde2cf13ffd7bac4e842f29cb296) Android advertising pushes in the notifications starter (AR1). `mpgd target init capacitor --providers notifications` declares the kit's advertising renderer (`dev.mpgd.capacitor.AdvertisingMessagingService`, with the `dev.mpgd.notifications.advertising_renderer` meta-data) as the shell's Firebase messaging service in a newly generated Android project and removes the one `@capacitor-firebase/messaging` declares; for an existing Android project it prints the manifest lines to add. It now also needs the game's `@mpgd/adapter-capacitor` to export `readCapacitorAdvertisingPushRenderer`. A game created with `--providers notifications` maps the sample `events` advertising topic to `android` too (channel `mpgd-advertising`), sets `shellRendersAdvertising: true` in `notifications/deployment.json`, and passes the renderer read to the Capacitor provider; the backend sends Android advertising only to installations whose shell registered the renderer. Existing games are unchanged. — Thanks @imjlk!
- [78e90728](https://github.com/imjlk/mpgd-kit/commit/78e907288f96d2a301a31fbac201c6de7a7c1990) The generated game's Restore Purchases control says "Restored to this device" (Korean: "이 기기로 구매를 복원했습니다") when the backend granted this player a purchase another guest of the same store account made or holds (a reinstall, a new device, a second device), and "This purchase is already in use on the maximum number of devices" (Korean: "이 구매는 이미 허용된 최대 기기 수에서 사용 중입니다") when the backend's holder limit refused it. `createStarterRestorePurchases` reports `restoredHere` and `atHolderLimit`; the template README explains restore sharing. — Thanks @imjlk!
- [b428376e](https://github.com/imjlk/mpgd-kit/commit/b428376e300f00fd2f68e802d7907c9384823944) Generated games show a Restore Purchases control: a lobby button in the Phaser template and a corner button in the lite template, on targets that sell through a store and have a Game Services client. It runs `monetizationRecovery.restorePurchases()` (`src/platform/restorePurchases.ts`), so grants still come only from the backend ledger, and reports how many purchases were confirmed. On the App Store and Google Play, where purchases are bound to the signed-in player, it asks the player to sign in instead of restoring without an authenticated session. — Thanks @imjlk!
- [d358f084](https://github.com/imjlk/mpgd-kit/commit/d358f08493ab2e466d6958b02ecab074786abba2) Generated games that start offline can still buy once the network returns. `createStarterGuestSignIn` (`src/platform/guestIdentity.ts`) retries a failed boot sign-in in the background (5 s, 15 s, 1 min, then every 5 min, and at once on the `online` event) and once more before each purchase or Restore Purchases tap. Until it succeeds the run uses session-gated game services (`src/platform/sessionGatedServices.ts`): purchases sign in first and are refused before any store sheet opens when that fails (`failed` with the retryable diagnostic `STARTER_SESSION_REQUIRED`, so the game action coordinator stays usable), rewarded ads stay off, and the purchase, restore, and notification services come up for the server player (never the platform's local placeholder) as soon as a sign-in succeeds. The Restore Purchases control then says it could not reach the game server and stays tappable as a retry (new `needs-connection` outcome), and the no-identity message reads "Restoring purchases needs a game server session". — Thanks @imjlk!
- [b428376e](https://github.com/imjlk/mpgd-kit/commit/b428376e300f00fd2f68e802d7907c9384823944) `mpgd deploy run` stamps the reserved Android `versionCode`/`versionName` and iOS `CURRENT_PROJECT_VERSION`/`MARKETING_VERSION` into the build's staged copy of the native shell, so a release no longer needs a commit of the next numbers. The source shell keeps every other identity check (package/bundle ID, suffixes, setters, xcconfig), and the signed AAB or archived app and IPA are still checked against the reserved numbers. Manual `mpgd target build` runs opt in with `MPGD_NATIVE_VERSION_STAMP=1`; without it the source must hold the exact numbers, as before. — Thanks @imjlk!
- [d358f084](https://github.com/imjlk/mpgd-kit/commit/d358f08493ab2e466d6958b02ecab074786abba2) Generated games sign in as a server-issued guest. With `VITE_MPGD_IDENTITY_URL` set to the kit's reference guest identity Worker, the new `src/platform/guestIdentity.ts` issues a guest on the first launch and restores it from the device's Keychain or Keystore after that (rotating refresh token, installation id in the same secure store), sets the server session with `setStarterServerSession`, and makes the server player the game services' `playerId`. StoreKit's `appAccountToken` and Google Play's `obfuscatedAccountId` are now bound to that server player (`setStarterCommerceServerPlayer` in `commerceAccountBinding.ts`) instead of requiring an authenticated platform session, so iOS purchases can start for a guest. A session the identity service ended is replaced by a new guest; offline at launch, purchases are refused until the next launch signs in. Without the variable nothing changes: the native shell's local player binds no purchase, and StoreKit's error now names the missing server session. The Restore Purchases control's no-session message now asks the player to connect to the game server instead of signing in. — Thanks @imjlk!
- [b428376e](https://github.com/imjlk/mpgd-kit/commit/b428376e300f00fd2f68e802d7907c9384823944) iOS shells declare export compliance. `mpgd target init capacitor` writes `ITSAppUsesNonExemptEncryption` = false into a newly generated iOS project's `Info.plist` (keeping a value the game already set) and replaces the template's 32-bit `armv7` device capability with `arm64`; a native build warns when an existing shell lacks either. The TestFlight submission now reads the build's TestFlight internal state (`asc builds build-beta-detail view`) after processing: a build waiting for the export-compliance answer is `action-required`, a still-processing one is `processing`, and only `READY_FOR_BETA_TESTING`/`IN_BETA_TESTING` builds are added to the internal group and can be `testflight-ready`. — Thanks @imjlk!
- [b428376e](https://github.com/imjlk/mpgd-kit/commit/b428376e300f00fd2f68e802d7907c9384823944) iOS shells bundle an app-level `PrivacyInfo.xcprivacy`. `mpgd target init capacitor` adds it to the App group and Resources phase of a newly generated iOS project (no tracking, no tracking domains, and no required-reason APIs, since the App target's own code uses none; Capacitor core and `@mpgd/capacitor-game-services` ship their own manifests). A native build warns when an existing shell's App target does not bundle one. — Thanks @imjlk!
- [b428376e](https://github.com/imjlk/mpgd-kit/commit/b428376e300f00fd2f68e802d7907c9384823944) Native shells follow the game's design orientation and iOS device family. `mpgd.game.json` takes `native.orientation` (`portrait`, `landscape` or `any`; the Phaser template sets `landscape`, the lite template `any`) and the ios target in `mpgd.targets.json` takes `metadata.iosDeviceFamily` (`universal`, the default, or `iphone`). `mpgd target init capacitor` writes them into newly generated projects: the iPhone `UISupportedInterfaceOrientations` (iPad keeps all four, as Apple's TN3192 asks), `TARGETED_DEVICE_FAMILY`, and the Android launcher's `android:screenOrientation` plus `android:appCategory="game"`, which keeps the lock on Android 16 large screens. A native build fails in `production` when an existing shell contradicts a configured setting. — Thanks @imjlk!
- [cdcfeba7](https://github.com/imjlk/mpgd-kit/commit/cdcfeba796d06cae539e3daec621718e20af58c2) Account deletion in generated games and on their legal site.
  
  - The Phaser lobby and the lite template show "Delete account" while a server-backed session is signed in (App Store guideline 5.1.1(v), Google Play's account deletion requirement). The first tap explains in English and Korean what is erased and what is kept (purchase records for five years, without the player id) and that purchases are not refunded; only "Delete permanently" deletes, and it first asks the identity service for a deletion confirmation with the guest session's refresh token (`starterAccountDeletionConfirmation(session)` as `requestConfirmation`; `StarterServerSession.requestAccountDeletionConfirmation`), so a stolen access token alone cannot delete the account. A session the identity service refused after a lost answer reads as the completed deletion. In a run whose guest sign-in failed at boot, the session-gated services expose `accountDeletion` once the player signs in and announce it with `onReady`, so the lobby entry and the lite button appear then. The device then forgets the guest session's secure credentials and the purchase journal (kept when the deletion is only inferred from a refused session after a lost answer), runs steps registered with `onStarterAccountDeleted` (the notifications overlay unregisters its runtime there), and reloads the game (`src/platform/deleteAccount.ts`).
  - `mpgd legal build` and `check` build an optional `legal/delete-account.html` into `/delete-account/`, print where to enter its URL in Play Console (Data safety), warn while it is missing or has `[REPLACE: …]` markers, refuse to build while another page links to `/delete-account/` without it (no dead deletion links), and treat an output left without its source as stale. The starter ships the page, and its privacy policy, support, and terms pages link it. — Thanks @imjlk!

### Changed

- [b428376e](https://github.com/imjlk/mpgd-kit/commit/b428376e300f00fd2f68e802d7907c9384823944) The generated privacy policy (`legal/privacy.html`) is a fuller starting point for store review: the data the kit's features process, the third-party services (Google Play Billing, StoreKit, Firebase Cloud Messaging, AdMob/UMP, Cloudflare), retention, an account and data deletion section with a placeholder for the deletion URL, player choices, children, and contact, with `[REPLACE: …]` markers for what only the game owner can fill in. — Thanks @imjlk!
- [b428376e](https://github.com/imjlk/mpgd-kit/commit/b428376e300f00fd2f68e802d7907c9384823944) Ads declarations for store releases. `mpgd legal build` serves `app-ads.txt` at the legal site's root: a game-owned `legal/app-ads.txt` verbatim, or Google's AdMob line for `ads.admob.publisherId` in `mpgd.game.json` (`mpgd legal check` covers it too). `mpgd target init capacitor` declares `com.google.android.gms.permission.AD_ID` in a newly generated Android project when the shell installs `@capacitor-community/admob` and removes it from the merged manifest otherwise; `ads.admob.advertisingId: "removed"` in `mpgd.game.json` records a deliberate no-advertising-ID policy (for example a child-directed game) and keeps the removal with AdMob. **Existing games with AdMob:** a native build now fails in `production` when a shell with AdMob lacks the Android `com.google.android.gms.ads.APPLICATION_ID` meta-data or the iOS `GADApplicationIdentifier` (the SDK stops the app at launch) or still removes the advertising ID permission, and warns about a missing `SKAdNetworkItems` entry for Google or a shell without AdMob that does not remove the permission. — Thanks @imjlk!
- [b428376e](https://github.com/imjlk/mpgd-kit/commit/b428376e300f00fd2f68e802d7907c9384823944) Generated games ignore signing and store credentials: `*.p12`, `*.p8`, `*.mobileprovision`, `*.provisionprofile`, `*.keystore`, `*.jks` and `*.pepk`. `google-services.json` and `GoogleService-Info.plist` stay committed on purpose: Firebase documents them as non-secret, and `mpgd deploy run` builds from a pinned Git checkout that needs them. Existing games add the same lines to their own `.gitignore`; `mpgd kit upgrade` does not edit it. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/cli@0.58.0

## 0.56.0 — 2026-10-25

### Added

- [dd51d8e9](https://github.com/imjlk/mpgd-kit/commit/dd51d8e9a6d994b1c2cefcd5adaf90e304953a6d) A game created with `--providers notifications` runs the notifications runtime on Reddit. The generated Devvit server serves the runtime's backend (`createDevvitNotificationsBackendBridgeHandler`) over the notifications service its scheduler tasks already run, and the Reddit gateway builder sets `createDevvitNotificationsBackend` as the starter's hosted backend (`setStarterHostedNotificationBackend` in `src/platform/notificationBackend.ts`, used only for that config target and created on first use). The settings screen then shows the reminder switches on Reddit once the player is logged in; advertising and night consent stay off there, since Devvit delivers `service` and `requested` topics only. The kit's and the template's Devvit server bridges take the backend handler as `notificationsBackend` and answer `NOTIFICATIONS_CONFIGURATION_REQUIRED` without it. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/cli@0.57.0

## 0.55.0 — 2026-10-24

### Added

- [fc9158f3](https://github.com/imjlk/mpgd-kit/commit/fc9158f34c54c1d88cafc040e7584e0fa9ebb69b) The starter's `serverSession.ts` recommends `createGuestServerSession(coordinator)` from `@mpgd/game-services`: it answers the coordinator's stable `sessionFamilyId`, which the notifications runtime and the game-services Worker need, instead of a view's rotating `sessionId`.

  Generated games gain `src/platform/developmentServerSession.ts`. On the Vite dev server in the development mode, `VITE_MPGD_DEV_NOTIFICATION_SESSION=<playerId>` (or `<playerId>.<installationId>`) signs the game in with an unauthenticated development session, so the notification settings record consent against a local Worker run with `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS` before the game has an identity service. It applies to the notifications backend only: the commerce client keeps the session the game set, or none. A normal `vite build` drops it. Any `setStarterServerSession` call turns it off, and the first call after it was in use warns. The game's notifications guide gains a "Try it locally" section. `mpgd target init capacitor --providers notifications` writes the new module next to `serverSession.ts`, and leaves it out, with a warning, for a game whose own `serverSession.ts` does not import it. — Thanks @imjlk!

### Changed

- [6f735409](https://github.com/imjlk/mpgd-kit/commit/6f73540926badd80b98e4ae547c5a1a279154033) The generated game's notifications guide ("Try it locally") binds the local game-services Worker to `127.0.0.1` and points at mpgd-kit's live test runbook (`docs/NOTIFICATIONS_LIVE_TEST.md`) for real pushes, instead of suggesting the service-account key go into `.dev.vars` in the checkout. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.56.0

## 0.54.0 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/cli@0.55.0

## 0.53.1 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/cli@0.54.1

## 0.53.0 — 2026-10-21

### Patch changes

- [38a4983d](https://github.com/imjlk/mpgd-kit/commit/38a4983d1abc03b5e7f151b12a2e57b9c1d834ad) `mpgd game create` and `pnpm create @mpgd/game` keep `$&`, `$'`, `` $` ``, and `$$` in a display title literal. Those sequences are no longer read as replacement patterns, so a title such as `Hit $&` no longer leaves `__GAME_TITLE__` in `notifications/topics.json` or injects the rest of a JSON file. Titles may also contain quotes and backslashes. Generated JSON, including `public/manifest.webmanifest`, escapes them, and single-quoted TypeScript titles escape quotes and backslashes, so the generated source still parses. Control characters and angle brackets are still refused.
  
  The generated notification settings scene wraps the outcome strip to the same 840px column as the list and moves the list down when that strip wraps, so the English stale-night consent message stays on the 960x540 canvas. — Thanks @imjlk!
- Updated dependencies: @mpgd/cli@0.54.0

### Added

- [f772a896](https://github.com/imjlk/mpgd-kit/commit/f772a8964437d512349736e609668792b480fbc1) A game created with `--providers notifications` gets a notifications backend once it has one to talk to: `createStarterNotificationBackend` now builds the notifications runtime (`@mpgd/platform/notifications-runtime`) over the game-services Worker's notification routes (`@mpgd/game-services/notifications/client`) when the game has `VITE_MPGD_GAME_SERVICES_URL` (a public https URL in production, the commerce client's rule) and has set its server-backed session with the new `setStarterServerSession`, and the target exposes a notifications provider. The runtime keeps its registration state in the platform storage, and the settings screen then shows the reminder, advertising, and night switches from the player's consent records. The runtime also loads the Worker's registry entry for its target (`GET /providers`) in the background and compares the provider with it; a Worker it cannot reach is logged and the runtime runs without the check. A Reddit game gets no Worker backend, since its notifications backend is the Devvit server. Without a URL or a session it returns `undefined`, as before, and warns once when the URL is set without a session. The Worker wiring lives in the new `src/platform/notificationBackend.ts`.
  
  Every generated game gains `src/platform/serverSession.ts` (`StarterServerSession`, `setStarterServerSession`, `resolveStarterServerSession`); when a session is set, the commerce client in `gameServices.ts` sends its header too. Nothing changes for a game that sets none. `mpgd target init capacitor --providers notifications` writes `serverSession.ts` into a game created by an earlier release that lacks it, next to the other notifications modules. `sessionId` must be the stable session-family id the identity service answers to `authenticateNotificationSession`, not a rotating one such as a `GuestSessionCoordinator` view's. — Thanks @imjlk!

## 0.52.0 — 2026-10-20

### Added

- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) `mpgd game create --providers notifications` (and `@mpgd/create-game --providers notifications`) adds the notifications v2 starter to a new Phaser or lite game:
  
  - `notifications/topics.json`, a topic catalog with the starter topics `daily-ready` and `streak-at-risk` (`requested`: off until the player turns them on), `friend-challenge` (`service`), a sample `advertising` topic for iOS (an Android FCM push cannot carry the opt-out action until the shell renders advertising natively, a follow-up), and the `consent-notice` topic with every `notices.copy` variant in Korean and English (decree art. 62-2 and 62-3 wording, `{{consentDate}}` in each);
  - `notifications/deployment.json` with `advertisingRules: "kr"` and an advertising sender whose contact placeholder `pnpm validate:notifications` refuses until it is replaced;
  - the Android and iOS gateways register the Capacitor notifications provider (FCM and local reminders, named Android channels, the opt-out action, and `openCapacitorNotificationSettings`); the Reddit gateway exposes the game-rendered opt-in and the Reddit login prompt; the generated Devvit server serves the opt-in and runs the notifications service in its scheduler tasks; the Apps in Toss wrapper reads the catalog's `targets.ait` mappings;
  - `integrations.notifications: "available"` for `android`, `ios`, and `ait` (Reddit stays `approval-required` until Reddit approves the app) and `integrations.identityUpgrade: "available"` for `reddit`;
  - a game-rendered notification settings screen (a Phaser scene, or a DOM panel in the lite template) for the OS or host permission, reminder topics, 광고성 정보 수신동의, and night consent, recorded through the notifications runtime and shown from the player's latest backend consent records (never a device-side copy); night consent is offered only while advertising consent is granted and is withdrawn with it; and `docs/NOTIFICATIONS.md`.
  
  The game declares `@capacitor-firebase/messaging` 8.5.2, `@capacitor/local-notifications` 8.3.1, and `firebase` 12.19.0. Without `--providers notifications` a generated game is unchanged. — Thanks @imjlk!

### Changed

- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) `@mpgd/adapter-ait/notification-config` exports `extractAitNotificationTopicConfig(catalog, { target, sourceLabel })`, which reads the `notificationTopics` of `installAitHostBridge` from a notification topic catalog's `targets.ait` mappings (`templateSetCode`, `agreement`). The catalog is checked with `validateNotificationTopicCatalog` from `@mpgd/catalog` (now a dependency) and the Apps in Toss registry entry, so for the Apps in Toss target the wrapper refuses what `pnpm validate:notifications` refuses, including an advertising topic mapped for Apps in Toss; other targets' mappings and the deployment are left to `pnpm validate:notifications`.
  
  The generated Apps in Toss wrapper reads the game's notification topic catalog at build time (`MPGD_NOTIFICATION_TOPICS_FILE`, else `notifications/topics.json` when it exists) and passes its Apps in Toss topics to the host bridge, so notifications v2 agreements and landings work once the game maps its console templates. Without a catalog or a mapping the wrapper behaves as before. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/cli@0.53.0

## 0.51.0 — 2026-10-19

### Patch changes

- Updated dependencies: cli@0.52.0

## 0.50.0 — 2026-10-19

### Changed

- The generated Devvit server bridge (`apps/target-devvit/src/server/bridge.ts`) takes an optional `notifications` handler, `createDevvitNotificationsV2BridgeHandler` from `@mpgd/adapter-devvit/server`, which serves the `notifications.v2.*` methods. The generated entrypoint does not pass one yet, so every v2 method keeps answering `NOTIFICATIONS_V2_UNAVAILABLE` there; a handler that throws answers a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
- The Devvit notifications service's own work runs on the Devvit scheduler. `@mpgd/adapter-devvit/server` adds `devvitNotificationSchedulerTasks` (`mpgd-notifications-dispatch` every minute and `mpgd-notifications-purge` every five minutes, with their `/internal/scheduler/...` endpoints), `devvitNotificationTaskForEndpoint`, and `runDevvitNotificationTask(service, task)`. A dispatch run is one `runScheduler` run of the service, so server reminders fire on Devvit along with the due sends: rounds of at most 10 due schedule entries and 10 due sends, starting no round after 20 seconds; the result counts the sends the run `touched`. A purge run deletes at most the store's `purgeLimit` rows of each kind; `createDevvitNotificationService` now builds its Redis store with `purgeLimit` 200 unless `storeOptions` names one. The generated Devvit app declares both tasks in `devvit.json` and routes them through `src/server/notificationTasks.ts`; without a notifications service the tasks do no work.

### Patch changes

- Updated dependencies: cli@0.51.0

## 0.49.1 — 2026-10-17

### Patch changes

- Updated dependencies: cli@0.50.1

## 0.49.0 — 2026-10-16

### Patch changes

- Updated dependencies: cli@0.50.0

## 0.48.0 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.49.0

## 0.47.0 — 2026-10-15

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
- Updated dependencies: cli@0.48.0

## 0.46.0 — 2026-10-12

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

- Updated dependencies: cli@0.47.0

## 0.45.1 — 2026-10-12

### Patch changes

- Updated dependencies: cli@0.46.1

## 0.45.0 — 2026-10-12

### Patch changes

- Updated dependencies: cli@0.46.0

## 0.44.0 — 2026-10-12

### Patch changes

- Updated dependencies: cli@0.45.0

## 0.43.0 — 2026-10-12

### Patch changes

- Updated dependencies: cli@0.44.0

## 0.42.0 — 2026-10-11

### Patch changes

- Updated dependencies: cli@0.43.0

## 0.41.0 — 2026-10-11

### Patch changes

- Updated dependencies: cli@0.42.0

## 0.40.0 — 2026-10-10

### Minor changes

- [03cb45e2](https://github.com/imjlk/mpgd-kit/commit/03cb45e2b6583934e04d758dab53fb451ec82b42) Add optional foreground performance collection to game acceptance, with bounded
  consumer-authored budgets, sample/cadence checks and fresh artifact provenance. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.41.0

## 0.39.0 — 2026-10-10

### Patch changes

- Updated dependencies: cli@0.40.0

## 0.38.0 — 2026-10-09

### Added

- [537c6168](https://github.com/imjlk/mpgd-kit/commit/537c6168a902332e6c62ab0585d2cdfac946e51a) Add the ONE play H5 Web SDK target and browser adapter subpath, asynchronous host loading acknowledgements, synchronous exit checkpoints, platform asserted identity, audio/safe-area integration, and interstitial presentation handling that keeps uncertain native outcomes quarantined. Include target build, hosting headers, generated starter wiring and explicit server authority gates for subsequent monetization integrations. — Thanks @imjlk!
- [a483af3f](https://github.com/imjlk/mpgd-kit/commit/a483af3fb7f789a9edc71cc513e7c122d0b1e4b6) Add ONE play managed purchases with authenticated checkout intents, independent API V7 verification, ledger-before-consume or acknowledge finalization, signed PNS recovery and authoritative cancellation hooks. Map partial product detail batches and expose trusted native checkout presentation facts through the shared commerce contract and runtime. Keep subscriptions unsupported and server integrations required. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.39.0

## 0.37.0 — 2026-10-09

### Patch changes

- Updated dependencies: cli@0.38.0

## 0.36.0 — 2026-10-09

### Patch changes

- Updated dependencies: cli@0.37.0

## 0.35.2 — 2026-10-04

### Patch changes

- Updated dependencies: cli@0.36.2

## 0.35.1 — 2026-10-04

### Patch changes

- Updated dependencies: cli@0.36.1

## 0.35.0 — 2026-09-28

### Patch changes

- Updated dependencies: cli@0.36.0

## 0.34.0 — 2026-09-25

### Patch changes

- Updated dependencies: cli@0.35.0

## 0.33.0 — 2026-09-25

### Patch changes

- Updated dependencies: cli@0.34.0

## 0.32.2 — 2026-09-24

### Patch changes

- Updated dependencies: cli@0.33.2

## 0.32.1 — 2026-09-24

### Patch changes

- Updated dependencies: cli@0.33.1

## 0.32.0 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.33.0

## 0.31.0 — 2026-09-21

### Patch changes

- Updated dependencies: cli@0.32.0

## 0.30.0 — 2026-09-14

### Patch changes

- Updated dependencies: cli@0.31.0

## 0.29.1 — 2026-09-13

### Patch changes

- Updated dependencies: cli@0.30.1

## 0.29.0 — 2026-09-13

### Patch changes

- Updated dependencies: cli@0.30.0

## 0.28.0 — 2026-09-12

### Patch changes

- Updated dependencies: cli@0.29.0

## 0.27.1 — 2026-09-03

### Patch changes

- Updated dependencies: cli@0.28.1

## 0.27.0 — 2026-09-02

### Patch changes

- Updated dependencies: cli@0.28.0

## 0.26.0 — 2026-08-29

### Patch changes

- Updated dependencies: cli@0.27.0

## 0.25.0 — 2026-08-27

### Patch changes

- Updated dependencies: cli@0.26.0

## 0.24.2 — 2026-08-27

### Patch changes

- [8948cae](https://github.com/imjlk/mpgd-kit/commit/8948caee3600be457c4662ffab9947abfdb60685) Bridge the official Apps in Toss `SafeArea.get()` and `SafeArea.subscribe()` values into shared CSS custom properties, including a transparent-navigation content boundary, and install the bridge in generated AIT wrappers. — Thanks @imjlk!
- [4e92350](https://github.com/imjlk/mpgd-kit/commit/4e92350c4cf29d71c2a73aa164f814ef8ecd1c50) Add a preview-only Devvit view-mode contract and make generated games load Phaser only from the Expanded Mode entry by default. The existing inline-gameplay contract remains available as an explicit opt-in. — Thanks @imjlk!
- Updated dependencies: cli@0.25.0

## 0.24.1 — 2026-08-26

### Patch changes

- Updated dependencies: cli@0.24.1

## 0.24.0 — 2026-08-26

### Patch changes

- Updated dependencies: cli@0.24.0

## 0.23.0 — 2026-08-21

### Patch changes

- Updated dependencies: cli@0.23.0

## 0.22.1 — 2026-08-13

### Patch changes

- Updated dependencies: cli@0.22.1

## 0.22.0 — 2026-08-12

### Patch changes

- Updated dependencies: cli@0.22.0

## 0.21.0 — 2026-08-08

### Patch changes

- Updated dependencies: cli@0.21.0

## 0.20.1 — 2026-08-04

### Patch changes

- Updated dependencies: cli@0.20.1

## 0.20.0 — 2026-08-01

### Patch changes

- Updated dependencies: cli@0.20.0

## 0.19.0 — 2026-07-27

### Patch changes

- Updated dependencies: cli@0.19.0

## 0.18.0 — 2026-07-23

### Patch changes

- Updated dependencies: cli@0.18.0

## 0.17.0 — 2026-07-22

### Patch changes

- Updated dependencies: cli@0.17.0

## 0.16.1 — 2026-07-20

### Patch changes

- Updated dependencies: cli@0.16.1

## 0.16.0 — 2026-07-20

### Patch changes

- Updated dependencies: cli@0.16.0

## 0.15.2 — 2026-07-20

### Patch changes

- Updated dependencies: cli@0.15.2

## 0.15.1 — 2026-07-20

### Patch changes

- Updated dependencies: cli@0.15.1

## 0.15.0 — 2026-07-20

### Added

- [dede158](https://github.com/imjlk/mpgd-kit/commit/dede158e343b1fa8494e3d28ae52a2f0a0b89a16) Add explicit Microsoft Store starter selection, conflict-safe idempotent target
  initialization, and generated agent workflow documentation and skills for
  discovering and validating mpgd-kit capabilities. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.15.0

## 0.14.0 — 2026-07-19

### Patch changes

- Updated dependencies: cli@0.14.0

## 0.13.0 — 2026-07-17

### Patch changes

- Updated dependencies: cli@0.13.0

## 0.12.0 — 2026-07-17

### Patch changes

- Updated dependencies: cli@0.12.0

## 0.11.0 — 2026-07-15

### Patch changes

- Updated dependencies: cli@0.11.0

## 0.10.1 — 2026-07-15

### Patch changes

- Updated dependencies: cli@0.10.1

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

- Updated dependencies: cli@0.10.0

## 0.9.0 — 2026-07-14

### Removed

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Upgrade generated Devvit targets to the stable 0.13.8 toolchain and remove the
  deprecated JSON fetch bridge API, JSON route, pre-namespace storage fallback,
  and split build strategy so Devvit targets use oRPC and the official Vite plugin
  exclusively. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.9.0

## 0.8.0 — 2026-07-14

### Added

- [2f06373](https://github.com/imjlk/mpgd-kit/commit/2f063737d518a19d93de0781bf44582c0a0bc78b) Add an opt-in official Devvit Vite build strategy for generated Phaser games,
  upgrade Devvit packages to 0.13.7, expose a direct oRPC Node HTTP bridge
  adapter, and remove the generated target's Express-based request conversion. — Thanks @imjlk!

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.8.0

## 0.7.0 — 2026-07-13

### Patch changes

- Updated dependencies: cli@0.7.0

## 0.6.0 — 2026-07-11

### Patch changes

- Updated dependencies: cli@0.6.0

## 0.5.0 — 2026-07-10

### Patch changes

- Updated dependencies: cli@0.5.0

## 0.4.1 — 2026-07-09

### Patch changes

- Updated dependencies: cli@0.4.1

## 0.4.0 — 2026-07-08

### Patch changes

- Updated dependencies: cli@0.4.0

## 0.3.2 — 2026-07-06

### Patch changes

- Updated dependencies: cli@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Updated dependencies: cli@0.3.1

## 0.3.0 — 2026-07-06

### Changed

- [12fb9df](https://github.com/imjlk/mpgd-kit/commit/12fb9dfe5b50a29f216538133f82e132651fcf07) Generate game-owned Devvit app roots in Phaser starters and derive starter
  `@mpgd/*` dependency pins from the released CLI package version. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.3.0

## 0.2.0 — 2026-07-06

### Added

- [0766fba](https://github.com/imjlk/mpgd-kit/commit/0766fbaa92381bc127ea7a8605ee1440884a79d9) Add a public Gunshi CLI for Phaser starter generation and target build/smoke orchestration, plus a create-package wrapper for `npm create @mpgd/game` style project bootstrapping. — Thanks @imjlk!

### Patch changes

- Updated dependencies: cli@0.2.0

