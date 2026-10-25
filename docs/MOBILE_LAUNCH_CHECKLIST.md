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
  some: check the AAB with the APK Analyzer. The kit does not check this.

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
      with the store SKUs; create the same products in Play Console and App
      Store Connect by hand **(open: catalog sync to the stores)**.
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
- [ ] AdMob only: Android `com.google.android.gms.ads.APPLICATION_ID`
      meta-data, iOS `GADApplicationIdentifier` and `SKAdNetworkItems`
      ([AdMob setup](https://github.com/imjlk/mpgd-kit/blob/main/adapters/capacitor/README.md#opt-in-admob-rewarded-ads)).
      The kit never shows the ATT prompt; add it only if the game tracks.
- [ ] Push: Xcode Push Notifications capability, Firebase files, AppDelegate
      forwarding ([Firebase notifications](./FIREBASE_NOTIFICATIONS.md)).

## 4. Backend

- [ ] Worker deployed with D1 and the cron, game-owned identity service for
      guest sessions, purchase verification for Play and the App Store, AdMob
      SSV if ads grant rewards ([game services backend](./GAME_SERVICES_BACKEND.md),
      [AdMob SSV](./ADMOB_SSV.md)).
- [ ] App Review buys with sandbox accounts against your production backend:
      make sure sandbox purchases are verified and kept apart from production
      grants **(open: L2, store server handling)**.
- [ ] Refunds and voided purchases (Play RTDN / voided purchases, App Store
      Server Notifications V2), and a server-side retry of a missed Play
      acknowledgement (Play refunds unacknowledged purchases after 3 days)
      **(open: L2)**.

## 5. Identity and account deletion

- [ ] A signed-in session for purchases: StoreKit and Play purchases are bound
      to the authenticated player, so a guest cannot buy or restore. The
      template's Restore Purchases control says so **(open: L3, identity)**.
- [ ] In-app account deletion and a web deletion URL. Play requires both for
      apps that create accounts
      ([Play account deletion](https://support.google.com/googleplay/android-developer/answer/13327111));
      the App Store requires in-app deletion (guideline 5.1.1(v))
      **(open: L3)**. Put the URL into the privacy policy and the Play Data
      safety form.

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
- [ ] Android goes to the **internal** track only. The first upload of a new
      app may have to be rolled out from the console. Closed, open and
      production tracks, staged rollout and release notes are console steps
      for now **(open: Play track expansion)**.
- [ ] iOS goes to an internal TestFlight group. The submission reports
      `action-required` while TestFlight waits for the export-compliance
      answer ([TestFlight](./TESTFLIGHT_INTERNAL_SUBMISSION.md)).
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
- [ ] In-app products with prices; license testers.
- [ ] Closed test with 12+ testers for 14 days (new personal accounts), then
      apply for production access.

App Store Connect:

- [ ] App information, age rating questionnaire, App Privacy answers, privacy
      policy URL, support URL, marketing URL (the legal site).
- [ ] Screenshots in the sizes App Store Connect asks for (currently the
      6.9-inch iPhone set and, for a universal app, the 13-inch iPad set);
      App Review notes and a demo account if a sign-in gates content.
- [ ] In-app purchases created, priced, and attached to the version; sandbox
      testers.
- [ ] Export compliance: answered by `ITSAppUsesNonExemptEncryption`.
- [ ] Submit for review; choose manual or phased release.

## 9. Before you press release

- [ ] One full run on real devices: install from the internal track and
      TestFlight, buy with a license tester and a sandbox account, see the
      grant from the ledger, restore on a second install, receive a push.
- [ ] Crash reporting **(open: crash reporting)**: the kit ships none; at
      least watch Play Console vitals and Xcode Organizer crashes.
- [ ] Korea: advertising messages need the 광고성 정보 수신동의 consent and
      "(광고)" prefix the notifications runtime enforces; GRAC rating and
      loot-box odds disclosure if the game sells random items.

## Related

- [Native deployment](./NATIVE_DEPLOYMENT.md) and [native deploy run](./NATIVE_DEPLOY_RUN.md)
- [Google Play internal submission](./GOOGLE_PLAY_INTERNAL_SUBMISSION.md)
- [TestFlight internal submission](./TESTFLIGHT_INTERNAL_SUBMISSION.md)
- [Game services backend](./GAME_SERVICES_BACKEND.md)
- [Store privacy disclosures](./STORE_PRIVACY_DISCLOSURES.md)
- [Public release checklist](./PUBLIC_RELEASE_CHECKLIST.md) (publishing the kit itself)
