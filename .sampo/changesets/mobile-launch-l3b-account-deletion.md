---
npm/@mpgd/game-services: minor (Added)
---

Account deletion for Google Play and the App Store (`@mpgd/game-services/account-deletion`, also exported from the package root).

- `createAccountDeletionService({ erasers, identity, pending, audit })` erases every configured store, records a pending erasure, has the identity service delete the player (`AccountDeletionIdentity.deletePlayer`), erases again (each store on its own, three attempts), and writes an audit entry without the player id. A failure before the identity is deleted is a retryable `AccountDeletionError('ACCOUNT_DELETION_FAILED')`; a later one leaves the erasure pending for `finishPendingAccountErasures`, which a scheduled job runs. `createInMemoryPendingAccountErasureStore` is the reference pending store.
- Purchase grants, the revocations reversing them, and their notes are kept for five years (Korean E-Commerce Act decree, art. 6(1)), detached from the player: new random ids, the player id replaced by `deleted:<deletionId>`, the `playerId` payload key removed. Evidence ids stay, so the same store purchase is still refused for anyone. Everything else is deleted.
- `PlayerDataEraser` (`erasePlayerData`) is implemented by `InMemoryGameServicesStore` (also as the optional `GameServicesStore.erasePlayerData`), the in-memory notification store, and `InMemoryVerifiedLeaderboardService`.
- `createAccountDeletionClient({ baseUrl, getHeaders })` posts to `/game-services/account/delete` with a deadline; `AccountDeletionError.requestSent` tells a request that may have reached the server from one that never left. `createGameServicesRuntime(...)` exposes it as `accountDeletion` when it has an authoritative `baseUrl`.
