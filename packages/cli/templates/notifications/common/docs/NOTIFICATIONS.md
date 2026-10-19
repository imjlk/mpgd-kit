# Notifications in __GAME_TITLE__

This game was created with `mpgd game create --providers notifications`. The
mpgd-kit notifications guide (`docs/NOTIFICATIONS.md` in mpgd-kit) explains
the whole flow; this page lists what the starter put in this game and what is
left for you.

## Files

| File | What it is |
| --- | --- |
| `notifications/topics.json` | The topic catalog: each topic's purpose, channels, routes, copy, and per-target mapping. The one source for every target and the backend. |
| `notifications/deployment.json` | The backend settings: `advertisingRules` (`kr`), the advertising sender, and the zone. |
| `src/platform/notifications.ts` | Reads the catalog for a target, and the place to return your notifications runtime. |
| `src/platform/capacitorNotifications.ts` | The Android and iOS provider (FCM and local reminders), registered by the Capacitor gateways. |
| `src/platform/notificationSettings.ts` | The settings screen's logic: permission, reminders, advertising and night consent, notices. |
| `src/platform/notificationOpens.ts` | The game's one listener for notification opens: the settings route, and an `other` route for your topics. |
| `src/scenes/NotificationSettingsScene.ts` or `src/lite/notificationSettingsPanel.ts` | The settings screen the game renders. |
| `tools/validate-notifications.ts` | `pnpm validate:notifications`. |

## Before you release

1. Replace `REPLACE-WITH-SENDER-PHONE-OR-ADDRESS` in
   `notifications/deployment.json` with the sender's phone number or
   address. Every advertising push carries it under the Korean rules, and
   `pnpm validate:notifications` fails until you do.
2. Keep the sender in `notices.copy` (`[__GAME_TITLE__]` in every variant) the
   same as `advertisingSender.name` in `notifications/deployment.json`: a
   consent notice must name the sender.
3. Run `pnpm validate:notifications` after every catalog change.
4. Decide each topic's purpose with your own legal review. The starter's
   `daily-ready` and `streak-at-risk` are `requested`: off until the player
   turns them on, and their copy states only the player's own progress. If
   you add a reward, a benefit, or a promotion to them, or send them to
   players who did not turn them on, declare them `advertising` instead.
5. Android and iOS: set up Firebase (see the mpgd-kit Firebase guide,
   `docs/FIREBASE_NOTIFICATIONS.md`), then run
   `mpgd target init capacitor --providers notifications` to install the two
   plugins into the game-owned shell. Never install
   `@capacitor/push-notifications` next to them.
6. Apps in Toss: register each functional-message template in the console and
   add its code to the topic's `targets.ait` mapping
   (`{ "templateSetCode": "...", "agreement": "required" }`). Apps in Toss
   cannot deliver advertising topics.
7. Reddit: apply for Devvit notifications; keep `integrations.notifications`
   at `approval-required` until Reddit approves the app and its copy.

## The notifications runtime

Consent records (reminders, 광고성 정보 수신동의, night consent), endpoint
registration, server reminders, and consent notices go through the game
backend. The kit does not ship that runtime's backend client yet, so
`createStarterNotificationRuntime` returns `undefined` and the settings screen
asks only for the OS or host permission (and withdraws a Devvit opt-in the
game rendered). Return a `NotificationRuntime` there
once your backend serves the notification routes.
