---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

A game created with `--providers notifications` runs the notifications runtime on Reddit. The generated Devvit server serves the runtime's backend (`createDevvitNotificationsBackendBridgeHandler`) over the notifications service its scheduler tasks already run, and the Reddit gateway builder sets `createDevvitNotificationsBackend` as the starter's hosted backend (`setStarterHostedNotificationBackend` in `src/platform/notificationBackend.ts`, used only for that config target and created on first use). The settings screen then shows the reminder switches on Reddit once the player is logged in; advertising and night consent stay off there, since Devvit delivers `service` and `requested` topics only. The kit's and the template's Devvit server bridges take the backend handler as `notificationsBackend` and answer `NOTIFICATIONS_CONFIGURATION_REQUIRED` without it.
