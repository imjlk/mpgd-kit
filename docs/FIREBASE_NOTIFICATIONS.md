# Firebase setup for notifications

Android and iOS notifications in mpgd-kit go through Firebase Cloud
Messaging (FCM) on both platforms: the game-services Worker sends to FCM, and
FCM relays to APNs for iOS. This guide sets up one Firebase project for a
game that was created with `mpgd game create --providers notifications`, or
that added notifications with
`mpgd target init capacitor --providers notifications`. The contract behind
it is the [notifications v2 RFC](specs/notifications/notifications-v2-rfc.md#profile-capacitor);
the game-side flow is in the [notifications guide](NOTIFICATIONS.md).

What this guide covers is configuration. Nothing in the kit verifies that a
device receives a push: run the steps below on real devices before release.

## 1. The plugins

The game-owned shell (`apps/mobile-capacitor` in the game) needs:

- `@capacitor-firebase/messaging` 8.x: remote notifications through FCM, on
  Android and iOS.
- `@capacitor/local-notifications` 8.x: local reminders, the permission read
  (it reflects the system setting on Android 12 and lower, where the
  messaging plugin answers `granted` regardless), and the advertising
  opt-out action.

`mpgd target init capacitor --providers notifications` installs both into the
shell at the game's versions, declares them and `firebase` (which the
messaging plugin's web fallback imports, so the bundler must resolve it) in
the game, and runs `cap sync` on an existing native project.

In the shell's `capacitor.config.ts`, set
`plugins.FirebaseMessaging.presentationOptions` (for example
`['badge', 'sound', 'alert']`), without which a push that arrives while the
app is in the foreground is not shown, and `plugins.LocalNotifications.smallIcon`
(an Android drawable for local reminders). The initializer never rewrites an
existing config.

**Never install `@capacitor/push-notifications` next to them.** On iOS both
plugins claim Capacitor's one handler for remote-notification registration and
delivery, so one of them silently stops receiving tokens or taps. The
initializer refuses a game or shell that lists it; remove it first.

## 2. The Firebase project

1. Create a Firebase project (or reuse one) in the
   [Firebase console](https://console.firebase.google.com/).
2. Add an **Android app** with the shell's package id (the `--app-id` of
   `mpgd target init capacitor`) and an **iOS app** with the same bundle id.
3. Keep the project id; the Worker reads it from the service-account key.

## 3. Android

1. Download `google-services.json` for the Android app and put it at
   `apps/mobile-capacitor/android/app/google-services.json`. The Capacitor 8
   Android template applies the Google services Gradle plugin when that file
   exists; without it the push half fails closed (the provider declares no
   remote delivery) and the initializer warns. Commit it: Firebase documents
   the file as non-secret project identifiers, and `mpgd deploy run` builds
   from a pinned Git checkout, so an ignored file would drop push from
   release builds. (The APNs `.p8` key and signing files, by contrast, are
   ignored by the generated `.gitignore`.)
2. Notification channels are created by the provider at start, from the
   catalog (`targets.android.channelId`, else `mpgd-service`,
   `mpgd-requested`, or `mpgd-advertising` by purpose). Advertising always
   has its own channel, so a player can turn it off in system settings. The
   starter names them in `src/platform/capacitorNotifications.ts`.
   `register()` does not return a token until those channels exist. A
   push-only shell whose messaging plugin has no `createChannel` is
   `configuration-required` rather than announcing an address for channels
   it cannot create.

<!--
@link ../adapters/capacitor/src/notifications-provider.ts#createCapacitorNotificationProvider register waits for Android channels and refuses a token when createChannel is absent.
@evidence docs/specs/notifications/notifications-v2-rfc.md#profile-capacitor A push needs its channel before it arrives.
-->
3. `SCHEDULE_EXACT_ALARM`: the local-notifications plugin adds it to the
   merged manifest, but reminders are inexact (Android 14 denies the
   permission to new installs, and Play restricts it to alarm and calendar
   apps). A shell project the initializer generates drops it with
   `<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" tools:node="remove" />`;
   add that line to an existing project's
   `android/app/src/main/AndroidManifest.xml` (the initializer warns while it
   is missing).
4. An Android FCM notification message cannot carry action buttons, so an
   Android advertising push would arrive without the opt-out action the
   Korean rules require (a settings path in the body is not enough).
   Rendering them natively in the shell is a planned follow-up; until then
   map no advertising topic to `android`. The catalog validator refuses
   that mapping, and the notifications service will not start on a catalog
   that has it. The client still declares `advertising` so it pairs with
   the standard FCM registry. The starter's sample `events` topic is
   mapped to iOS only.

<!--
@link ../packages/catalog/src/notification-topics.ts#validateNotificationTopicCatalog An advertising topic must not map to android until the shell renders the opt-out action.
@link ../adapters/capacitor/src/notifications-provider.ts#createCapacitorNotificationProvider Android still declares advertising so it pairs with the standard FCM registry.
@evidence docs/specs/notifications/notifications-v2-rfc.md#profile-capacitor Map no advertising topic to Android until the shell renders the opt-out action.
-->

## 4. iOS

1. **APNs key.** In the Apple Developer account, create an APNs
   authentication key (`.p8`). In the Firebase console, open *Project
   settings → Cloud Messaging → Apple app configuration* and upload the key
   with its Key ID and your Team ID. One key serves development and
   production.
2. **`GoogleService-Info.plist`.** Download it for the iOS app and add it to
   the `App` target in Xcode (`apps/mobile-capacitor/ios/App/App/`). The
   initializer warns while it is missing. Commit it for the same reason as
   `google-services.json`.
3. **Capabilities.** In Xcode, add *Push Notifications* to the `App` target
   (this writes the `aps-environment` entitlement). Add *Background Modes →
   Remote notifications* only if the game handles silent data pushes; the kit
   does not send them.
4. **AppDelegate.** Follow the
   [`@capacitor-firebase/messaging` iOS setup](https://github.com/capawesome-team/capacitor-firebase/tree/main/packages/messaging#ios):
   configure Firebase at launch and forward the APNs registration callbacks to
   Capacitor, as its README shows for the plugin version you installed. The
   initializer never edits native sources.
5. Categories: the provider registers the advertising opt-out category
   `mpgd-advertising` (action `advertising-opt-out`) through the
   local-notifications plugin; the Worker's FCM sender names it in
   `apns.payload.aps.category` for advertising pushes. Registering
   categories this way replaces categories the shell registered through the
   same plugin.

## 5. The Worker

The game-services Worker sends through FCM HTTP v1 with a service account
(see [Cloudflare Worker deploy](CLOUDFLARE_WORKER_DEPLOY.md#notifications-v2)
for the full configuration):

1. In the Google Cloud console for the Firebase project, create a service
   account that may send through Firebase Cloud Messaging (for example with
   the *Firebase Cloud Messaging API Admin* role) and create a JSON key.
2. Store the whole key file as the `FCM_SERVICE_ACCOUNT` secret; never put it
   in `wrangler.toml` or the repository:

   ```sh
   pnpm --dir apps/game-services-worker exec wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json
   ```

   `FCM_PROJECT_ID` overrides the key's `project_id` when they differ.
3. Set `MPGD_NOTIFICATIONS_CATALOG` to the game's `notifications/topics.json`
   and `MPGD_NOTIFICATIONS_DEPLOYMENT` to `notifications/deployment.json`
   (both JSON vars), and apply the D1 migrations `0007_notifications.sql`
   and `0008_notification_scheduler.sql`.
4. Run the scheduler from a cron on the **Workers Paid** plan. **Every
   minute** (`crons = ["* * * * *"]`) is the recommended period there: it
   bounds how late a server reminder or a due send can be, and each run
   works only on what is due, stopping before another round would cross
   `MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET` (1,000 by default). Do not enable
   this cron on the Workers Free plan: a free-plan invocation has 10 ms of
   CPU and 50 external subrequests, which the scheduler cannot stay inside.
   A wall budget that is not shorter than the cron period is rejected. See the
   [deploy guide](CLOUDFLARE_WORKER_DEPLOY.md#notifications-v2).
   A replay of one send sets FCM `android.collapse_key` and `apns-collapse-id`
   from the send key, so a crash after HTTP 200 does not show a second
   notification.
   `MPGD_NOTIFICATIONS_CATALOG` and
   `MPGD_NOTIFICATIONS_DEPLOYMENT` are JSON vars: in `wrangler.toml` write the
   files' contents as TOML (one inline table on one line, or a
   `[vars.MPGD_NOTIFICATIONS_CATALOG]` table), put them in `vars` of a
   `wrangler.jsonc` as JSON, or paste them in the dashboard; update them
   with every catalog change.

<!-- @link ../packages/game-services/src/notifications/fcm.ts#buildFcmMessage Sets android.collapse_key and apns-collapse-id from the send key. -->
<!-- @link ../apps/game-services-worker/src/notificationsHandler.ts#runScheduledNotifications Paid-plan cron budget and subrequest stop. -->
<!-- @evidence docs/specs/notifications/notifications-v2-rfc.md#remote-delivery Collapse id and FCM payload. -->
5. The client routes (consent records, endpoint registration, reminders,
   notices) need the `GAME_SERVICES_NOTIFICATIONS_AUTH` session binding from
   the identity side, which the kit does not ship yet; a send-only Worker
   (`deliverNotification` from a game server) works without it.

## 6. Check it

The [live test runbook](NOTIFICATIONS_LIVE_TEST.md) runs these checks on
an Android emulator against a local Worker, with a driver for the server
half (`pnpm notifications:live`).

- `pnpm validate:notifications` in the game passes (it refuses the starter's
  sender contact placeholder).
- On an Android 13+ device and an iPhone: the settings screen's *Turn on
  notifications* shows the OS dialog from a tap. After one denial on iOS, or
  two on Android 13+ (a dismissed dialog counts none), the screen offers only
  *Open system settings*.
- A push that arrives with the app in the foreground is shown (it needs
  `presentationOptions`).
- A push sent through the Worker's `deliverNotification` for a `service`
  topic arrives with the app in the background, and a tap opens the topic's
  route (cold and warm starts). Verify cold starts on iOS in particular:
  a killed-app tap is only in `connectionOptions.notificationResponse`, which
  Capacitor 8.5's scene proxy does not read. The reference shell's
  `SceneDelegate` forwards it once the bridge has loaded plugins. A game
  shell generated by `cap add` still has Capacitor's stock `SceneDelegate`
  until that forwarder is copied over.
