---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

A game created with `--providers notifications` gets a notifications backend once it has one to talk to: `createStarterNotificationBackend` now builds the notifications runtime (`@mpgd/platform/notifications-runtime`) over the game-services Worker's notification routes (`@mpgd/game-services/notifications/client`) when the game has `VITE_MPGD_GAME_SERVICES_URL` (https in production) and has set its server-backed session with the new `setStarterServerSession` in `src/platform/gameServices.ts`, and the target exposes a notifications provider. The runtime keeps its registration state in the platform storage, and the settings screen then shows the reminder, advertising, and night switches from the player's consent records. Without a URL or a session it returns `undefined`, as before.

Every generated game's `src/platform/gameServices.ts` gains `StarterServerSession`, `setStarterServerSession`, and `resolveStarterServerSession`; when a session is set, the commerce client sends its header too. Nothing changes for a game that sets none.
