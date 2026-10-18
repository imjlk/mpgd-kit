# MPGD Capacitor Shell

This shell receives the Phaser web build in `www/`.

Initial target builds copy web assets only. Native projects should be generated later with:

```sh
pnpm --dir apps/mobile-capacitor cap add android
pnpm --dir apps/mobile-capacitor cap add ios
```

## Notifications

This reference shell bundles no notification plugin, so a gateway built on it
has no notifications v2 provider and answers `NOTIFICATIONS_V2_UNAVAILABLE`.
To try `@mpgd/adapter-capacitor/notifications` here (see the
[adapter README](../../adapters/capacitor/README.md#notifications-v2)):

- Install `@capacitor-firebase/messaging` (with `firebase`) and
  `@capacitor/local-notifications` 8.x, never `@capacitor/push-notifications`,
  then sync. Add the Firebase project files (`google-services.json`,
  `GoogleService-Info.plist`) and, on iOS, the Push Notifications capability.
- In `capacitor.config.ts`, set `plugins.FirebaseMessaging.presentationOptions`
  (for example `['badge', 'sound', 'alert']`) and
  `plugins.LocalNotifications.smallIcon`.
- Remove the `SCHEDULE_EXACT_ALARM` permission that the local-notifications
  plugin merges into the Android manifest
  (`<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" tools:node="remove" />`):
  the provider schedules inexact reminders only.

The game template's wiring and the Firebase setup guide come with the CLI work
(C1 in the [notifications RFC](../../docs/specs/notifications/notifications-v2-rfc.md#pr-plan)).
