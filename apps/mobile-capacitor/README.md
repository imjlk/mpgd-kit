# MPGD Capacitor Shell

This shell receives the Phaser web build in `www/`.

Initial target builds copy web assets only. Native projects should be generated later with:

```sh
pnpm --dir apps/mobile-capacitor cap add android
pnpm --dir apps/mobile-capacitor cap add ios
```

## Notifications

This reference shell bundles no notification plugin, so a Capacitor gateway
running in it registers no notifications v2 provider and answers
`NOTIFICATIONS_V2_UNAVAILABLE`.
To try `@mpgd/adapter-capacitor/notifications` here (see the
[adapter README](../../adapters/capacitor/README.md#notifications-v2)):

- Install `@capacitor-firebase/messaging` (with `firebase`) and
  `@capacitor/local-notifications` 8.x, never `@capacitor/push-notifications`,
  then sync. Add the Firebase project files (`google-services.json`,
  `GoogleService-Info.plist`) and, on iOS, the Push Notifications capability.
- In `capacitor.config.ts`, set `plugins.FirebaseMessaging.presentationOptions`
  (for example `['badge', 'sound', 'alert']`) and
  `plugins.LocalNotifications.smallIcon`.
- This shell's Android manifest already drops the `SCHEDULE_EXACT_ALARM`
  permission that the local-notifications plugin merges into it
  (`<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" tools:node="remove" />`):
  the provider schedules inexact reminders only.
  `mpgd target init capacitor --providers notifications` adds the same line to
  a game-owned shell's newly generated Android project, and warns about an
  existing one that lacks it.

A game created with `mpgd game create --providers notifications` is wired
already, and `mpgd target init capacitor --providers notifications` installs
the plugins into its game-owned shell; see the
[Firebase setup guide](../../docs/FIREBASE_NOTIFICATIONS.md).
