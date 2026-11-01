---
npm/@mpgd/cli: minor (Added)
---

A game created with `--providers notifications` shows the consent notices the server lists once per launch. After the notifications runtime starts, `showStarterLaunchNotices` reads the listed notices and shows them, overdue ones first, in a small box at the top that never pauses the game (`src/platform/launchNoticesBanner.ts`), then records them as given. The Phaser template calls it from `createGame` (`showNotificationLaunchNotices`), and the lite panel calls it when it mounts. Under the Korean rules advertising to a player now pauses while a re-confirmation is past its due date and unrecorded, so this is how a player who never opens the settings screen ends the pause. `StarterNotificationBackend` carries `started`, which settles once the runtime has started, and `readStarterLaunchNotices` holds the shared logic.
