---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

`mpgd game create --providers notifications` (and `@mpgd/create-game --providers notifications`) adds the notifications v2 starter to a new Phaser or lite game:

- `notifications/topics.json`, a topic catalog with the starter topics `daily-ready` and `streak-at-risk` (`requested`: off until the player turns them on), `friend-challenge` (`service`), a sample `advertising` topic for Android and iOS, and the `consent-notice` topic with every `notices.copy` variant in Korean and English (decree art. 62-2 and 62-3 wording, `{{consentDate}}` in each);
- `notifications/deployment.json` with `advertisingRules: "kr"` and an advertising sender whose contact placeholder `pnpm validate:notifications` refuses until it is replaced;
- the Android and iOS gateways register the Capacitor notifications provider (FCM and local reminders, named Android channels, the opt-out action, and `openCapacitorNotificationSettings`); the Reddit gateway exposes the game-rendered opt-in and the Reddit login prompt; the generated Devvit server serves the opt-in and runs the notifications service in its scheduler tasks; the Apps in Toss wrapper reads the catalog's `targets.ait` mappings;
- `integrations.notifications: "available"` for `android`, `ios`, and `ait` (Reddit stays `approval-required` until Reddit approves the app) and `integrations.identityUpgrade: "available"` for `reddit`;
- a game-rendered notification settings screen (a Phaser scene, or a DOM panel in the lite template) for the OS or host permission, reminder topics, 광고성 정보 수신동의, and night consent, recorded through the notifications runtime; and `docs/NOTIFICATIONS.md`.

The game declares `@capacitor-firebase/messaging` 8.5.2, `@capacitor/local-notifications` 8.3.1, and `firebase` 12.19.0. Without `--providers notifications` a generated game is unchanged.
