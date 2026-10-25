# Store privacy disclosures

Google Play's **Data safety** form and the App Store's **App Privacy** answers
describe what the shipped app collects, including data its SDKs and its own
backend collect. The kit cannot answer them for a game: the answers depend on
which features the game turns on and on the game's own server. This page lists
what each kit feature sends off the device, so the answers can be filled in from
facts rather than guesses. Re-check it whenever the game adds an SDK.

Official references:

- Google Play: [Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
  and [account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111).
- Apple: [App privacy details](https://developer.apple.com/app-store/app-privacy-details/)
  and [privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files).

"Collected" means sent off the device to the developer or a third party. Data
the game keeps only on the device (local saves, the native secure credential
store) is not collected. Data processed only in memory still has to be entered
on Play, which marks it ephemeral. Every kit network call uses HTTPS, so
"encrypted in transit" is **yes** for kit features.

## Feature map

| Kit feature | Data sent off the device | Play Data safety type | App Store data type | Purpose | Linked to the player |
| --- | --- | --- | --- | --- | --- |
| Game services guest session (`@mpgd/game-services`, game-owned identity service) | Server-issued guest player ID, refresh token family, and the client-generated installation ID sent when the guest is issued | Personal info › **User IDs**; Device or other IDs for the installation ID | Identifiers › **User ID**; Identifiers › Device ID for the installation ID | App functionality | Yes |
| Sign-in (game-owned, later) | Provider account ID, maybe name or email | Personal info › User IDs (and Name / Email address if received) | Identifiers › User ID; Contact info › Name / Email Address if received | App functionality | Yes |
| Saves, progress, leaderboards (game services) | Save data, scores, leaderboard entries | App activity › **Other user-generated content** or **Other actions** | User Content › **Gameplay Content**; Usage Data › **Product Interaction** for scores | App functionality | Yes |
| Purchases (Play Billing / StoreKit plugins, backend ledger) | Product IDs, store transaction IDs / purchase tokens, obfuscated account ID or app account token | Financial info › **Purchase history** | Purchases › **Purchase History** | App functionality, fraud prevention | Yes |
| Rewarded ads ledger (AdMob SSV) | Reward claim records, placement, player ID | App activity › Other actions | Usage Data › Product Interaction | App functionality, fraud prevention | Yes |
| Google Mobile Ads SDK (AdMob, opt-in) | Advertising ID (Android, unless removed), IP address, device and app information, ad interactions | Device or other IDs; App activity › App interactions; App info and performance › Diagnostics; disclose **shared** with Google | Identifiers › **Device ID** whenever the shipped SDK collects a device identifier (the IDFA after ATT consent, or the app- or developer-scoped identifiers Google lists), not only with ATT; Usage Data › **Advertising Data**; Diagnostics | Advertising or marketing, analytics, fraud prevention | Depends on consent and ATT; see Google's [Play](https://developers.google.com/admob/android/privacy/play-data-disclosure) and [App Store](https://developers.google.com/admob/ios/privacy/data-disclosure) disclosure guides |
| UMP consent (AdMob) | Consent choice | Not separately listed | Not separately listed | Compliance | — |
| Push notifications (FCM, `@capacitor-firebase/messaging`) | FCM registration token, Firebase installation ID, notification consent records on the game server | Device or other IDs; App activity › Other actions for consent records | Identifiers › Device ID; Usage Data › Other Usage Data for consent records | App functionality; Developer's advertising or marketing for advertising topics | Yes |
| Game server logs (Cloudflare Worker) | IP address, user agent, request metadata | App info and performance › Diagnostics; mark it ephemeral if it is only processed in memory and not stored | Diagnostics › Other Diagnostic Data if stored | Security, fraud prevention | Usually no |
| Crash reporting | **Not in the kit yet.** Adding Crashlytics or Sentry adds crash logs and diagnostics. | App info and performance › Crash logs, Diagnostics | Diagnostics › Crash Data, Performance Data | Analytics | Depends on the SDK |
| Analytics (`@mpgd/analytics`) | **Nothing by default**: the package defines events and sinks but sends nothing until the game adds a transport. | Depends on the transport | Depends on the transport | Analytics | Depends |

Notes:

- **Play account deletion.** An app that lets players create an account must
  offer deletion in the app and through a web link entered in the Data safety
  form. Whether an automatically issued guest ID counts is a judgement call;
  it applies as soon as the game offers sign-in or account binding, so plan
  for it. The kit does not ship a deletion flow yet (tracked for the
  identity and account deletion PR, L3); the privacy policy template already
  has the section and a placeholder for the URL.
- **App Store tracking.** The kit does no tracking and never shows the App
  Tracking Transparency prompt, so "Used to track you" is **no** for kit
  features. A game that turns on personalized AdMob ads using the IDFA, or any
  other cross-app tracking, must add ATT and answer the tracking questions.
- **Advertising ID on Play.** A shell without AdMob removes
  `com.google.android.gms.permission.AD_ID` from the merged manifest, so the
  Play Console advertising ID question is "no". With AdMob the permission is
  declared and the answer is "yes" (see the [AdMob guide](https://github.com/imjlk/mpgd-kit/blob/main/adapters/capacitor/README.md#opt-in-admob-rewarded-ads)).

## iOS privacy manifest

Kit shells bundle an app-level `PrivacyInfo.xcprivacy` (`ios/App/App/`) that
declares no tracking, no tracking domains, no collected data types, and no
required-reason APIs, because the App target's own code (AppDelegate,
SceneDelegate) uses none. Capacitor core ships its own manifest, and
`@mpgd/capacitor-game-services` declares its `UserDefaults` use (reason
`CA92.1`) in the plugin's manifest. Xcode merges these into the app's privacy
report (Product › Archive, then Generate Privacy Report in the Organizer).

When the game's own native code calls a
[required-reason API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
(file timestamps, system boot time, disk space, active keyboards,
`UserDefaults`), add it to the app manifest with its reason. Third-party SDKs
(Firebase, Google Mobile Ads) ship their own manifests for their own
collection; Apple requires them for the SDKs on its commonly used SDK list.
For the data the game itself collects (for example the player ID, purchase
history, and gameplay data its server receives), add an entry to the app
manifest's `NSPrivacyCollectedDataTypes` for each type, as Apple's
[describing data use](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests)
asks. The kit's manifest leaves that array empty only because the kit-owned
shell code collects nothing; a game that uses game services fills it in. Then
compare Xcode's privacy report with the App Store answers.

## What the kit does not decide

- Age rating questionnaires (IARC on Play, App Store age rating), the Play
  target audience and Families program, and whether the game is directed at
  children.
- Retention periods and the legal entity in the privacy policy.
- Region-specific rules beyond the Korean advertising-message consent the
  notifications runtime implements (see [notifications](./NOTIFICATIONS.md)).
