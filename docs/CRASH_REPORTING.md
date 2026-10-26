# Crash reporting

A game shipped through the Capacitor shell can send crash reports to
**Firebase Crashlytics** on Android and iOS. It is opt-in per game: a game
that does not ask for it ships without the SDK and behaves as before.

What the kit covers:

- Native crashes on Android and iOS, captured by the Crashlytics SDK itself.
- Uncaught JavaScript errors and unhandled promise rejections in the WebView,
  sent as non-fatal reports.
- `gateway.crashReporter`: `recordError`, `log`, and a collection toggle for
  the player's choice, behind the `CrashReporter` port in
  `@mpgd/platform/crash-reporting`.

What it does not cover yet: uploading iOS dSYMs from `mpgd deploy run`
([symbols](#symbols)), and a real run against a Firebase project. The CLI and
adapter are tested with fakes; the Android shell with the plugin compiles and
starts on an emulator with a placeholder Firebase configuration (Crashlytics
initializes, then fails to fetch its settings, as expected). No report has
been seen in a Firebase console from the kit, and no iOS build with the plugin
has run yet.

## Why Crashlytics

Compared with Sentry, the other common choice for a Capacitor app:

| | Firebase Crashlytics | Sentry |
| --- | --- | --- |
| Cost | No charge ([Firebase pricing](https://firebase.google.com/pricing)) | Free Developer plan with 5k errors and one user; Team from $26/month on annual billing ([pricing](https://sentry.io/pricing/)) |
| Native crashes | Android and iOS through the Firebase SDKs | Android and iOS through `@sentry/capacitor` |
| JavaScript errors | Only what the app records (`recordException`); the kit forwards uncaught errors and rejections. Frames stay minified: no source maps | Automatic, with source maps ([Capacitor guide](https://docs.sentry.io/platforms/javascript/guides/capacitor/)) |
| Symbols | Android: the Gradle plugin uploads R8 mapping files itself. iOS: dSYM run script or `upload-symbols` | `sentry-cli` or the wizard, for dSYMs, mappings and source maps |
| Offline | Reports are stored on the device and sent on the next launch | Supported by the SDK |
| New vendor | No: the kit already uses Firebase for push, so the same `google-services.json` and `GoogleService-Info.plist` work | Yes: a DSN, a second privacy entry, and another SDK |

The kit defaults to Crashlytics: it costs nothing, it adds no vendor to a
game that already sends notifications, and it needs no secrets in the build.
The main cost is that JavaScript stack traces are not symbolicated, so a game
that mostly fails in JavaScript gets less detail than Sentry would give. The
`CrashReporter` port does not depend on Crashlytics, so a Sentry reporter can
be passed to the gateway (`crashReporting: { reporter }`) later.

## Turn it on

```sh
mpgd target init capacitor --app-id <id> --display-name <name> --providers crash-reporting
```

Combine it with other providers (`--providers notifications,crash-reporting`).
The initializer:

- adds `@capacitor-firebase/crashlytics` 8.5.2 to the shell package
  (`apps/mobile-capacitor/package.json`) and records the provider in
  `mpgd.native-shell.json`. The game package does not change: the adapter
  reaches the native plugin by its registered name.
- in an Android project it generates, adds the Crashlytics Gradle plugin
  3.0.8: the classpath in `android/build.gradle` next to `google-services`,
  and `apply plugin: 'com.google.firebase.crashlytics'` in
  `android/app/build.gradle` inside the template's `google-services.json`
  check.
- refuses an **existing** Android project that does not apply the Gradle
  plugin, and prints the two lines to add. The Crashlytics Android SDK stops
  the app at startup when the build ID that plugin writes is missing
  ([source](https://github.com/firebase/firebase-android-sdk/blob/main/firebase-crashlytics/src/main/java/com/google/firebase/crashlytics/internal/common/CrashlyticsCore.java)),
  so the plugin is never installed into such a project.
- prints the iOS dSYM steps until the Xcode project runs the Crashlytics
  script.

Then add the Firebase files, the same ones notifications use
([Firebase setup](FIREBASE_NOTIFICATIONS.md)): `google-services.json` in
`android/app/` and `GoogleService-Info.plist` in the App target; the
initializer warns while either is missing. Without them Firebase does not
start and nothing is collected. On Android `getStatus()` then reports
`not-configured`; the iOS plugin only logs the missing plist and still calls
Crashlytics, which has not been checked on a device, so never ship the iOS
plugin without the plist. The plugin's own setup notes are in its
[README](https://github.com/capawesome-team/capacitor-firebase/tree/main/packages/crashlytics).

`mpgd target build android|ios production` enforces this: while the shell
lists the plugin, a production build fails when `android/app/google-services.json`
is missing or empty, when the Android app module does not apply the
Crashlytics Gradle plugin, or when the iOS App target does not bundle
`GoogleService-Info.plist`. Other profiles print the same findings and build.

The Gradle plugin 3.0.8 needs the Android Gradle plugin 8.1+, Gradle 8.0+
and the Google services plugin 4.4.1+
([Firebase](https://firebase.google.com/docs/crashlytics/android/get-started));
the Capacitor 8 template has 8.13.0, 8.14.3 and 4.4.4.

## In the game

`createCapacitorPlatformGateway` turns crash reporting on when the shell has
the plugin; nothing in the game template changes.

```ts
const reporter = gateway.crashReporter;
try {
  loadLevel(id);
} catch (error) {
  await reporter?.recordError(error);
  showLevelLoadFailure();
}
await reporter?.log(`level ${id} started`);
```

- Every method resolves; a reporter never throws into game code.
  `recordError` resolves `true` when the report reached Crashlytics. Without the
  plugin, `getStatus()` reports `not-installed` and the calls do nothing.
- Uncaught errors and unhandled rejections are reported as non-fatal, once
  per distinct error and at most 8 per session: Crashlytics keeps only the
  latest eight non-fatal reports of a session and sends them on the next
  launch ([Android](https://firebase.google.com/docs/crashlytics/android/customize-crash-reports),
  [iOS](https://firebase.google.com/docs/crashlytics/ios/customize-crash-reports)).
  The listeners are removed by `gateway.lifecycle.dispose()`. Pass
  `crashReporting: { captureGlobalErrors: false }` to the gateway factory to
  report only what the game records, or `crashReporting: false` to leave
  `gateway.crashReporter` out.
- Each report's message starts with its source: `[game]`, `[uncaught]` or
  `[unhandled-rejection]`.

### What a report carries

Custom keys, set when the gateway is created so native crashes carry them too: `mpgd_target`,
`mpgd_build_id`, `mpgd_app_version`, `mpgd_adapter`, and any keys passed as
`crashReporting: { context }` (lowercase snake_case keys not starting with
`mpgd_`, plain values; put
the kit or content version here if the game tracks it). The kit never sets a
Crashlytics user ID and never sends the player ID.

Messages, breadcrumbs and context strings go through `redactCrashText`:
URL query strings and fragments, e-mail addresses, bearer tokens, JWTs and
long tokens with digits are replaced, and text is cut to 1,024 characters.
Thrown values that are not errors are never serialized. Stack frames keep
only the function name, the file path (no origin, no query) and the line.
Redaction is a safety net, not a licence: do not put player data in error
messages or logs.

### The player's choice

Crashlytics collects by default. A settings toggle calls
`reporter.setCollectionEnabled(enabled)`: the SDK keeps the choice across
launches, turning it off deletes reports not sent yet and stops JavaScript
reports at once, and the native change may only take full effect on the next
launch (the plugin says so for `setEnabled`). Android cannot read the SDK's
choice back, so the reporter also keeps it in the WebView's `localStorage`
(`mpgd.crashReporting.collectionEnabled`) and applies it to JavaScript
reports at the next start; on iOS it falls back to the SDK's value. Pass
`crashReporting: { collectionPreference }` to keep it elsewhere.

If the game's privacy policy needs consent **before** anything is collected,
create the gateway with `crashReporting: { requireConsent: true }`, turn
automatic collection off in the shell, and call `setCollectionEnabled(true)`
once the player agrees (or `setCollectionEnabled(false)` when they decline,
which deletes what the SDK holds). With `requireConsent` the reporter sends no
JavaScript report or breadcrumb until the player has turned collection on,
in this launch or an earlier one. The shell keys:

- Android, `AndroidManifest.xml` inside `<application>`:
  `<meta-data android:name="firebase_crashlytics_collection_enabled" android:value="false" />`
- iOS, `Info.plist`: `FirebaseCrashlyticsCollectionEnabled` = `NO`

([Android](https://firebase.google.com/docs/crashlytics/android/customize-crash-reports),
[iOS](https://firebase.google.com/docs/crashlytics/ios/customize-crash-reports)).
The initializer does not add these keys. While collection is off the SDK
keeps native crash reports on the device instead of sending them; whether it
sends them once collection is turned on was not checked, so decline with
`setCollectionEnabled(false)` rather than by never answering.

## Symbols

**Android.** The kit's shells build with `minifyEnabled false`, so there is
no R8 mapping file and stack traces are readable as is. A game that turns R8
on gets its mapping file uploaded by the Crashlytics Gradle plugin during the
release build; set `firebaseCrashlytics { mappingFileUploadEnabled false }`
in a build type to skip it
([Firebase](https://firebase.google.com/docs/crashlytics/android/get-deobfuscated-reports)).
The upload needs network access from the build machine.

**iOS.** Release builds already produce dSYMs (`DEBUG_INFORMATION_FORMAT =
dwarf-with-dsym`). Crashlytics needs them uploaded for readable native
frames. Either:

1. Add a Run Script build phase as the **last** phase of the App target, with
   the Swift Package Manager script and input files the plugin README and
   Firebase list
   ([Firebase](https://firebase.google.com/docs/crashlytics/ios/get-deobfuscated-reports)):

   ```sh
   "${BUILD_DIR%/Build/*}/SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/run"
   ```

   Input files:

   ```text
   ${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}
   ${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${PRODUCT_NAME}
   ${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Info.plist
   $(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/GoogleService-Info.plist
   $(TARGET_BUILD_DIR)/$(EXECUTABLE_PATH)
   ```

2. Or upload after each archive, from the shell's `ios/App` directory, with
   the `upload-symbols` tool that ships next to that script in the
   `firebase-ios-sdk` package checkout:

   ```sh
   UPLOAD="$(find ~/Library/Developer/Xcode/DerivedData -path '*/SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/upload-symbols' | head -n 1)"
   "$UPLOAD" -gsp App/GoogleService-Info.plist -p ios /path/to/App.xcarchive/dSYMs
   ```

   A zip of the dSYMs can also be dropped on the Crashlytics dSYMs tab in the
   Firebase console.

Running the upload from `mpgd deploy run` / `deploy submit` is a follow-up
once those commands settle (mobile launch L4/L4p).

**JavaScript.** Crashlytics has no source map support, so JavaScript frames
point into the minified bundle. The `mpgd_build_id` key names the build; keep
that build's source maps outside the app (for example Vite
`build.sourcemap: 'hidden'`) to map a frame by hand.

## Check it on a device

1. Build and install a release-like build with the Firebase files in place.
2. Once the game has started (the gateway registers the plugin), open the
   WebView inspector (Chrome `chrome://inspect` for Android, Safari Web
   Inspector for iOS) and run
   `Capacitor.Plugins.FirebaseCrashlytics.crash({ message: 'mpgd test crash' })`.
   On iOS, run the app without the Xcode debugger attached, or the debugger
   catches the crash first.
3. Start the app again so the report is sent, then look in the Firebase
   console under Crashlytics. Also throw an error from the game
   (`setTimeout(() => { throw new Error('mpgd test') })`) and look for the
   `[uncaught]` non-fatal report.

## Privacy answers

Crash reporting adds crash logs, diagnostics and the Crashlytics
installation UUID to the store answers; the rows are in
[store privacy disclosures](STORE_PRIVACY_DISCLOSURES.md).
