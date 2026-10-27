# Mobile launch checklist (Google Play and the App Store)

For a game made with the kit that ships through the Capacitor shell to Google
Play and the App Store (iPhone and iPad) at the same time. Work top to bottom;
each step says what the kit does, what you do in a console, and what to answer
where the kit knows the answer. Items marked **(open: …)** are not covered by
the kit yet and name the change that will cover them.

Facts below were checked against the stores' documentation on 2026-10-25;
the stores change their rules, so re-check the linked pages before you submit.

## 0. Requirements that change over time

- **Android target API.** From 31 August 2026 new apps and updates must target
  API 36 ([Play target API](https://support.google.com/googleplay/android-developer/answer/11926878)).
  The kit shell targets and compiles against 36 (`android/variables.gradle`).
- **Xcode and SDK.** From 28 April 2026 App Store uploads need Xcode 26 and the
  iOS 26 SDK ([Apple upcoming requirements](https://developer.apple.com/news/upcoming-requirements/)).
  The kit's CI and generated workflow use `macos-26`.
- **Android 16 large screens.** Apps targeting API 36 lose orientation locks on
  tablets and foldables unless they declare themselves games
  ([behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)).
  New kit shells set `android:appCategory="game"`.
- **iPadOS 26.** `UIRequiresFullScreen` is deprecated; Apple asks iPad apps to
  support every orientation ([TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key)).
  Kit shells list all four iPad orientations.
- **16 KB memory pages (Android).** Apps targeting API 35+ that ship native
  code must support 16 KB pages on Google Play; from 1 February 2027 updates
  that do not cannot be released ([page sizes](https://developer.android.com/guide/practices/page-sizes)).
  The shell has no native libraries of its own, but AdMob or Firebase may add
  some. Check the release AAB's zip alignment with
  `bundletool dump config --bundle=app-release.aab | grep alignment`
  (`PAGE_ALIGNMENT_16K` is what you want; `PAGE_ALIGNMENT_4K` means the
  native libraries are 4 KB aligned) and the libraries' ELF alignment with
  the APK Analyzer. The kit does not check this.

## 1. Accounts and keys

Keep every key out of Git (the generated `.gitignore` ignores `*.p12`, `*.p8`,
`*.mobileprovision`, `*.keystore`, `*.jks`, `*.pepk`) and supply them through
`mise` or CI secrets ([native deploy run](./NATIVE_DEPLOY_RUN.md#credential-references)).

Google:

- [ ] Google Play developer account, identity verified. Personal accounts
      created after 13 November 2023 must run a **closed test with at least 12
      testers opted in for 14 days in a row** before they can apply for
      production access ([testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)).
      Start it early.
- [ ] Upload keystore (`MPGD_ANDROID_UPLOAD_*`) and its certificate SHA-256
      (`MPGD_ANDROID_UPLOAD_CERT_SHA256`). Enrol the app in Play App Signing
      in the console; Google keeps the app-signing key.
- [ ] A Google Cloud service account added to Play Console users: release
      manager rights for uploads, plus financial data for purchase
      verification (the Worker's `GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH`
      service binding, see [game services backend](./GAME_SERVICES_BACKEND.md)).
- [ ] Firebase project with the Android and iOS apps, `google-services.json`
      and `GoogleService-Info.plist` committed, an FCM service-account key in
      the Worker ([Firebase notifications](./FIREBASE_NOTIFICATIONS.md)).
- [ ] AdMob account, app IDs and ad units per platform, publisher ID for
      `app-ads.txt` (only if the game shows ads).

Apple:

- [ ] Apple Developer Program membership, Team ID, an App ID with Push
      Notifications and In-App Purchase.
- [ ] Apple Distribution certificate (.p12 and password) and an App Store
      provisioning profile for the bundle ID.
- [ ] App Store Connect app record (numeric app ID), an internal TestFlight
      group ID, and an App Store Connect API key (.p8, key ID, issuer ID).
- [ ] In-App Purchase key for the App Store Server API, `appAppleId`, and
      Apple root certificates in the Worker ([game services backend](./GAME_SERVICES_BACKEND.md)).
- [ ] APNs auth key uploaded to Firebase.
- [ ] Paid Apps agreement, tax and banking in App Store Connect.

Cloudflare:

- [ ] Worker with a D1 database and the cron trigger (Workers Paid plan),
      secrets set ([Cloudflare Worker deploy](./CLOUDFLARE_WORKER_DEPLOY.md)).
- [ ] Legal site (privacy, terms, support) on the domain you will enter as the
      developer website / marketing URL, so `app-ads.txt` sits at its root.

## 2. Game configuration

- [ ] `mpgd.game.json` → `native.orientation`: the game's design orientation
      (`portrait`, `landscape` or `any`). It drives the iPhone orientations
      and the Android launcher's `screenOrientation`.
- [ ] `mpgd.targets.json` → ios `metadata.iosDeviceFamily`: `universal`
      (default, iPhone and iPad) or `iphone`. With iPad you must upload iPad
      screenshots and test on an iPad (layout, letterboxing, rotation
      prompt); App Review uses an iPad for universal apps.
- [ ] `mpgd.targets.json` → android `metadata.packageId`, ios
      `metadata.bundleId`, `displayName` for both.
- [ ] Catalog products (`packages/catalog/catalog.json` or the game's copy)
      with the store SKUs, and `mpgd.store-listings.json` with each
      product's titles, descriptions and prices. `mpgd store products plan`
      then `apply --approve` creates the Google Play one-time products and
      the App Store Connect in-app purchases (`--store google-play`,
      `--store app-store`; [store product sync](./STORE_PRODUCT_SYNC.md)).
- [ ] Ads: `ads.admob.publisherId` in `mpgd.game.json` if AdMob is used;
      `ads.admob.advertisingId: "removed"` only for a deliberate
      no-advertising-ID policy such as a child-directed game.

## 3. Native shell

```sh
pnpm exec mpgd target init capacitor --game . \
  --app-id dev.example.mygame --display-name "My Game" \
  --icon-source public/icon.png \
  --backend-url https://api.example.com \
  --providers play-billing,storekit,notifications
```

A newly generated shell gets the store settings below. A shell generated
before this kit version keeps its files; `mpgd target build android|ios
production` prints what it lacks and fails on contradictions
([store-facing shell settings](./GAME_DEVELOPMENT.md#store-facing-shell-settings)).

- [ ] iOS `Info.plist`: `ITSAppUsesNonExemptEncryption` = `false` (the kit
      only uses HTTPS and OS crypto,
      [exempt](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations);
      set `true` and answer the questions if the game adds its own
      encryption), `arm64` device capability, orientations.
- [ ] iOS `PrivacyInfo.xcprivacy` bundled in the App target.
- [ ] Android: launcher orientation, `android:appCategory="game"`, and the
      advertising ID permission declared with AdMob or removed without it.
- [ ] Crash reporting (add `crash-reporting` to `--providers`): the
      Crashlytics plugin in the shell, the Crashlytics Gradle plugin in the
      Android project (an existing project gets the two lines by hand), and
      the iOS dSYM upload: `mpgd deploy run` records and uploads the dSYMs of
      each App Store build; check `symbolUploads` in `mpgd deploy status` and
      retry a failure with `mpgd deploy symbols`
      ([crash reporting](./CRASH_REPORTING.md#symbols)).
- [ ] R8 (only if the game turns `minifyEnabled` on): `mpgd deploy run`
      records `mapping.txt` with the build and sends it to Play; do not pass
      another `--mapping-file` to `deploy submit`
      ([R8 mapping](./GOOGLE_PLAY_RELEASES.md#r8-mapping-deobfuscation-file)).
- [ ] AdMob only: Android `com.google.android.gms.ads.APPLICATION_ID`
      meta-data, iOS `GADApplicationIdentifier` and `SKAdNetworkItems`
      ([AdMob setup](https://github.com/imjlk/mpgd-kit/blob/main/adapters/capacitor/README.md#opt-in-admob-rewarded-ads)).
      The kit never shows the ATT prompt; add it only if the game tracks.
- [ ] Push: Firebase files (`google-services.json`,
      `GoogleService-Info.plist` in the App target) and the APNs key in
      Firebase. On iOS, a shell generated with `--providers notifications`
      has the `aps-environment` entitlement, the AppDelegate token
      forwarding and the cold-start tap forwarder; an older shell needs the
      steps the initializer prints, and `mpgd target build ios production`
      fails until it has all three
      ([Firebase notifications](./FIREBASE_NOTIFICATIONS.md#4-ios)).
- [ ] Android advertising push (only if a topic is `advertising` and maps
      to `android`): the manifest declares the kit's
      `dev.mpgd.capacitor.AdvertisingMessagingService` and removes the
      messaging plugin's service, `notifications/deployment.json` sets
      `shellRendersAdvertising: true`, and the Capacitor provider gets
      `advertisingRenderer` (a shell newly generated with `--providers notifications`
      has all three, and `mpgd target build` does not check them;
      [Firebase notifications](./FIREBASE_NOTIFICATIONS.md#3-android)).
      Without them the backend sends Android installations no advertising
      under the Korean rules.

## 4. Backend

- [ ] Worker deployed with D1 and the cron, the guest identity Worker
      deployed and bound ([Guest Identity Worker](./CLOUDFLARE_WORKER_DEPLOY.md#guest-identity-worker)),
      purchase verification for Play and the App Store, AdMob
      SSV if ads grant rewards ([game services backend](./GAME_SERVICES_BACKEND.md),
      [AdMob SSV](./ADMOB_SSV.md)).
- [ ] App Review buys with sandbox accounts against your production backend:
      build the iOS verifier Worker's purchase verifier with
      `sandboxPurchases: { mode: 'grant', signedTransactionVerifier }` (a
      sandbox-scoped Apple verifier). Sandbox grants keep
      `appStoreEnvironment: 'Sandbox'`; leave them out of revenue reports
      ([App Review and TestFlight purchases](./GAME_SERVICES_BACKEND.md#app-review-and-testflight-purchases-on-a-production-backend)).
      Leave Family Sharing off for the game's In-App Purchases in App Store
      Connect: family-shared transactions are refused.
- [ ] Apply D1 migration `0009_store_server.sql` before deploying the Worker
      version that has the store server code, and enable the cron trigger
      `* * * * *` (Workers Paid): it retries owed Play acknowledges and
      consumes within Play's 3-day window and sweeps Play voided purchases
      every `MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES` (60)
      ([runbook](./CLOUDFLARE_WORKER_DEPLOY.md#store-refunds-and-play-finalization)).
      Both need the in-Worker Play boundary
      (`GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME` with
      `GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH`).
- [ ] App Store Connect → App Information → App Store Server Notifications:
      Version 2, Production Server URL
      `https://<worker>/app-store/notifications/v2`, Sandbox Server URL
      `https://<worker>/app-store/notifications/v2/sandbox`. Bind
      `GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER` (the iOS verifier
      Worker's `AppStoreNotificationVerifier` entrypoint) and set
      `GAME_SERVICES_APP_STORE_BUNDLE_ID`; allow `17.0.0.0/8` if the host
      filters by IP. Refunds revoke grants; a refund reversal is logged at
      warn for support to re-grant
      ([re-granting](./GAME_SERVICES_BACKEND.md#re-granting-after-a-refund-reversal)).
- [ ] Play Console → Users and permissions: give the publisher service
      account financial access ("View financial reports" in Google's API
      docs; the Console label may differ) for the Voided Purchases API, and
      "Manage orders and subscriptions" for server-side acknowledge and
      consume. Real-time developer notifications are optional; the Worker
      does not consume them yet and the sweep is what keeps the ledger right.

## 5. Identity and account deletion

- [ ] A server session for purchases: StoreKit and Play purchases are bound
      to the server player, and the native shell's local player binds
      nothing. Deploy the reference guest identity Worker
      (`apps/game-identity-worker`: D1, the `IDENTITY_ISSUE_RATE_LIMITER`
      binding, and the hourly purge cron, all commented in its
      `wrangler.toml`), bind
      the game-services Worker's `GAME_SERVICES_INGRESS_AUTH`,
      `GAME_SERVICES_NOTIFICATIONS_AUTH` and
      `GAME_SERVICES_GOOGLE_PLAY_ACCOUNT_BINDING` to it, have the iOS verifier
      Worker resolve `appAccountToken` through its `AppStoreAccountBinding`,
      and set `VITE_MPGD_IDENTITY_URL` in the game's production build
      ([Guest Identity Worker](./CLOUDFLARE_WORKER_DEPLOY.md#guest-identity-worker)).
      A guest who logs out, or stays away longer than the inactivity window
      (`IDENTITY_REFRESH_IDLE_DAYS`, 180 by default), comes back as a new player: restored non-consumables are granted to it too (below),
      consumables and progress do not until account linking exists; say so in
      the game's support copy.
- [ ] Before selling non-consumables, keep restore sharing on (the
      reference Worker's default): a reinstall on Android, a new device, a
      second device, or a logout makes a new guest, the store returns the
      purchase bound to the buyer's guest, and a verified restore grants
      `REMOVE_ADS` to the new guest too, up to
      `GAME_SERVICES_RESTORE_MAX_HOLDERS` guests per purchase (5 by default).
      Consumables and subscriptions are never shared; say in the support copy
      that consumables and progress stay with the old guest until account
      linking exists
      ([reinstalls and new devices](./CLOUDFLARE_WORKER_DEPLOY.md#reinstalls-and-new-devices-restore-sharing)).
      With `GAME_SERVICES_RESTORE_SHARING = "refuse"` the restore is refused
      (`GOOGLE_PLAY_ACCOUNT_MISMATCH` / `APP_STORE_ACCOUNT_TOKEN_MISMATCH`):
      then do not sell non-consumables.
- [ ] Account deletion. Play requires deletion in the app and through a
      web link for apps that create accounts
      ([Play account deletion](https://support.google.com/googleplay/android-developer/answer/13327111));
      the App Store requires in-app deletion (guideline 5.1.1(v)), guest
      accounts included
      ([Apple](https://developer.apple.com/support/offering-account-deletion-in-your-app/)).
      The kit provides the route, the starter's Delete account entry, and the
      web page ([account deletion](./GAME_SERVICES_BACKEND.md#account-deletion)):
      - [ ] Apply migration `0010_account_deletion.sql` (and the identity
            Worker's `0002_account_deletion.sql`) and bind
            `GAME_SERVICES_ACCOUNT_DELETION` to the identity Worker's
            `AccountDeletion` entrypoint, and set the secret
            `GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY`; the route
            answers `503` without either.
            The same binding verifies the deletion confirmation the client
            sends, so a stolen access token alone cannot delete an account.
            The cron (above) finishes pending erasures and purges kept
            purchase records after five years; without it neither happens.
      - [ ] Register a `PlayerDataEraser` for every player dataset the game
            adds on its server (only registered erasers run).
      - [ ] Fill in `legal/delete-account.html` (every `[REPLACE: …]`: the
            developer name as on the store listing, the in-game path, how a
            player without the game asks, and your processing time), run
            `pnpm exec mpgd legal build`, and deploy the site.
      - [ ] Play Console → App content → Data safety → Delete account URL:
            `https://<legal site>/delete-account/`.
      - [ ] Decide how support handles a web request (the operator calls the
            Worker's `GameServicesAccountDeletion` entrypoint) and how a
            player without a player ID or order number is identified.

## 6. Legal pages and privacy answers

- [ ] Fill in `legal/privacy.html` (every `[REPLACE: …]`, and delete what
      the game does not do), `terms.html`, `support.html`; run
      `pnpm exec mpgd legal build` (it warns while `[REPLACE:` markers remain)
      and deploy the site.
      `app-ads.txt` is served from `ads.admob.publisherId` or
      `legal/app-ads.txt`.
- [ ] Answer Play **Data safety** and App Store **App Privacy** from
      [store privacy disclosures](./STORE_PRIVACY_DISCLOSURES.md).

## 7. Build, version, upload

```sh
pnpm exec mpgd deploy init --game .   # once: writes mpgd.deploy.json (credential variable names only)
pnpm exec mpgd deploy plan --game . --profile beta --targets android,ios --out ../release-plan.json
pnpm exec mpgd deploy doctor --game . --profile beta
pnpm exec mpgd deploy run --plan ../release-plan.json \
  --game-id mygame --game-version 1.0.0 --release beta-001 \
  --initial-ledger ./initial-ledger.json --approve   # first release only
pnpm exec mpgd deploy status --game . --game-id mygame --release beta-001
```

- [ ] `deploy run` reserves the next `versionCode` / build number on the
      `release-state` branch and stamps them into the build; you do not commit
      them ([versioning](./MULTI_TARGET_RELEASE_VERSIONING.md#stamping-the-reserved-version-numbers)).
- [ ] Android goes to the **internal** track by default. `--track`,
      `--status draft|completed|inProgress`, `--user-fraction`,
      `--release-notes` and `--confirm-production` target closed, open and
      production tracks; `mpgd deploy rollout` updates, halts, resumes or
      completes a staged rollout ([Play releases](./GOOGLE_PLAY_RELEASES.md)).
- [ ] Production gets the build that passed closed testing:
      `mpgd deploy promote --from <closed track> --to production` releases
      that version code without uploading or rebuilding
      ([promote](./GOOGLE_PLAY_RELEASES.md#promoting-a-tested-release-deploy-promote)).
- [ ] The first upload of a never-published app is committed as a **draft**
      (Play accepts nothing else); roll that draft out once in Play Console
      ([draft apps](./GOOGLE_PLAY_RELEASES.md#draft-apps)).
- [ ] iOS goes to an internal TestFlight group. The submission reports
      `action-required` while TestFlight waits for the export-compliance
      answer ([TestFlight](./TESTFLIGHT_INTERNAL_SUBMISSION.md)).
- [ ] Push (shells with `--providers notifications`): the iOS store build
      reads the signed IPA's entitlements and fails unless `aps-environment`
      is `production`. The shell's entitlements file says `development`, and
      Xcode signs the value from the App Store profile. When the build fails,
      either the profile lacks Push Notifications (enable it on the App ID,
      then regenerate the profile) or the export used a development profile
      ([Firebase notifications](./FIREBASE_NOTIFICATIONS.md#4-ios)).
- [ ] CI: `pnpm exec mpgd deploy workflow init` writes a game-owned workflow
      ([native deploy CI](./GAME_NATIVE_DEPLOY_CI.md)).

## 8. Console-only steps

Google Play Console:

- [ ] Create the app; store listing (title, descriptions, screenshots for
      phone and, if offered, tablets), developer website = the legal site.
- [ ] Content rating (IARC questionnaire), target audience and content,
      ads declaration ("contains ads" if AdMob), advertising ID declaration
      (matches the manifest, see above), app access (instructions if review
      needs a sign-in), data safety, government apps / financial features /
      health declarations ("no" for a typical game).
- [ ] In-app products with prices: `mpgd store products apply` creates and
      activates them ([store product sync](./STORE_PRODUCT_SYNC.md)); the
      payments profile and license testers stay in the console.
- [ ] Closed test with 12+ testers opted in for 14 days in a row (personal
      accounts created after 13 November 2023): create the closed track and
      its testers in the console, ship builds to it with `--track <name>`,
      apply for production access, then `deploy promote` the tested build
      ([closed testing](./GOOGLE_PLAY_RELEASES.md#closed-testing-for-new-personal-accounts)).

App Store Connect:

- [ ] App information, age rating questionnaire, App Privacy answers, privacy
      policy URL, support URL, marketing URL (the legal site).
- [ ] Screenshots in the sizes App Store Connect asks for (currently the
      6.9-inch iPhone set and, for a universal app, the 13-inch iPad set);
      App Review notes and a demo account if a sign-in gates content.
- [ ] In-app purchases: `mpgd store products apply --store app-store`
      creates and prices them, with localizations, availability and review
      screenshots ([store product sync](./STORE_PRODUCT_SYNC.md)). Still by
      hand: the review notes the plan lists, attaching the first consumable
      and first non-consumable to the app version for review, and sandbox
      testers.
- [ ] Export compliance: answered by `ITSAppUsesNonExemptEncryption`.
- [ ] Submit for review; choose manual or phased release.

## 9. Before you press release

- [ ] One full run on real devices: install from the internal track and
      TestFlight, buy with a license tester and a sandbox account, see the
      grant from the ledger, restore on a second install, receive a push.
- [ ] Crash reporting: `mpgd target init capacitor --providers
      crash-reporting`, the Firebase files in both projects, the iOS dSYM
      upload recorded as `uploaded` for the release,
      a forced test crash seen in the Crashlytics console from each
      platform, and the crash rows of the privacy answers
      ([crash reporting](./CRASH_REPORTING.md)). Without it, at least watch
      Play Console vitals and Xcode Organizer crashes.
- [ ] Korea: advertising messages need the 광고성 정보 수신동의 consent and
      "(광고)" prefix the notifications runtime enforces; GRAC rating and
      loot-box odds disclosure if the game sells random items.
- [ ] Android advertising push on a device, on the **minified release
      build** you ship: it shows the "(광고)" label, the sender and the free
      opt-out line, and a 수신거부 button that opens the opt-out screen (warm
      and cold start); nothing shows in the foreground or after 21:00 KST
      without night consent; ordinary pushes and token refreshes still
      reach the game ([notifications live test](./NOTIFICATIONS_LIVE_TEST.md#android-advertising),
      including its required "Minified release" step).
- [ ] iOS push on a TestFlight build: a push arrives in the background, and
      a tap opens the topic's route from a warm start and from a killed app
      (the cold-start forwarder; [notifications live test](./NOTIFICATIONS_LIVE_TEST.md#ios)).

## Related

- [Native deployment](./NATIVE_DEPLOYMENT.md) and [native deploy run](./NATIVE_DEPLOY_RUN.md)
- [Google Play internal submission](./GOOGLE_PLAY_INTERNAL_SUBMISSION.md) and
  [Google Play releases](./GOOGLE_PLAY_RELEASES.md)
- [Store product sync](./STORE_PRODUCT_SYNC.md)
- [TestFlight internal submission](./TESTFLIGHT_INTERNAL_SUBMISSION.md)
- [Game services backend](./GAME_SERVICES_BACKEND.md)
- [Store privacy disclosures](./STORE_PRIVACY_DISCLOSURES.md)
- [Public release checklist](./PUBLIC_RELEASE_CHECKLIST.md) (publishing the kit itself)
