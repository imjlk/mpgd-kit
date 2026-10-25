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
- To render Android advertising pushes with the opt-out action, declare the
  kit's messaging service in place of the messaging plugin's, inside
  `<application>` of `android/app/src/main/AndroidManifest.xml` (the
  manifest root already binds `xmlns:tools`):

  ```xml
  <service android:name="dev.mpgd.capacitor.AdvertisingMessagingService" android:exported="false">
      <intent-filter>
          <action android:name="com.google.firebase.MESSAGING_EVENT" />
      </intent-filter>
      <meta-data android:name="dev.mpgd.notifications.advertising_renderer" android:value="true" />
  </service>
  <service android:name="io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService" tools:node="remove" />
  ```

  This shell does not declare it, because it bundles no messaging plugin
  for the service to forward to. `mpgd target init capacitor --providers
  notifications` writes these lines into a newly generated Android project.
- This shell's `SceneDelegate` forwards a killed-app notification tap
  (`connectionOptions.notificationResponse`) to the notification-center
  delegate on the first `capacitorViewDidAppear`. Capacitor's stock scene
  delegate does not. A shell created with `cap add ios` needs the same
  forwarder; there is no CLI template copy of `SceneDelegate.swift`.

A game created with `mpgd game create --providers notifications` is wired
already, and `mpgd target init capacitor --providers notifications` installs
the plugins into its game-owned shell; see the
[Firebase setup guide](../../docs/FIREBASE_NOTIFICATIONS.md).
