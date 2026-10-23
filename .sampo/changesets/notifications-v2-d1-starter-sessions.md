---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

The starter's `serverSession.ts` recommends `createGuestServerSession(coordinator)` from `@mpgd/game-services`: it answers the coordinator's stable `sessionFamilyId`, which the notifications runtime and the game-services Worker need, instead of a view's rotating `sessionId`.

Generated games gain `src/platform/developmentServerSession.ts`. On the Vite dev server in the development mode, `VITE_MPGD_DEV_NOTIFICATION_SESSION=<playerId>` (or `<playerId>.<installationId>`) signs the game in with an unauthenticated development session, so the notification settings record consent against a local Worker run with `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS` before the game has an identity service. A normal `vite build` drops it. Any `setStarterServerSession` call turns it off, and the first call after it was in use warns. The game's notifications guide gains a "Try it locally" section. `mpgd target init capacitor --providers notifications` writes the new module next to `serverSession.ts`, and leaves it out, with a warning, for a game whose own `serverSession.ts` does not import it.
