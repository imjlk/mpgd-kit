# @mpgd/game-services

## 0.32.0 — 2026-10-29

### Added

- [b85c2a06](https://github.com/imjlk/mpgd-kit/commit/b85c2a068adb871da772190436eece21b3839fec) Allow hosted web and Microsoft Store PWA production targets to use a clean same-origin `/api` game-services path for an authoritative edge service binding. Keep absolute public HTTPS requirements for native and third-party runtimes, and reject protocol-relative, encoded, traversal, query and fragment paths.
  
  Add the DOM-free `resolveGameServicesBaseUrl` composition helper and wire starter commerce/notification clients to resolve a hosted path against the actual browser origin before the existing absolute-URL authority checks. Invalid or native relative inputs remain fail-closed without a backend fallback.
  
  Add `isHostedGameServicesPath` to `@mpgd/platform/routes`, re-exported from `@mpgd/game-services`: the one rule for a clean same-origin ingress path, shared by the CLI's production readiness check and `resolveGameServicesBaseUrl`. — Thanks @imjlk!

### Fixed

- [fa2c44b4](https://github.com/imjlk/mpgd-kit/commit/fa2c44b4533d74df106a70aa6a75971a376a2ae3) Restore Purchases reads a parked another-account record from the journal again before it resends it. A journal that bounds parked records (the starter journal now does) may drop one that a running reconciler still holds in memory; the resend then failed the pass with a journal write error. A record the journal no longer holds for the player is forgotten, and the store's report is matched as a purchase the journal does not know: a new record under its derived key, sent as a restore. The same holds when another context's save drops the record between that read and Restore's rewrite: the failed rewrite forgets it instead of failing the pass. — Thanks @imjlk!

### Changed

- [3ffc437c](https://github.com/imjlk/mpgd-kit/commit/3ffc437cee459cec101be7f849e6384cc41e3630) A verify whose store binding names another account is no longer a terminal rejection. When one player's session verifies another player's Google Play or App Store purchase, the reference verifiers answer `{ status: 'rejected', reason, anotherAccount: true }` (new `EvidenceVerificationDecision` field) once every other check passed, and `createGameServicesBackend` grants and records nothing and throws the new `GameServicesPurchaseBoundToAnotherAccountError` (`code` `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT`, `reason`, `status` 409). The HTTP handler answers it as 409 `{ error: 'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT', reason }` (new `GameServicesBackendErrorCode` member and `reason` field), the oRPC router as that error code with `data.reason` (409 through `createGameServicesRpcFetchHandler`), and analytics tracks `purchase_rejected` with `boundToAnotherAccount` (a failed analytics report never replaces the answer). oRPC 2.0.0-beta.46 errors carry no status, so a host that mounts `createGameServicesRouter` in its own `RPCHandler` passes the new `gameServicesRpcErrorStatusMap` as `errorStatusMap` to answer 409. A restorable purchase bound to another account that restore sharing does not cover (policy `refuse`, a game-started checkout, a consumable) gets the same answer instead of `rejected`. Restore sharing and the holder limit are unchanged; a restorable decision for a purchase bound to no account now carries the `*_MISSING` reason below, is still shared under `share`, and is refused for good (`rejected`) without a share.
  
  The commerce reconciler parks such a record instead of ending it: it stays `verifying` with the new `anotherAccount: { reason, reportedAt }` field, is reported with the new `another-account` reconciler event (not a `failure`), is never resent by start, resume, or event passes, is left out of `listRecoverable()`, summarizes as `rejected` for its player, and is sent again only by that player's Restore Purchases when the store reports the purchase again, as a restore with the evidence the store reports then; it stays parked when that resend fails in transport. Its shared journal key no longer refuses another player of the install, who journals the purchase under its own player-scoped key (consumables included), so the purchase's own account recovers it on the same device. A `rejected` receipt with `GOOGLE_PLAY_ACCOUNT_MISMATCH`, `GOOGLE_PLAY_PROFILE_MISMATCH`, or `APP_STORE_ACCOUNT_TOKEN_MISMATCH` (an older backend, or a game server that maps every refusal to `rejected`) is parked the same way, and a terminal record from an older client with one of those reasons also leaves the key to the owner. New exports: `purchaseBoundToAnotherAccountCode`, `purchaseBoundToAnotherAccountStatus`, `storeAccountMismatchReasons`, `isStoreAccountMismatchReason`, `readPurchaseBoundToAnotherAccount`, `createPurchaseBoundToAnotherAccountBody`, `isParkedForAnotherAccount`, `gameServicesRpcErrorStatusMap`. A game that switches over `CommerceReconcilerEvent` handles the new `another-account` member.
  
  A purchase bound to no account is no account's and stays `rejected`, now with its own reason so the mismatch reasons mean only "another account": `GOOGLE_PLAY_ACCOUNT_ID_MISSING` and `GOOGLE_PLAY_PROFILE_ID_MISSING` (was `GOOGLE_PLAY_ACCOUNT_MISMATCH` / `GOOGLE_PLAY_PROFILE_MISMATCH`), `GOOGLE_PLAY_ACCOUNT_BINDING_UNEXPECTED` for a bound purchase on a backend that binds nobody (was `GOOGLE_PLAY_ACCOUNT_MISMATCH`), and `APP_STORE_ACCOUNT_TOKEN_MISSING` (was `APP_STORE_ACCOUNT_TOKEN_MISMATCH`). An App Store transaction with another token whose other checks fail (revoked, wrong product type) now reports that check's reason instead of the token mismatch.
  
  Released clients (0.27 to 0.31) treat the 409 as a transport failure: the record stays `verifying` and is resent on later passes, instead of ending as `rejected`. A game server that wraps the verifiers should pass the answer through: catch `GameServicesPurchaseBoundToAnotherAccountError` from `backend.purchases.verifyPurchase` (or check `decision.anotherAccount === true` when it calls a verifier itself) and answer 409 with `createPurchaseBoundToAnotherAccountBody(reason)` instead of a `rejected` receipt; see "Another account's purchase" in `docs/GAME_SERVICES_BACKEND.md`. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/analytics@0.5.7, @mpgd/catalog@0.14.1, @mpgd/platform@0.34.0

## 0.31.0 — 2026-10-28

### Added

- [ae7b0f77](https://github.com/imjlk/mpgd-kit/commit/ae7b0f77120c1eb73c92c0249c9048cafa8a9d4f) `createGameServicesRuntime` and `createGameServicesClient` take `commerceStaleLaunchedAfterMs`, passed to the commerce reconciler as `staleLaunchedAfterMs`. It sets how long a `launched` purchase with no store purchase keeps its product serialized before it ends `failed`. The default stays 24 hours, and `Infinity` never expires the attempt. A value that is not a positive number (zero, negative, `NaN`) is refused with a `RangeError` where it enters, also when no reconciler is built. — Thanks @imjlk!
- [6458a154](https://github.com/imjlk/mpgd-kit/commit/6458a154a7b31a1a09b89ee52b378797508a9320) A game services runtime now fails closed when its player is no longer the session's. New `GameServicesRuntime.dispose()` closes a runtime for good and resolves once a purchase whose store sheet is open has journaled its answer and the commerce reconciler has stopped (each wait bounded by `gameServicesDisposeWaitMs`, 3 minutes; idempotent; a disabled runtime has nothing to close). New `sessionPlayerId` input on `createGameServicesRuntime`: it is read before every backend request and again once that request's headers are resolved, and by the commerce reconciler (new `sessionCheck` input on `createCommerceReconciler`, failure stage `session`) before each pass, queued event, record step, store read, restore, and finish, and right before a store UI opens. When it names another player the runtime closes, so one player's journaled purchases are never verified, restored, or finished with another player's credentials (which Google Play and App Store verification reject for good as an account mismatch) and no store UI opens for a purchase journaled under one player once the session names another (the provider's account binding must follow the runtime's player as well, as the generated game's does, for that purchase never to be bound to the other store account). A closed runtime answers purchases with `failed` and the retryable diagnostic `GAME_SERVICES_PLAYER_CHANGED` (or `GAME_SERVICES_RUNTIME_DISPOSED`) before any store UI, rewarded-ad claims with `unavailable` before any ad (also one queued before it closed), runs no recovery, and rejects Restore Purchases and leaderboard submissions with `GameServicesRuntimeClosedError`; while the session names no player it refuses with `GAME_SERVICES_SESSION_REQUIRED` and stays open. Refusals end no journal record, so a runtime created for that player later resumes them. New `commerceAccountBinding` runtime input (reconciler `accountBinding`): this player's store account binding, derived from `playerId`; a store purchase bound to another account is left alone (reported, never journaled or verified for this player), so after a restart as another player the previous player's unacknowledged Google Play purchases are not rejected for good under this player's session and their derived keys stay free for that player's own recovery; the player's explicit Restore Purchases still takes a durable bound to another account (restore sharing). A reconciler started while the session is signed out still subscribes; its work waits for the session. `GameServicesRuntimeClosedError` now passes through header resolution and the HTTP transport unchanged instead of becoming `GameServicesHeaderResolutionError` or `GameServicesBackendTransportError`.
  
  `GameServicesRuntime.dispose()` is now a required member. A custom or fake `GameServicesRuntime` object adds `dispose: async () => undefined` to keep compiling.
  
  A game adopting this creates its runtime from its server session's player (never a platform placeholder), passes `sessionPlayerId` and `commerceAccountBinding`, keeps its store account binding resolver on the same player (binding nothing for anyone else), sends only the headers the runtime resolved from a custom `httpTransport`, and awaits `dispose()` before creating a runtime for another player. — Thanks @imjlk!

### Changed

- [e984b9fe](https://github.com/imjlk/mpgd-kit/commit/e984b9fede2a1aabe9bb820e27debe31570fb170) oRPC moves from 2.0.0-beta.14 to exactly `2.0.0-beta.46` (`@orpc/client`, `@orpc/contract`, and `@orpc/server`, all pinned with no range). Use the same exact version for any oRPC a game or Worker uses directly. oRPC 2.0.0-beta.34 removed the `inferable` flag from RPC error bodies, and each oRPC version rejects the other's error shape. The oRPC transport now bridges both directions so that games and Workers from different releases keep their error codes (`BAD_REQUEST`, `NOT_FOUND`, and the commerce reconciler's "unpublished" detection):
  
  - `createGameServicesRpcFetchHandler` adds `inferable: false` to error bodies.
  - `createGameServicesOrpcClient` removes a boolean `inferable` from error bodies before oRPC validates them.
  
  Success responses are unchanged. Any other oRPC 2.0.0-beta.34+ client calling a game-services Worker (a plain `RPCLink`) must wrap its fetch with the newly exported `withLegacyOrpcErrorCompat` from `@mpgd/game-services/client`. A Worker can stop writing the flag with the new `legacyOrpcErrorFlag: false` option of `createGameServicesRpcFetchHandler` once no client from 0.30.5 or older is supported. This shim lives in one module (`orpc-error-compat.ts`) and will be removed once the oldest supported client and Worker both come from `@mpgd/game-services` 0.31.0 or later.
  
  This is a minor release because of the GET and `Infinity` changes below and the new option and export.
  
  Two other behaviour changes come with the new oRPC:
  
  - RPC routes now accept only POST, PUT, PATCH, and DELETE. A GET, including a cross-site GET, now answers 404 instead of running the procedure. The kit's clients always POST.
  - An `Infinity` input is now encoded with its own meta marker, which a Worker on 0.30.5 or older cannot decode.
  
  The request body limit is now applied through oRPC's `RequestLimitHandlerPlugin`. Oversized bodies still answer 413 `PAYLOAD_TOO_LARGE`. — Thanks @imjlk!

### Fixed

- [ae7b0f77](https://github.com/imjlk/mpgd-kit/commit/ae7b0f77120c1eb73c92c0249c9048cafa8a9d4f) The commerce reconciler marks a `client` finish of a record that was already `finishing` (an earlier attempt or session) with `retry: true`, so StoreKit can close a lost acknowledgement; the first finish after the grant never carries it. It also finishes a consumable again when a `client`-finish store reports it after its record is `finished`. A store lists a consumable only while it is unfinished, so this covers a transaction whose finish was reported done before StoreKit listed it (an entry the native read skipped as unverifiable). It uses the journaled ledger entry, at most once per session (a transport failure is retried on the next report), and never verifies the purchase again or rewrites the record. Durables and other finish owners are unchanged. — Thanks @imjlk!
- [ae7b0f77](https://github.com/imjlk/mpgd-kit/commit/ae7b0f77120c1eb73c92c0249c9048cafa8a9d4f) The reference backend answers a verify for a consumable of a `client`-finish registry entry (the App Store) that this player already holds under another idempotency key with that recorded grant (`verified`, `alreadyProcessed: true`, the same ledger entry) instead of `EVIDENCE_ALREADY_PROCESSED`. That is the client asking under the derived key once its journal dropped the finished record while StoreKit still lists the transaction; the client can now finish it instead of StoreKit re-delivering it on every launch. Nothing new is granted. Another player, a durable, a reversed grant, and a backend without a registry keep the refusal. — Thanks @imjlk!
- [e9bc9b39](https://github.com/imjlk/mpgd-kit/commit/e9bc9b398c3fab4fda9a1418fbd1268be6b69033) `GameServicesRuntime.dispose()` now also waits for a startup or resume recovery pass under way (`monetizationRecovery.reconcile()`), within the same `gameServicesDisposeWaitMs` bound as an open purchase or rewarded ad, before it stops the commerce reconciler. Before, a pass still awaiting the journal could start the reconciler after `dispose()` had stopped it and leave a disposed runtime subscribed to the store. New optional `closed` input on `createCommerceReconciler` (and `commerceClosed` on `createGameServicesClient`): while it answers true, `start()` subscribes nothing and starts nothing. It is read when `start()` is called and again right before the subscription, after the journal read. The runtime passes its closed-for-good state, so neither a pass that outlives the dispose wait nor a start still reading the journal when the dispose wait ran out subscribes. A signed-out session is not closed, and a reconciler without the input keeps its `stop()` then `start()` behaviour. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/analytics@0.5.6, @mpgd/catalog@0.14.0, @mpgd/platform@0.33.0

## 0.30.5 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/catalog@0.13.0

## 0.30.4 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/catalog@0.12.0

## 0.30.3 — 2026-10-27

### Fixed

- [dd045e6b](https://github.com/imjlk/mpgd-kit/commit/dd045e6b2ce851b48ea8c97e133030730878196a) The commerce reconciler no longer resends a restore the backend answered `pending` with `PURCHASE_HOLDER_LIMIT_REACHED` on every start, resume, and store event. Only the player's next Restore Purchases (`restorePurchases()`) sends the saved request again, since a holder may have been freed by then (a deleted account, a revoked grant); nothing an automatic pass observes frees one. The record stays `pending` for the game to report. Other backend-pending answers, `PURCHASE_HOLDER_CONFLICT` included, keep their retries. — Thanks @imjlk!
- [dd045e6b](https://github.com/imjlk/mpgd-kit/commit/dd045e6b2ce851b48ea8c97e133030730878196a) Restore Purchases works after a logout on the same install. The commerce reconciler's journal key of a purchase discovered from the store (`createCommercePurchaseOperationKey(target, derivedKey)`) is the same for every player of the install, so the next guest's restore of a non-consumable the earlier guest had journaled failed as "bound to another player" and sent nothing. On the player's Restore Purchases, a discovered durable whose key another player's record holds is now journaled under the new player-scoped key (`createCommercePurchaseOperationKey(target, derivedKey, playerId)`) and sent as this player's restore under the same derived idempotency key; the backend's restore sharing decides it. Start, resume, and event passes, and consumables, subscriptions, products of unknown kind, and game-started keys held by another player, stay refused: one player's purchase is never sent for another, and a purchase a normal read lists for the earlier player (an unacknowledged Google Play purchase) is never shared without the player asking. Existing journals need no migration: records keep their keys and each player still finds its own. `reconciler.read()` also answers this player's record under the player-scoped key and still refuses any other key another player's record holds. A custom `MonetizationOperationStore` must treat `record.key` as opaque; see `docs/MONETIZATION_RECOVERY.md`. — Thanks @imjlk!

## 0.30.2 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/analytics@0.5.5, @mpgd/catalog@0.11.3, @mpgd/platform@0.32.0

## 0.30.1 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/analytics@0.5.4, @mpgd/catalog@0.11.2, @mpgd/platform@0.31.0

## 0.30.0 — 2026-10-26

### Changed

- [718801f9](https://github.com/imjlk/mpgd-kit/commit/718801f9b9544fc9be505dc5994cb81974bdea48) Restore Purchases now reaches restore sharing after a reinstall or on a new device. `GetAvailablePurchasesInput.restore?: boolean` (and `StoreSdkGetAvailablePurchasesInput.restore`, which `createStoreCommerceProvider` passes through) marks the player's explicit Restore Purchases read: a store whose recovery list hides owned non-consumables (Google Play's acknowledged items, StoreKit entitlements bound to another app account token) lists them too. The commerce reconciler's `restorePurchases()` makes that read (an event provider directly, a polled one through the pass it runs), so those purchases reach the backend as discovered purchases with `intent: 'restore'`; `start()`, `reconcile()`, and event passes keep the recovery read, so an acknowledged durable is not resent on every launch. Providers without such a filter ignore the field. The commerce bridge payload schema for `commerce.v2.getAvailablePurchases` accepts `restore`. A bridge host built before it rejects the field; the reconciler then reports the failed restore read (`failure` stage `available`) and still makes the recovery read, so Restore Purchases never finds less than before. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/analytics@0.5.3, @mpgd/catalog@0.11.1, @mpgd/platform@0.30.0

## 0.29.0 — 2026-10-26

### Changed

- [6ce27613](https://github.com/imjlk/mpgd-kit/commit/6ce27613a430cde2cf13ffd7bac4e842f29cb296) AR1 behaviour changes for outside callers. The FCM provider now refuses routing data keys that start with `mpgd.` (`rejected`, reason `configuration`), which the Android advertising renderer uses. The Capacitor notifications provider leaves `mpgd.` keys out of an open's `data`. `CapacitorGameServicesPlugin` gains `getAdvertisingPushRenderer()`, so a hand-written mock of the interface needs it. — Thanks @imjlk!
- [6d19d236](https://github.com/imjlk/mpgd-kit/commit/6d19d2360692af820140224bc5274a053899da95) Store server handling for a first App Store and Google Play launch.
  
  - App Review sandbox purchases: `createAppStoreGameServicesEvidenceVerifier` accepts `sandboxPurchases` (default `{ mode: 'reject' }`, unchanged). On a `Production` verifier, `{ mode: 'grant', signedTransactionVerifier, serverApi? }` follows Apple's production-first order: a transaction is verified against production, and only a JWS the production verifier places in the sandbox (or, without a client JWS, a production `APP_STORE_TRANSACTION_NOT_FOUND`) is verified again with the sandbox verifier and Server API. Sandbox grants keep `appStoreEnvironment: 'Sandbox'` and their own verification id. A Server API answer from another environment than the client JWS is `APP_STORE_SIGNED_TRANSACTION_ENVIRONMENT_MISMATCH`. `createAppStoreRecoveryBackend` takes `restoredNonConsumables.acceptsSandboxTransactions`.
  - Family Sharing: `AppStoreTransactionPayload` carries `inAppOwnershipType`; a `FAMILY_SHARED` transaction is refused with `APP_STORE_FAMILY_SHARED_UNSUPPORTED` (another non-`PURCHASED` value with `APP_STORE_OWNERSHIP_UNSUPPORTED`). `createAppleSignedTransactionVerifier` now answers `APP_STORE_ENVIRONMENT_MISMATCH` (not `APP_STORE_SIGNATURE_INVALID`) for a correctly signed JWS of the other environment.
  - App Store Server Notifications V2: new subpath `@mpgd/game-services/app-store-server-notifications` with `handleAppStoreServerNotification` and `appStoreServerNotificationHttpStatus`; `REFUND` of a granted one-time purchase appends one `revoke` entry keyed by `notificationUUID` (`REVOKE` is handled the same way, but a family-shared transaction is ignored and the purchaser keeps the grant). `createAppleServerNotificationVerifier` in `@mpgd/game-services/app-store-server` verifies the `signedPayload` and its transaction with Apple's library.
  - Google Play: new subpath `@mpgd/game-services/google-play-store-server` with `sweepGooglePlayVoidedPurchases`, `revokeGooglePlayVoidedPurchase`, and `retryGooglePlayPurchaseFinalization` (server-side acknowledge or consume from the ledger grant and a kept purchase token). `createGooglePlayPublisherClient` gains `listVoidedPurchases`; `createGooglePlayProductVerificationId` is exported from `google-play-purchase`.
  - `findPurchaseGrantByEvidenceVerificationId` is exported from `@mpgd/game-services`.
  - Refund reversals: an App Store `REFUND_REVERSED` for a grant an App Store refund revoked is answered `refund_reversed` and kept as a ledger note (`EntitlementLedgerNote`, `assertEntitlementLedgerNote`), once per `notificationUUID`; nothing is re-granted. A `REFUND` or `REVOKE` for a transaction the ledger holds no grant for yet is `retry` for `unmatchedRefundRetryMs` (a new `handleAppStoreServerNotification` option, `defaultUnmatchedRefundRetryMs` = 1 hour, at most 6 hours) after Apple revoked it, so a purchase still committing its grant is revoked on Apple's redelivery, then `ignored`. For a `REFUND_REVERSED` on a grant not revoked yet it is `retry` (with its `notificationUUID`), so a refund still being redelivered is applied first; for a grant revoked for another reason it is `ignored`. `GameServicesStore` gains the optional `recordEntitlementNote` and `findEntitlementNotes`, which the in-memory store implements.
  
  Changed reasons: a correctly signed JWS of the other environment is now `APP_STORE_ENVIRONMENT_MISMATCH` (was `APP_STORE_SIGNATURE_INVALID`), and a family-shared transaction is `APP_STORE_FAMILY_SHARED_UNSUPPORTED` (was `APP_STORE_ACCOUNT_TOKEN_MISMATCH`). Both stay rejections; code that matched the old reason strings should match the new ones. — Thanks @imjlk!

### Added

- [78e90728](https://github.com/imjlk/mpgd-kit/commit/78e907288f96d2a301a31fbac201c6de7a7c1990) Restore sharing: a verified restore of a non-consumable that the store binds to another player (a reinstall on Android, a new iOS device, a second device on the same store account, a logout) can grant the restoring player its own entitlement while earlier holders keep theirs.
  
  - `createGameServicesBackend` takes `restoreSharing` (`PurchaseRestoreSharingPolicy`): `{ mode: 'share', maxHolders? }` (default 5 players per purchase, 1 to 100) or `{ mode: 'refuse' }`, the default, which keeps answering the binding mismatch. `sharePurchaseRestores`, `refusePurchaseRestoreSharing`, and `resolvePurchaseRestoreSharingPolicy` are exported; a deleted player's retained record (`isRetainedPlayerId`) does not count toward `maxHolders`.
  - `VerifyPurchaseRequest.intent?: 'purchase' | 'restore'` (validated); the commerce reconciler sends `restore` for purchases it discovered from the store. `VerifyPurchaseResponse.restoredAcrossPlayers?: true` marks a grant restored from a purchase another player made or holds.
  - `EvidenceVerificationDecision` gains `{ status: 'restorable', reason, ... }`. The Google Play boundary answers it for a restore of a non-consumable whose only failed check is the account binding (`GOOGLE_PLAY_ACCOUNT_MISMATCH` / `GOOGLE_PLAY_PROFILE_MISMATCH`, including a purchase with no ids); the App Store verifier for `APP_STORE_ACCOUNT_TOKEN_MISMATCH` when the client's StoreKit-verified JWS is present. Every other request is answered as before. Ad reward claims and `createAppStoreRecoveryBackend` treat it as a refusal; code that switches on `status` exhaustively must handle it.
  - Ledger: shares are ordinary grants (no migration): evidence id `createPurchaseHolderEvidenceVerificationId(purchaseId, slot)` (`<purchaseId>#mpgd-holder:<slot>`) at the slot after the highest, under the request's key, so the holder limit holds when restores race and a player that already holds the purchase gets its grant back. `GameServicesStore` gains the optional `findEntitlementTransactionsByEvidencePrefix` (the in-memory store implements it), which lists a purchase's shares in one read, past gaps the retention purge leaves; without it shares are read slot by slot. `listPurchaseHolders`, `readPurchaseVerificationId`, and `isRestoredAcrossPlayers` are exported. `revokeEntitlementGrant` with a store reason (`refund`, `chargeback`, `voided`) on a purchase grant now also revokes every other holder of the purchase, reading the holders again until none is active (a share written meanwhile is revoked too); an `admin` revocation stays on its grant.
  - Answers: `verified` with `restoredAcrossPlayers: true`; `pending` `PURCHASE_HOLDER_LIMIT_REACHED` at the limit (nobody is evicted) and `PURCHASE_HOLDER_CONFLICT` after repeated lost races; `rejected` `LEDGER_GRANT_REVERSED` for a refunded purchase. Consumables and subscriptions are never shared. — Thanks @imjlk!
- [cdcfeba7](https://github.com/imjlk/mpgd-kit/commit/cdcfeba796d06cae539e3daec621718e20af58c2) Account deletion for Google Play and the App Store (`@mpgd/game-services/account-deletion`, also exported from the package root).
  
  - `createAccountDeletionService({ erasers, identity, pending, audit })` records a pending erasure, has the identity service delete the player (`AccountDeletionIdentity.deletePlayer`), erases every configured store (each on its own, three attempts), and writes an audit entry without the player id. A failure before the identity is deleted is a retryable `AccountDeletionError('ACCOUNT_DELETION_FAILED')` and erases nothing; a later one leaves the erasure pending for `finishPendingAccountErasures`, which a scheduled job runs. `createInMemoryPendingAccountErasureStore` is the reference pending store.
  - Purchase grants, the revocations reversing them, and their notes are kept for five years (Korean E-Commerce Act decree, art. 6(1)), detached from the player: new random ids, the player id replaced by `deleted:<deletionId>`, the `playerId` payload key removed. Evidence ids stay, so the same store purchase is still refused for anyone. Everything else is deleted.
  - `PlayerDataEraser` (`erasePlayerData`) is implemented by `InMemoryGameServicesStore` (also as the optional `GameServicesStore.erasePlayerData`), the in-memory notification store, and `InMemoryVerifiedLeaderboardService`.
  - A deletion needs more than an access token: `deleteAccount({ confirmation })` sends a short-lived, single-use confirmation from the identity service in `X-MPGD-Account-Deletion-Confirmation` (`accountDeletionConfirmationHeader`, at most `accountDeletionConfirmationMaxLength` characters), which the server checks through `AccountDeletionConfirmationVerifier.verifyAccountDeletionConfirmation` before erasing anything; a refused one is `AccountDeletionError('ACCOUNT_DELETION_CONFIRMATION_REQUIRED')`.
  - **Breaking** for custom `GuestSessionCoordinator` implementations: the interface gains the required `requestAccountDeletionConfirmation()`, and `GuestSessionCoordinatorErrorCode` gains `GUEST_SESSION_UNSUPPORTED`. Guest sessions ask for that confirmation (`@mpgd/game-services/guest-session`): `guestIdentityHttpRoutes.requestAccountDeletionConfirmation` (`POST /identity/v1/account-deletion-confirmation`, `{ refreshToken }` → `AccountDeletionConfirmationGrant`), the optional `GuestSessionBackend.requestAccountDeletionConfirmation` (implemented by `createGuestSessionHttpBackend`), `GuestSessionCoordinator.requestAccountDeletionConfirmation()` (queued with refreshes; `GUEST_SESSION_REJECTED` for a session the service refused, now or in an earlier refresh; `GUEST_SESSION_UNSUPPORTED` for a backend without it), and the optional `GuestServerSession.requestAccountDeletionConfirmation()` from `createGuestServerSession`.
  - `createAccountDeletionClient({ baseUrl, getHeaders })` posts to `/game-services/account/delete` with a deadline; `AccountDeletionError.requestSent` tells a request that may have reached the server from one that never left. `createGameServicesRuntime(...)` exposes it as `accountDeletion` when it has an authoritative `baseUrl`. — Thanks @imjlk!
- [d358f084](https://github.com/imjlk/mpgd-kit/commit/d358f08493ab2e466d6958b02ecab074786abba2) Guest sessions over HTTP. `createGuestSessionHttpBackend({ baseUrl })` from `@mpgd/game-services/guest-session` is a `GuestSessionBackend` over the routes in `guestIdentityHttpRoutes` (`/identity/v1/guest`, `/identity/v1/refresh`, `/identity/v1/revoke`, `/identity/v1/bind-account`), which the reference identity Worker serves: `https:` only (or `http:` on a local development host), no redirects, a 15-second timeout, and a `200` that is not a JSON object counts as a failure. A refresh token the identity service refuses for good throws `GuestSessionRejectedError`, and the coordinator now reports it as the new `GUEST_SESSION_REJECTED` code instead of `GUEST_SESSION_BACKEND_FAILED`, and stops using that session (`current()` is `undefined`, later calls fail with `GUEST_SESSION_NOT_READY` without a request), so a game can log out and start a new guest instead of retrying a dead token. — Thanks @imjlk!
- [6ce27613](https://github.com/imjlk/mpgd-kit/commit/6ce27613a430cde2cf13ffd7bac4e842f29cb296) Android advertising pushes the shell renders (AR1). The notifications service keeps a device registration's `rendersAdvertising` only for a target in `notificationShellRenderedAdvertisingTargets` (`android`), and under the Korean rules sends an advertising topic to an Android installation only when its latest registration says its shell renders advertising; another one is `suppressed: purpose-unsupported`. The FCM provider sends such a push as a data message without a `notification` block (`fcmShellRenderedDataKeys`: the rendered title and body, the channel, the opt-out action's title and route (the topic's declared opt-out route), and the expiry in epoch milliseconds, next to `topic`, `route`, and the send's data), at FCM's default normal priority, which the shell's messaging service renders with the opt-out action. Routing data keys that start with `mpgd.` are now refused by the FCM provider (`rejected`, reason `configuration`, before anything is sent), as FCM's own reserved keys are. iOS sends and every other purpose are unchanged. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/analytics@0.5.2, @mpgd/catalog@0.11.0, @mpgd/platform@0.29.0

## 0.28.1 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/analytics@0.5.1, @mpgd/catalog@0.10.8, @mpgd/platform@0.28.0

## 0.28.0 — 2026-10-24

### Added

- [fc9158f3](https://github.com/imjlk/mpgd-kit/commit/fc9158f34c54c1d88cafc040e7584e0fa9ebb69b) Guest sessions carry a stable session-family id. `ServerGuestSessionCredentials` gains an optional `sessionFamilyId` (`null` reads as absent), and every `ServerGuestSessionView` carries a resolved one: the backend's, or, for a backend that omits it, one the coordinator derives that changes only where the backend's family might (a new guest, a bound account whose `sessionId` changed, or a restore whose saved family cannot be read). The derived family is saved in the same secure storage under `<credentialKey>.family`, written before the refresh token and removed at logout. `GuestSessionCoordinator` gains `current()` and `onSession(listener)`; code that implements the interface itself, or builds a `ServerGuestSessionView` by hand, adds them and `sessionFamilyId`.

  `createGuestServerSession(coordinator)` reads a coordinator as the server-backed session the notifications client takes (and the starter's `setStarterServerSession`): `current()` answers the server user as `playerId` and the family id as `sessionId`, `onAuthenticated` hears a new family but not a refresh, and `getHeaders()` refreshes an expired access token before answering and one that expires within `refreshAheadMs` (a minute by default) in the background, once per token and at most every ten seconds.

  For local development, `createDevelopmentServerSession({ mode, playerId, installationId })` gives an unauthenticated session whose header (`Bearer mpgd-dev.<playerId>.<sessionId>.<installationId>`) a game-services Worker accepts only with `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true"` on its memory store and on a local host (loopback, `*.localhost`, or the Android emulator's `10.0.2.2`); it throws in the production mode. `formatDevelopmentNotificationSessionAuthorization` and `parseDevelopmentNotificationSessionAuthorization` share the header format. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.5.0

## 0.27.2 — 2026-10-21

### Fixed

- [b918119c](https://github.com/imjlk/mpgd-kit/commit/b918119c26437b13d6ca4a7e57a3104b81fe0687) `createAitFunctionalMessageDeliveryProvider` refuses an `agreementFailReasons` entry that is empty or longer than 1,024 characters once trimmed, with a `TypeError` at creation. The provider reads at most 1,024 characters of a `reachedFailReason`, so a longer entry could never match, and an empty one would have matched a blank reason as an agreement denial. A game-services Worker with such an `MPGD_AIT_NOTIFICATIONS` setting reports its notifications as misconfigured, as for any other invalid setting. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/analytics@0.4.16, @mpgd/catalog@0.10.7, @mpgd/platform@0.27.2

## 0.27.1 — 2026-10-21

### Patch changes

- [26d789ea](https://github.com/imjlk/mpgd-kit/commit/26d789ea20c24feb00dd1749cf742d11404acf3b) An unconsumed Microsoft Store claim is no longer replaced when Collections returns a new modified date or item id, so one quantity-1 unit cannot be granted twice before consume. The verification id uses the Collections `transactionId` when present, and otherwise the collection item id plus `modifiedDate`. A later query that changes `modifiedDate` while that claim is unreleased resumes the stored generation and does not write a second ledger row. After consume and release, a repeat purchase with the same item id, no `transactionId`, and a new `modifiedDate` gets a new id and grants once. A purchase already recorded under `microsoft-store:<storeId>:<itemId>:<modifiedDate>` keeps that ledger key on re-verify. An exact generation that was already granted can still be finalized after Collections returns a different item or transaction id; that resume keeps the stored verification id and does not grant a second time. A tracking-id retry releases that claim only when it omits order ids, reports a numeric current balance, and echoes the granted item or the item Collections currently lists for that product. A missing, malformed, or unrelated consume response keeps the claim pending. A different provider purchase can be claimed only after the previous claim is released. — Thanks @imjlk!
- Updated dependencies: @mpgd/analytics@0.4.15, @mpgd/catalog@0.10.6, @mpgd/platform@0.27.1

## 0.27.0 — 2026-10-21

### Patch changes

- [395f194f](https://github.com/imjlk/mpgd-kit/commit/395f194f04205a0bf58bdf505297cefb9698d31c) Fix notifications v2 so a notice the game has recorded is not pushed, a cancel or replace does not drop a live delivery claim (which could send the same reminder twice), one provider's host-read failure does not fail every provider, and a reminder whose template data cannot fill its copy or a host-template mapping's own title and body is refused when it is set. An uncompilable link rule fails the set for every provider that would deliver the topic. Replacing a due reminder while its send is only claimed keeps the replacement pending until that claim settles, instead of marking it fired with no delivery. — Thanks @imjlk!
- [61e9c8d4](https://github.com/imjlk/mpgd-kit/commit/61e9c8d4b747de10521aa5c54068eadde0b40d09) Harden notifications delivery. FCM sets `android.collapse_key` and `apns-collapse-id` to the SHA-256 of the send key (64 bytes) so a replay after HTTP 200 collapses instead of showing a duplicate. Apps in Toss functional-message `baseUrl` must be `apps-in-toss-api.toss.im` unless `allowUnlistedHost` is set. Documented partner error codes (4095, 5004, 4034, 4010) are classified before a deployment's `agreementErrorCodes` or `recipientErrorCodes`, so a rate limit is not stored as an agreement denial. — Thanks @imjlk!
- [c6438977](https://github.com/imjlk/mpgd-kit/commit/c6438977f3be174f4e351597366d935c37950b90) An advertising topic must not map to `android` until the shell renders the opt-out action. `validateNotificationTopicCatalog` reports that mapping, and a notifications service will not start on a catalog that has it. iOS advertising mappings are unchanged. The Android client still declares `advertising` so it pairs with the standard FCM registry. — Thanks @imjlk!
- Updated dependencies: @mpgd/analytics@0.4.14, @mpgd/catalog@0.10.5, @mpgd/platform@0.27.0

### Added

- [f772a896](https://github.com/imjlk/mpgd-kit/commit/f772a8964437d512349736e609668792b480fbc1) `@mpgd/game-services/notifications/client` adds `createGameServicesNotificationsClient`, the notifications runtime's backend over the game-services Worker's session routes (`/game-services/notifications`: consent, endpoints, reminders, notices) and its public `GET /providers`. It takes the commerce client's `baseUrl`, `fetch`, `headers`, and `getHeaders`, so a game gives both clients one header resolver, and the deployment `target` the Worker needs for a device registration. The game's identity supplies the current `{ playerId, sessionId }` and an authenticated subscription; no request carries a player or an installation, which the Worker reads from the session. Worker answers map to the codes the runtime acts on (`GameServicesNotificationsRequestError`, with the status and the Worker's error): a 401 is a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, a 404 or 405 on a session route `NOTIFICATIONS_CONFIGURATION_REQUIRED`, a 400 or 413 `NOTIFICATIONS_INVALID_INPUT`, and an answer outside the route's contract `NOTIFICATIONS_CONFIGURATION_REQUIRED`. A request still unanswered after `timeoutMs` (15 seconds by default) is aborted and answers a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, so no runtime queue waits on it. Every conformance vector the service passes also passes with the runtime calling it through this client.
  
  `resolveGameServicesRequestHeaders`, `GameServicesHeaderResolver`, and `GameServicesHeaderResolutionError` move to an internal module and are still exported from the package root and `./client`. `isPublicGameServicesUrl` exports the production URL rule the authoritative commerce backend already follows, so other clients that send a session's credentials can share it. — Thanks @imjlk!

## 0.26.0 — 2026-10-20

### Changed

- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) Under the Korean advertising rules, `assertNotificationDeployment` refuses an advertising sender name, contact, or opt-out line that is still a common template marker (a `REPLACE-WITH-…` marker; a whole value that is an unreplaced `__TOKEN__`, `{{token}}`, `${token}`, `<token>`, or `[token]`; a reserved `example.com` address; or only `TODO`/`TBD`/`CHANGEME`/`PLACEHOLDER`/`XXX`), so a backend built from the starter's deployment file fails closed instead of sending advertising with an unusable sender line. `isNotificationPlaceholderText` and `notificationDeploymentPlaceholders` export the check, and `assertNotificationDeployment(input, { allowPlaceholders: true })` lets a validator report placeholders itself.
  
  `createNotificationService` and `createNotificationServiceCatalog` in `@mpgd/game-services` assert the deployment, so they now throw for such a deployment, and the game-services Worker reports its notifications as misconfigured. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/analytics@0.4.13, @mpgd/catalog@0.10.4, @mpgd/platform@0.26.0

## 0.25.1 — 2026-10-19

### Patch changes

- Updated dependencies: analytics@0.4.12, catalog@0.10.3, platform@0.25.0

## 0.25.0 — 2026-10-19

### Minor changes

- [07b1cb72](https://github.com/imjlk/mpgd-kit/commit/07b1cb72d5e1843238dda6bdc904d7c3227c8795) Add server reminders and the notifications scheduler to `@mpgd/game-services/notifications`. `setReminder` and `cancelReminder` are the backend half of the runtime's `reminders.set` and `reminders.cancel`: gate steps 3 to 5 run when a reminder is set, a refusal stores nothing, and one reminder per player and key is kept, so a replace or a cancel also stops a send of the previous one that still waits. `runScheduler` fires due reminders as `reminder:` sends through the policy gate, pushes the consent notices nobody recorded by seven days before they are due through the catalog's notice topic under the Korean rules (recorded as given once delivered; a refused push is tried again after an hour, doubling to a day), and then dispatches due rows at no more than each provider's registry `rate`, through the dispatch queue when one is bound. Each consent write compacts the player's history once records are a day old, keeping the latest of each kind and scope and the advertising and night records a notice still needs. The first ambiguous replay now waits the claim lease instead of twice it. With a dispatch queue bound, `dispatchDue` takes due rows for the queue (their result is `in-flight`) instead of sending them inline, and a queue job runs any row no holder claims; the `onError` context gains `fromProvider` for a provider's own failure, whose message a host should not log; `InMemoryNotificationStoreState` gains `schedule`. Consent records are no longer kept whole: compaction deletes the ones no rule reads. The service passes every conformance vector except the per-send one.

  A player keeps at most `maxPendingNotificationReminders` (64) pending server reminders (a new key past them answers `capacity-exceeded`) with a `fireAt` at most `notificationReminderHorizonDays` (90) ahead; a set answers `unavailable` when no provider the player can be reached on maps the topic, checks a reminder's link as the gate does, and refuses `templateData` while any host-template provider would deliver the topic, reached now or not. A scheduler run goes on in batches until nothing is due or its time budget (`budgetMs`, 20 seconds by default, measured by the new `elapsedMs` service option, `performance.now()` unless injected) is used, with one provider pace across the run.

  A custom `NotificationStore` implements seven more steps, pinned by `runNotificationStoreConformance`: `getScheduleEntry`, `createScheduleEntry`, `updateScheduleEntry`, and `listDueScheduleEntries` (scheduler entries with a version compare-and-set and a due index), `countPendingReminders` (a player's pending server reminders, for the cap), `countHistory` (a provider's deliveries between `since` and `until`, both inclusive, for pacing), and `pruneConsent` (deletes records by instant with the notices given about them). `createInMemoryNotificationStore` now refuses a time that does not parse, as the game-services Worker's D1 store does. — Thanks @imjlk!
- [a6690e9e](https://github.com/imjlk/mpgd-kit/commit/a6690e9e734195fee0478be50078b4955f0bef34) Add `@mpgd/game-services/notifications/ait-functional-delivery`: `createAitFunctionalMessageDeliveryProvider` sends one Apps in Toss functional message per recipient over an injected mTLS fetcher (a Workers mTLS binding) and answers the notifications v2 provider answers: 4095 is `rate-limited` with `retryAfterSeconds`; 5004, 4034, and 4010 are `rejected` for configuration; `HTTP_TIMEOUT`, `NETWORK_ERROR`, `EXECUTION_FAIL`, `INTERRUPTED`, `INTERNAL_ERROR`, HTTP 5xx, and transport failures are `ambiguous`; HTTP 429 is `rate-limited` whatever its body; a `SUCCESS` answer is `accepted` when `msgCount` is above 0 or any channel sent the message, and otherwise rejected per its channel failures. Its request and answers fit the game-services delivery-provider contract structurally (a platform-user recipient, with `recipientKey` naming the partner key type). Deployments name the recipient-level and missing-agreement codes they observe, which the partner API does not document. — Thanks @imjlk!
- [089efeb0](https://github.com/imjlk/mpgd-kit/commit/089efeb0dd6ca4d3f5efb218b97b8f3e9fadfbe2) Add the notifications v2 server as `@mpgd/game-services/notifications`: a provider registry whose entries are the policy gate's only capability input, with per-target topic mappings when two targets share a provider (FCM on `android` and `ios`); an endpoint registry bound to the game-services session, whose stored session end follows the end any authenticated call reports (a custom `NotificationStore` implements `extendSessionEndpoints` for it), with dead and stale endpoints; append-only consent records dated by the backend, where a repeat of the latest permission, agreement, or preference record is not written (an `advertising` or `night` record, a player's act that may owe a notice, always is) and a player may add `maxClientNotificationConsentRecordsPerDay` (200) client records per rolling day before `NotificationConsentRateLimitError`; the notices API; and sends through the idempotency ledger, `evaluateNotificationDelivery`, device fan-out (inline or through a dispatch queue that runs the gate at the provider call), the five provider answers with rate-limit backoff, due-row replays, and retention purges. `createInMemoryNotificationStore` is the reference store. The service passes every server conformance vector except those that need the S2 scheduler and the per-send allowance vector (the registry refuses per-send providers). The v1 `notification-delivery` module is unchanged.

  The FCM provider sends through HTTP v1 `messages:send` with an OAuth token minted from a service-account JWT signed with WebCrypto, so it runs on Cloudflare Workers. It caches the token in memory, maps FCM errors to the provider answers, and carries an expiry as `android.ttl` and `apns-expiration`.

  `@mpgd/game-services/notifications/store-conformance` exports `runNotificationStoreConformance`, the behavior every durable notifications store must have; the in-memory store and the game-services Worker's D1 store pass it. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.4.11, catalog@0.10.2, platform@0.24.0

## 0.24.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.4.10, catalog@0.10.1, platform@0.23.1

## 0.24.0 — 2026-10-15

### Minor changes

- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: commerce v2, PR C4 removes the v1 purchase path from the game-services
  client. The commerce reconciler over `gateway.commerce` (a `CommerceProvider`)
  is the only purchase path, and nothing is granted from a client callback.
  
  - `createGameServicesClient` and `createRecoverableMonetizationClient` buy only
    through the reconciler. A gateway without `gateway.commerce` sells nothing:
    `purchase()` answers `{ status: 'rejected', purchase: { status: 'failed',
    entitlementIds: [] } }`, reports `purchase_rejected` with the analytics reason
    `commerce_unavailable`, opens no store UI, sends nothing to the backend, and
    the client has no `commerceReconciler`. It reads `gateway.commerce` (it read
    `gateway.commerceV2`).
  - Removed: `RecoverableMonetizationClient.recoverPurchaseResult` (the reconciler
    learns results from the provider's `getAvailablePurchases` and
    `purchaseUpdated` events; `recoverRewardResult` is unchanged),
    `authoritative-purchase.ts` (`findAdapterSettledGrant`,
    `isAuthoritativeMicrosoftStoreCompletion`; a settling provider is now verified
    through one request like any other and the ledger entry comes from the
    backend's answer), `GameServicesLegacyStoreTarget`, and
    `createGooglePlayTokenTransactionId` from
    `@mpgd/game-services/google-play-purchase` (use
    `createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce`).
  - A leftover v1 `purchase` journal record is retired. It is still a valid
    `MonetizationOperationRecord` (`RetiredPurchaseOperationRecord`, part of
    `LegacyMonetizationOperationRecord`) so a durable journal parses it. Nothing
    starts, reopens, or grants from it, and the store UI is never reopened. The
    one thing `reconcile()` and `restorePurchases()` still do is finish an
    in-flight verification: a record with a completed platform result and no
    terminal result (`isMonetizationOperationRecoverable` answers `true` for
    exactly that) sends its saved verify request, or the one its own fields
    describe, to the backend once more under the same idempotency key, journals
    the backend's answer as the closing result (`granted` or `rejected`), and
    reports it; a backend outage leaves it open for the next pass. A retired
    record whose platform never completed is closed without a request (the
    store lists whatever it still holds, and the reconciler verifies that under
    a derived key). Rewarded-ad records are unchanged.
  - Entitlement reads: the v1 `gateway.commerce.getEntitlements()` has no client
    replacement. Read the backend ledger on the server with
    `listActiveEntitlementTransactions` (reversed grants subtracted) or
    `getPurchaseLedgerStatus`.
  - Progress: a store failure now ends a purchase as a journaled `failed` result,
    and a backend outage as `pending`, so those calls complete instead of ending
    in an `exception` progress event; `exception` marks a failure of the call
    itself, such as a journal write that rejects before the store opens.
  
  Retired purchase recovery rejects a saved verifier request that selects a
  different deployment from the durable journal before contacting the backend.
  
  Transient store readiness is refused before reserving a purchase journal entry,
  so the same idempotency key can be retried when the store becomes available.
  
  Provider readiness is checked before optional catalog resolution. A retryable provider failure whose presentation source proves checkout never started stays requested with its diagnostic, so the original bound key can be retried across restarts. Recovery does not reopen the payment surface; failures without that proof retain their prior terminal behavior. — Thanks @imjlk!

### Added

- [295435cd](https://github.com/imjlk/mpgd-kit/commit/295435cd3f960901596f21c6e60df4edfc749825) Reuse ait-kit for SDK 3.6 single-use anonymous authentication: expose a host code issuer and a server mTLS exchange method while retaining response bounds, cancellation, and authoritative session boundaries.
  
  Align generated AIT hosts and starter validation on official WebView SDK and CLI 3.6.0 so new projects can issue anonymous authentication codes. — Thanks @imjlk!

### Patch changes

- [dd76b8d7](https://github.com/imjlk/mpgd-kit/commit/dd76b8d736cc90b1e1d810d18745b2cd043d2c55) `@mpgd/platform/routes` exports one route-safety rule for links a game hands
  to the kit, and `@mpgd/platform/route-vectors` exports the shared `normalized`
  and `rejected` vectors that every package mapping such links runs:
  
  - `normalizeRootRelativeRoute(input)` returns the path, query, and hash a
    root-relative link names on the game's origin. It answers `undefined` when a
    client could read the link as another host: a second slash or a backslash
    after the leading slash, a control character, or a path that begins with an
    empty segment after dot segments collapse. The same holds when the path is
    percent-decoded once and parsed again, with the path ending at any decoded
    `?` or `#` or keeping them all. A path with more than 16 decoded `?` and `#`
    is refused.
  - `hasNetworkPathPrefix(pathname)` and `hasRouteControlCharacter(value)` are the
    checks it builds on. `hasNetworkPathPrefix` answers `true` for anything that
    is not a URL path.
  
  Notification delivery in `@mpgd/game-services` and Apps in Toss sharing in
  `@mpgd/adapter-ait` use this rule instead of their own copies. They now also
  refuse a path that reaches another host when a decoded `?` or `#` stays in the
  path instead of ending it, such as `/%3F%2F..%2F%2Fhost`, and a path with more
  than 16 decoded `?` and `#`.
  
  Web sharing in `@mpgd/adapter-browser` now follows the `ShareIntent.deepLink`
  contract:
  
  - A root-relative link is normalized and stays relative, so Web Share resolves
    it against the document as before.
  - An absolute link must spell out `https://` or `http://`, carry no
    credentials, and keep a path no client can read as another host.
  - It answers `unavailable` for anything else, including page-relative links
    (`./daily`, `?x=1`), `javascript:`, `data:`, and `intoss:` links, and a
    `text` or `deepLink` that is not a string. Before, it passed any string on.
  
  The Apps in Toss sandbox bridge now reads share requests exactly as the host
  bridge does:
  
  - It answers `unavailable` for a request the host refuses, and
    `{ status: 'shared', completion: 'presented' }` otherwise. Before, it
    answered `{ status: 'shared' }` for any request, which reads as completed.
  - A new optional `appName` option sets the app name `intoss://` links must
    carry. It defaults to `mpgd-kit`, as on the host. — Thanks @imjlk!
- Updated dependencies: analytics@0.4.9, catalog@0.10.0, platform@0.23.0

## 0.23.0 — 2026-10-12

### Minor changes

- [5871a314](https://github.com/imjlk/mpgd-kit/commit/5871a31405de4caddd7fbb5d252b452310dd44df) Commerce v2, PR C3: `createGameServicesRuntime({ commerceProducts })` passes
  the catalog kinds and store SKUs (`CommerceReconcilerProduct`) to the
  commerce v2 reconciler of both the plain and the recoverable client, so a
  store purchase resolves its catalog kind without a store read. Generated
  games derive the list from the product catalog's `platformProductIds` for
  the build's target. — Thanks @imjlk!

### Patch changes

- [a76fc959](https://github.com/imjlk/mpgd-kit/commit/a76fc95900c24419d772bd748f3240998189f551) Notification delivery now rejects deep links that a client could open on
  another host. Before, a root-relative link whose dot segments collapse into a
  leading `//`, such as `/.//other.example/path` (also with `%2e` dot segments),
  passed the same-origin check and normalized to the protocol-relative
  `//other.example/path`. Delivery now also rejects:
  
  - every root-relative link with a backslash right after the leading slash.
    Most were already rejected, but one naming the internal placeholder host was
    rewritten to a same-origin path, and `/\ x` threw a raw `TypeError`;
  - a path that would begin with an empty segment once percent-decoded, such as
    `/%2F/host`, `/%5Chost`, or `/%09/host`, in root-relative links and in
    absolute links on an allowed origin. A client that decodes once reads these
    as `//host`;
  - an absolute link on an allowed origin whose path starts with `//`, such as
    `https://game.example//path`, which was accepted before;
  - a link longer than 2,048 characters after normalization, so a normalized
    link always normalizes to itself. — Thanks @imjlk!

## 0.22.0 — 2026-10-12

### Minor changes

- [e7fb9c54](https://github.com/imjlk/mpgd-kit/commit/e7fb9c548f1057715bf39c3b4baf95589cdd68db) Commerce v2, PR C1: one reconciler in the game-services client replaces the
  four recovery drivers.
  
  `@mpgd/game-services/commerce-reconciler` adds `createCommerceReconciler({
  provider, backend, store, playerId, target, deploymentTarget?, products?,
  now?, onEvent? })`, the RFC "Reconciler" over any `CommerceProvider`. It
  journals every purchase the game starts or the store reports as one
  `commerce-purchase` record moving through the RFC lifecycle (`requested`,
  `launched`, `pending`, `purchased`, `verifying`, `granted`, `finishing`,
  `finished`, `cancelled`, `failed`, `rejected`, `revoked`), each transition its
  own revision through `MonetizationOperationStore.replace`, and never grants:
  only the backend's verify answer moves a record to `granted`, only the
  backend ledger moves it to `revoked`, and an adapter-settled or wallet
  purchase (`credit-wallet.spend.v1` without a `settlement` pointer included) is
  confirmed through verify like any other.
  
  - Triggers: `start()` (subscribe first, then `getAvailablePurchases` when
    declared; a provider without `lifecycle.events` is polled on every pass),
    `reconcile()` on app resume, every `purchaseUpdated` and `purchaseError`
    event, `restorePurchases()`, and the end of every `requestPurchase`.
  - One pass matches each reported purchase by store and transaction id, then
    to the single open (`launched` or `pending`) record for the player, store,
    and product, otherwise under a derived key (`store:<store>:<transactionId>`,
    with the v1 forms `play-token-sha256:<hex>` for `google-play` and
    `apps-in-toss:purchase:<orderId>` for `apps-in-toss` kept byte for byte);
    builds and saves the `VerifyPurchaseRequest` once and resends it unchanged
    while `purchased`, `verifying`, or server-side `pending`; acts on
    `lifecycle.finish` for `granted` and `finishing` records (`client` and
    `host` call `finishTransaction` with the ledger entry id, `server` resends
    the saved request until the backend reports `finalization: 'completed'`,
    `none` marks `finished`); and, when the backend offers
    `PurchaseVerificationApi.getPurchaseLedgerStatus` (new, optional; the
    reference server gains it in C2), moves reversed grants to `revoked`.
  - Purchases are serialized per player, store, and product: a second
    `requestPurchase` while one is `launched` or `pending` fails with
    `IN_PROGRESS`; a replayed key answers from the journal and never reopens
    the store UI, and a key reused for another product or source rejects;
    `OUTCOME_UNKNOWN` and `ALREADY_OWNED` keep an attempt open. A `requested`
    record left behind by a crash before the store answer was journaled, and a
    `launched` record with no store purchase after `staleLaunchedAfterMs`
    (default 24 hours; `Infinity` keeps the RFC rule without expiry), end as
    `failed` with the `OUTCOME_UNKNOWN` class so the product is not serialized
    behind them; a purchase the store reports later is journaled under its
    derived key. An error event never ends a record that already holds a store
    purchase or a saved verify request. Transport failures on verify or finish
    keep the state and are reported through `onEvent` / `subscribe` as
    `failure` events, then retried on the next pass; a client or host finish
    waits until the catalog says whether the product is consumable rather than
    guessing. The store call of `requestPurchase` runs outside the journal
    lock, so events arriving while the store sheet is open are reconciled at
    once; a refusal before the store call (`IN_PROGRESS`, `NOT_PREPARED`, an
    unknown product) leaves no record, so the same key opens the sheet on a
    retry. A backend-pending resend, a verify or finish that failed in
    transport, a finalization re-read, and a catalog lookup are retried by
    event-triggered passes at most once per `retryIntervalMs` (default one
    minute; explicit `start`, `reconcile`, and `restorePurchases` always
    retry), and the provider capability block is read again on those explicit
    triggers. Events for a product whose store call is still running wait for
    that call to journal the store answer (at most `inFlightTimeoutMs`, default
    ten minutes, after which a sheet that never settles stops deferring), so a
    purchase reported while the sheet is open is never journaled twice; a
    synchronous `purchased` answer for a transaction an open record already
    journals supersedes the attempt (`failed`, `OUTCOME_UNKNOWN`) instead of
    leaving it open.
  - A gateway with `commerceV2` but no `operationStore` journals in memory for
    the session and says so once through `warn` (default `console.warn`).
    `MonetizationOperationStore` also gains the optional
    `findByTransaction({ playerId, target, deploymentTarget, store, transactionId })`, which lets a
    transaction the store lists again after a restart (an owned durable, a
    rejected purchase) meet its terminal record instead of being verified
    again under a derived key; the in-memory store implements it.
  - `assertCommerceFinishAllowed(record)` is the finish gate: `finishTransaction`
    is only ever called for a `granted` or `finishing` record that holds the
    backend's ledger entry id and a store transaction. The v2 StoreKit SDK keeps
    no allow-list of its own (the v1 `finishGrantedTransaction` pairing is not
    reproduced); the journal revision the backend grant wrote is the pairing.
  
  `createGameServicesClient` purchases through the reconciler whenever
  `gateway.commerceV2` exists and keeps the v1 path otherwise; the client
  exposes it as `commerceReconciler`, and `CreateGameServicesClientInput`
  gains `operationStore?` (without one the journal is in memory for the
  session and the backend ledger is the duplicate backstop),
  `commerceReconciler?`, `commerceProducts?`, and `onCommerceEvent?`. The
  `purchase_granted`, `purchase_pending`, and `purchase_rejected` analytics
  events and the operation progress phases are reported as before, grants that
  arrive after the call included; the rewarded-ad path is untouched.
  `GameServicesPurchaseResult.status` gains `revoked` for a journaled purchase
  whose grant was reversed.
  
  `createRecoverableMonetizationClient` routes v2 purchases through the same
  reconciler over the durable journal, exposes it as `commerceReconciler`,
  runs it from `reconcile()` (start on the first call, a pass afterwards) next
  to the v1 records, adds `restorePurchases()`, and keeps
  `recoverPurchaseResult` as a deprecated thin wrapper that reconciles and
  answers from the journal for a v2 key (removed in C4).
  `MonetizationOperationSummary.status` gains `revoked`, and
  `finalizationPending` is true while a v2 record is `finishing`.
  `createGameServicesRuntime` wires the recovery client's reconciler into
  `runtime.client.commerceReconciler`.
  
  `MonetizationOperationRecord` gains the `commerce-purchase` kind
  (`CommercePurchaseOperationRecord`; the v1 kinds are
  `LegacyMonetizationOperationRecord`), `MonetizationOperationStore` gains the
  optional `listGranted(playerId)` read (granted, finishing, and finished
  records within the retention window) that the revocation pass and the
  transaction match after a restart use, and
  `@mpgd/game-services/monetization-operation-store` exports
  `isMonetizationOperationRecoverable` (the `listRecoverable` rule for every
  kind), `isMonetizationOperationGranted`, and
  `createInMemoryMonetizationOperationStore` (session-only, for tests and
  clients without a durable store).
  
  Type-level changes a consumer may have to follow, kept to a minor release
  because the kit is at 0.x and every one of them is additive at runtime: code
  that reads `result`, `platform`, or `input` on a `MonetizationOperationRecord`
  must narrow on `kind` first (the v1 kinds are unchanged);
  `GameServicesPurchaseResult.status` and `MonetizationOperationSummary.status`
  gain the `revoked` member, which an exhaustive switch must handle;
  `RecoverableMonetizationClient` gains `restorePurchases()` and
  `commerceReconciler?`, which an implementation of that interface must add; a
  store whose `listRecoverable` keeps the old inline rule (`result ===
  undefined`) lists terminal commerce records as well, which the reconciler
  filters out, and a store without `listGranted` reports reversals only for
  grants seen in the session and relies on the backend's platform-evidence
  unique index for a purchase re-listed after a restart.
  
  Tests: every transition and the match order in
  `commerce-reconciler.test.ts`; the fourteen RFC vectors run through the real
  reconciler in `commerce-reconciler-conformance.test.ts` via the runner's new
  `createRuntime` hook; and the Play and StoreKit plugins carry smoke tests
  showing the deprecated v1 drivers and the reconciler reach the same outcomes
  over their fake SDKs. — Thanks @imjlk!
- [8c870580](https://github.com/imjlk/mpgd-kit/commit/8c87058002249260d63dbffe8a305417aa1db6ad) Commerce v2, PR C2: the server side of the protocol. Open store ids, the
  evidence registry, the provider capabilities endpoint, revocation entries,
  and the lookup verifiers for the server-push stores.
  
  - Open store ids (RFC "Open store ids"): `VerifyPurchaseRequest.store?:
    StoreId` names the store a purchase was made in; `target` stays the ledger
    (deployment) target. `GameServicesStoreTarget` is now `StoreId` and the
    request validator accepts any bounded kebab-case identifier for `target`
    and `store` (`assertCommerceStoreId`); the closed v1 list lives on as the
    deprecated `GameServicesLegacyStoreTarget` until C4. A request without
    `store` keeps its v1 meaning through `resolveLegacyCommerceStoreId`:
    `android` is `google-play`, `ios` is `app-store`, `ait` is `apps-in-toss`,
    `reddit` is `devvit`, and every other target is its own store id. Every
    grant payload now records `store` and `evidenceSchema`.
  - Evidence registry (`@mpgd/game-services/commerce-evidence-registry`):
    `createCommerceEvidenceRegistry(entries, { unregistered? })` routes verify
    requests by `evidence.schema` to the entry that claims it, answers
    `EVIDENCE_SCHEMA_UNSUPPORTED` for an unknown schema and
    `EVIDENCE_SCHEMA_STORE_MISMATCH` for a schema registered to another store
    before any verifier runs, fails construction when a `finish: 'server'` entry
    has no finalizer, when two entries claim one schema, when one store declares
    two finish owners, or when two entries of a store accept a missing envelope,
    and finalizes grants through the owning entry (the schema and store the
    grant recorded first, then the request schema, then the store's single
    finalizing entry; a grant recorded under another store than its schema
    stays `pending` with `PURCHASE_FINALIZER_STORE_MISMATCH`). Entries may
    declare `targets` (the ledger targets their requests name;
    `EVIDENCE_SCHEMA_TARGET_MISMATCH` otherwise; the reference entries pin
    theirs) and `acceptsUnclaimedSchemas` (one per store: a verifier binding
    that keeps its own schema list). The optional `unregistered` fallback keeps
    a deployment's aggregate v1 verifier for stores without an entry (never for
    a store that has one), publishes the stores it declares (`stores`, through
    the capabilities endpoint without schemas), and serves undeclared stores
    when `servesUndeclaredStores` is true (the default without `stores`).
    `registry.stores`, `registry.servesUndeclaredStores`,
    `registry.serves(request)`, and `registry.allowedTargets(store)` expose
    that; every entry of a store must declare the same purchase profile
    (construction fails otherwise; the capabilities row is that profile, never
    a merge); a fallback store declared with `finish: 'server'` needs
    `unregistered.finalizer`; an undeclared `store` label on a target whose v1
    store is served (`{ target: 'android', store: 'x' }`) cannot route around
    that entry (`EVIDENCE_SCHEMA_STORE_MISMATCH`, a 400 from the backend); and
    the backend answers a 400 for a store it does not serve, a served store
    with a target its entries do not declare (a custom entry's `targets` are
    honoured, so a custom ledger target works), or otherwise a target that is
    neither a ledger target nor a served store, as an unknown v1 target was a
    400. A key reused for the same player, product, and target under another
    `store` is `IDEMPOTENCY_KEY_CONFLICT`; a grant recorded before `store` was
    written meets any store. Reference
    entries:
    `createGooglePlayCommerceEvidenceEntry` (`google-play.product-purchase.v2`,
    `finish: 'server'`), `createAppStoreCommerceEvidenceEntry`
    (`app-store.signed-transaction.v1`, `finish: 'client'`, accepts a missing
    envelope for the Server API lookup), `createMicrosoftStoreCommerceEvidenceEntry`
    (`mpgd.microsoft-store.digital-goods.v1`, `finish: 'server'`),
    `createAppsInTossCommerceEvidenceEntry` (`apps-in-toss.iap.callback.v1`,
    `finish: 'host'`), `createDevvitPaymentOrderCommerceEvidenceEntry`
    (`devvit.payment-order.v1`, the fulfillment handler's own record, bound
    through a `DevvitPaymentOrderAuthority` port), and the server-push lookups
    `createDevvitOrderLookupCommerceEvidenceEntry` (`devvit.order.v1`) and
    `createVerse8Agent8EventLookupCommerceEvidenceEntry`
    (`verse8.agent8-event.v1`) over `createCommerceLedgerLookupVerifier`, which
    never grants from the client envelope: it answers the grant the host's
    fulfillment path wrote for the same store and transaction id when it belongs
    to the requesting player and product and is not reversed (`settled`),
    `pending` (`LEDGER_GRANT_PENDING`) before that write, and `rejected` for a
    transaction, product, or player mismatch. `createServerPushLedgerGrant`
    builds the grant those lookups read (`quantity` scales a currency or
    resource grant and is recorded in the payload); `createGameServicesBackend`
    takes `commerceEvidenceRegistry` and, without one, keeps the v1 single
    verifier and finalizer unchanged; passing `purchaseGrantFinalizer` next to a
    registry throws (pass it as `unregistered.finalizer`).
  - `EvidenceVerificationDecision` gains the `settled` member
    (`{ status: 'settled', ledgerEntryId, ledgerTarget? }`): the backend
    answers `verified` with that entry and `alreadyProcessed: true` after
    checking it belongs to the requesting player, product, and ledger target
    (`LEDGER_GRANT_IDENTITY_MISMATCH` otherwise) and writes nothing; a
    rewarded-ad verifier answering it is a verifier error. An exhaustive switch
    over the decision must handle it. A same-key retry of a grant a `revoke`
    entry reversed, a different-key replay of its evidence, and a `settled`
    answer naming such a grant, answer `rejected` with `LEDGER_GRANT_REVERSED`,
    as the lookup path does, and a grant written without a deployment target (a host
    fulfillment path) meets a request bound to one.
  - Provider capabilities endpoint (RFC "Provider capabilities endpoint"):
    `PurchaseVerificationApi.getCommerceCapabilities?()` answers
    `CommerceServiceCapabilities` derived from the registry (one row per store
    with its schemas, finish owner, and purchase kinds); the reference backend
    offers it only with a registry, through `POST
    /game-services/purchases/capabilities` and oRPC `commerce.getCapabilities`
    (`NOT_FOUND` otherwise). `compareCommerceServiceCapabilities` is the client
    comparison, and the reconciler applies it at start and on explicit passes:
    a store the backend does not accept, a finish owner that disagrees, or
    another protocol major sets the provider's availability to
    `configuration-required` (`CommerceReconciler.getCapabilities()`,
    `serviceAlignment`), reports a `capabilities` failure, and
    `requestPurchase` refuses with `CONFIGURATION_REQUIRED` before any store UI
    opens; a purchase before `start()` attempts the comparison first, the read
    is bounded by `serviceCapabilitiesTimeoutMs` (default ten seconds) and a
    timed-out read keeps the last comparison (`serviceCapabilitiesTimeoutMs`
    must be a positive finite duration), and a backend that answers 404 /
    `NOT_FOUND` is remembered as `unpublished` rather than read again; the
    ledger status read is likewise remembered as absent after a 404 /
    `NOT_FOUND`, so a client adapter against a pre-C2 backend stays quiet. The
    reconciler's verify requests now carry `store`, and its revocation pass
    reads ledger status in chunks of at most 100 ids scoped to its player.
  - Revocation and expiry entries (RFC "Revocation and expiry entries"):
    `GameServicesStore` gains the optional `recordEntitlementRevocation`,
    `findEntitlementRevocations`, and the batched `getEntitlementTransactions`
    (the in-memory store implements all three; a grant is reversed once, a
    replayed notification key answers the first entry, a key reused for another
    grant throws `RevocationKeyConflictError`, a reused authority identity
    throws `EvidenceAlreadyProcessedError`, and an unknown grant is refused, as
    the D1 store does),
    `EntitlementLedgerRevocation` / `EntitlementRevocationTransaction` with
    `reason: refund | chargeback | voided | admin`, and the subscription
    `EntitlementLedgerPeriod` shape (validator only; no writer yet).
    `@mpgd/game-services/commerce-ledger` adds `revokeEntitlementGrant` (the
    notification handlers' write path, answering `key_conflict` and
    `evidence_already_processed` next to `grant_not_found` and
    `grant_mismatch`), `readPurchaseLedgerStatuses` (one status per requested
    id in request order, batched reads in chunks of `ledgerReadChunkSize`
    through `chunkLedgerEntryIds`, which refuses a non-positive size, and
    scoped to the required `PurchaseLedgerStatusRequest.playerId`: another
    player's entry answers `unknown`), `listActiveEntitlementTransactions`
    (entitlement reads subtract reversed grants), and `isEntitlementGrantReversed`.
    `PurchaseVerificationApi.getPurchaseLedgerStatus` is served by the reference
    backend over `POST /game-services/purchases/ledger-status` and oRPC
    `commerce.getPurchaseLedgerStatus` (bounded by
    `maxPurchaseLedgerStatusEntries`), so the C1 reconciler's revocation pass is
    live. A refund that arrives before its fulfillment answers
    `grant_not_found` and leaves no tombstone: the handler must retry it, or
    the fulfillment path must check the refund feed before granting. `@mpgd/game-services/platform-order` adds
    `createPlatformOrderLedgerGrant`, `createPlatformOrderVerifyRequest`, and
    `revokePlatformOrder` (a `normalizeDevvitRefundOrder` result writes the
    `revoke` entry for the order's grant under `reddit:<orderId>:refund`).
  - `gameServicesBackendEndpoints` gains `getPurchaseLedgerStatus` and
    `getCommerceCapabilities`; the HTTP and oRPC backend adapters implement
    both reads.
  
  Tests: `commerce-registry-routing.test.ts`, `commerce-registry-server.test.ts`,
  and `commerce-ledger-revocation.test.ts`, plus the reconciler alignment case. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.4.8, catalog@0.9.3, platform@0.22.0

## 0.21.1 — 2026-10-12

### Patch changes

- Updated dependencies: analytics@0.4.7, catalog@0.9.2, platform@0.21.0

## 0.21.0 — 2026-10-12

### Minor changes

- [da858335](https://github.com/imjlk/mpgd-kit/commit/da858335c28cd04512df73cf6484bd1d0d35b0b0) Commerce v2, PR B3: `@mpgd/game-services/app-store-verifier` accepts App
  Store signed-transaction evidence.
  
  The verifier accepts request evidence with schema
  `app-store.signed-transaction.v1` (`appStoreSignedTransactionEvidenceSchema`,
  `createAppStoreSignedTransactionEvidence`; the envelope
  `@mpgd/capacitor-storekit`'s commerce v2 provider sends). The client's
  StoreKit-verified JWS is first verified offline through the configured
  `signedTransactionVerifier` (Apple's `SignedDataVerifier` behind
  `createAppleSignedTransactionVerifier`): a tampered JWS is rejected before
  any network call, a decoded transaction id that differs from the request's
  `platformTransactionId` with `APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH`, and a
  non-string, empty, or oversized `signedTransaction` with
  `APP_STORE_SIGNED_TRANSACTION_EVIDENCE_INVALID`. Because a JWS is a signed
  snapshot that can predate a refund, the grant decision is then taken on the
  transaction's current status, selected by the new `signedTransactionEvidence`
  option: `{ mode: 'server-api' }` (default) fetches the transaction by id
  through the App Store Server API and runs every check (bundle id, product id,
  environment, app account token, type, quantity, revocation, upgrade, expiry,
  clock) on that fresh payload; `{ mode: 'offline-only', maxSignedAgeMs }` is
  the documented opt-in for deployments without Server API access and decides
  on the client JWS alone within the `signedDate` freshness window
  (`APP_STORE_SIGNED_TRANSACTION_STALE` otherwise); `{ mode: 'ignore' }` fetches
  by id for every request. Requests without that evidence keep the Server API
  `Get Transaction Info` lookup unchanged, so current clients are unaffected.
  `app-store-verifier-conformance` adds
  `createAppStoreSignedTransactionEvidenceFixture` for provider adapters. — Thanks @imjlk!

### Patch changes

- [58b313ce](https://github.com/imjlk/mpgd-kit/commit/58b313ce587ac2129a6306a17a069aae1e6cedb4) Commerce v2, PR B4: the Microsoft Store commerce provider.
  
  `@mpgd/adapter-browser/microsoft-store` adds
  `createMicrosoftStoreCommerceProvider(input)`, a `CommerceProvider` with
  `store: 'microsoft-store'` over the same Digital Goods engine as the v1
  `createMicrosoftStoreCommerceAdapter`, which keeps its behaviour and input
  unchanged. The capability block follows the RFC profile: consumable only,
  products with localized prices, `availablePurchases`, `restore`, `events`,
  `finish: 'server'` (no `finishTransaction`; the backend consume finalizer
  finishes), `pending: false` (Microsoft has no store-side pending state; scoped
  recovery records are listed as `purchased`), and `authority: { evidence:
  'adapter-settled', accountBinding: 'required' }`. `fetchProducts` maps
  `getDetails()` to `StoreProduct`; `requestPurchase` runs the
  `claimRecoveryOwnership` → Payment Request → `verifyAndGrant` flow and answers
  `purchased` with `settlement: { ledgerEntryId }` on a grant, `launched` while
  the authority answer is open or the Store has not listed the purchase,
  `cancelled` for a dismissed sheet, and `failed` with the client outcome code as
  `storeCode` (`MICROSOFT_STORE_*`, `microsoftStoreCommerceErrorCodeMap`)
  otherwise; `getAvailablePurchases` lists `listPurchases()` items plus scoped
  recovery records with `settlement` on purchases granted this session for the
  same checkout key and player scope; `restorePurchases` replays recovery without
  the v1 entitlement read and emits `purchaseUpdated` and `purchaseError` events,
  buffered before the first subscriber; a buffered settlement is delivered only
  to the player scope that restored it. A throwing availability probe degrades
  `getCapabilities` to `temporarily-unavailable` and surfaces as a retryable
  `STORE_UNAVAILABLE` from the other operations. `StorePurchase.transactionId`
  and `token` are the Digital Goods `purchaseToken`, which the server boundary
  already matches. The provider never grants: `settlement` is the authority's
  ledger pointer.
  
  `withMicrosoftStoreCommerceProvider(gateway, provider, options)` installs the
  provider as `commerceV2`, serves v1 `commerce` through `toCommerceAdapter`,
  adds the `commerce` capability block with `nativeIap`/`subscriptionIap` derived
  from it, and replaces ads with the unavailable adapter like
  `withMicrosoftStoreCommerceAdapter`. A gateway that migrates to this wiring
  sees the wrapper's v1 surface instead of the v1 adapter's: `getEntitlements()`
  and `restore().restoredEntitlements` are empty (entitlements come from the
  ledger), `restore()` returns `settledPurchases` and rejects when Digital Goods
  fails instead of resolving empty, and a checkout whose Store identity is bound
  to another player is `failed` (`ACCOUNT_BINDING_REQUIRED`) instead of
  `pending`. `withMicrosoftStoreCommerceAdapter` and the v1 adapter are
  unchanged. The `adapter-settled` conformance vector passes directly and through
  the gateway.
  
  `@mpgd/game-services`: the client grants a completed purchase with
  `authoritativeGrant` without a second verification when the gateway's
  `commerceV2` provider declares `authority.evidence: 'adapter-settled'`
  (`findAdapterSettledGrant`; the declaration is read once per provider instance
  and cached, a failed read is retried on the next checkout), and the ledger
  entry is taken from `authoritativeGrant.ledgerEntryId`. Gateways without
  `commerceV2` keep the target-name rule;
  `isAuthoritativeMicrosoftStoreCompletion` is deprecated for removal in C4. — Thanks @imjlk!
- Updated dependencies: analytics@0.4.6, catalog@0.9.1, platform@0.20.0

## 0.20.0 — 2026-10-11

### Minor changes

- [b0b6e5a8](https://github.com/imjlk/mpgd-kit/commit/b0b6e5a8573cd251646600a646fa8ca2ec81292e) Commerce v2, PR A4: bridge methods and event envelope, `app-store-server`
  moved to `@mpgd/game-services`, one Google Play token key helper.
  
  `@mpgd/bridge` adds the six commerce v2 methods to `BridgeMethod`
  (`commerce.v2.getCapabilities`, `commerce.v2.fetchProducts`,
  `commerce.v2.requestPurchase`, `commerce.v2.getAvailablePurchases`,
  `commerce.v2.finishTransaction`, `commerce.v2.restorePurchases`), exported as
  `bridgeCommerceV2Methods` and kept equal to `commerceBridgeMethods` from
  `@mpgd/platform/commerce`, which is now a dependency. The event side exports
  `BridgeEvent` (the `{ protocol: 'mpgd.commerce.v2', sequence, event }`
  envelope), `assertBridgeEvent`, `BridgeEventListener`, `BridgeEventSource`
  (`subscribe(listener): () => void`), and `bridgeEventProtocol`. The
  `COMMERCE_V2_UNAVAILABLE` bridge error (`commerceV2UnavailableBridgeErrorCode`,
  `createCommerceV2UnavailableBridgeError`, `isBridgeCommerceV2Method`) is the
  non-retryable answer of a transport without a v2 provider; the Cloudflare
  Pages host stub returns it for every v2 method. The v1 `commerce.*` methods
  are unchanged.
  
  `@mpgd/game-services` adds the `./app-store-server` subpath with
  `createAppleSignedTransactionVerifier` and
  `CreateAppleSignedTransactionVerifierOptions`, moved from
  `@mpgd/adapter-capacitor`, together with the optional
  `@apple/app-store-server-library` (`^3.1.0`) peer dependency.
  `createGooglePlayTokenTransactionId` in `./google-play-purchase` is now a
  deprecated alias of `createGooglePlayTokenPurchaseKey` from
  `@mpgd/platform/commerce` (same key, same `TypeError` for an invalid token);
  import the platform helper instead. The alias is removed in the next major
  version.
  
  `@mpgd/adapter-capacitor` deprecates the `./app-store-server` subpath: it
  re-exports `createAppleSignedTransactionVerifier` and its options type from
  `@mpgd/game-services/app-store-server` for one release and no longer peers on
  `@apple/app-store-server-library`; install the Apple library next to
  `@mpgd/game-services`. `NativeBridge` gains an optional
  `subscribe(listener: (event: BridgeEvent) => void): () => void` so a B-phase
  store provider can deliver commerce v2 events; the gateway works without it.
  `createCapacitorProviderRegistry` rejects a provider that declares a commerce
  v2 method, since v2 providers are registered through their own surface.
  
  `@mpgd/capacitor-play-billing` computes the token transaction ID with
  `createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce` and keeps
  `createGooglePlayTokenTransactionId` as a deprecated alias of that helper.
  
  `@mpgd/adapter-devvit` and `@mpgd/adapter-ait` sandbox bridges answer
  `COMMERCE_V2_UNAVAILABLE` for commerce v2 methods instead of
  `UNSUPPORTED_METHOD`. `@mpgd/adapter-browser` only gains a test that the
  Microsoft Store native bridge ignores commerce v2 envelopes. — Thanks @imjlk!

### Patch changes

- [a4fa5b14](https://github.com/imjlk/mpgd-kit/commit/a4fa5b14440e94c775baaf574dece7abaa0092b7) `@mpgd/platform` adds the commerce v2 contract module as the new `./commerce`
  and `./commerce-vectors` subpaths: the client contract types (`StoreProduct`,
  `StorePurchase`, `RequestPurchaseInput`, `CommerceEvent`, `CommerceProvider`,
  `CommerceCapabilities`, `ActiveSubscription`, credit wallet types), the bridge
  v2 payload shapes and event envelope, `CommerceError` with normalized codes,
  the purchase lifecycle state machine, typia validators that reject unknown
  keys, `createDerivedPurchaseIdempotencyKey`, the bounded pre-listener event
  buffer, `assertRequestPurchaseSupported`, the v1 `toCommerceAdapter` wrapper
  (which never grants), and the conformance vector format. `PlatformCapabilities`
  gains an optional `commerce` block that the capability conformance runner
  checks for fresh objects, exact keys, and agreement with `nativeIap` and
  `subscriptionIap`. This is additive: no reference provider implements v2 yet,
  and the protocol version stays `2.0.0-draft.1`. The package now depends on
  `typia`.
  
  `@mpgd/catalog` opens `ProductGrant.currency` and `AdReward.currency` to any
  non-empty string validated against a new optional `ProductCatalog.currencies`
  list (non-empty, unique, trimmed); when absent the catalog accepts `coin` and
  `gem` as before. `assertProductCatalog` and `validate:catalog` reject a currency
  grant that names an undeclared currency, `validate:ads` cross-checks reward
  currencies against the catalog, and `resolveCatalogCurrencies` and
  `defaultCatalogCurrencies` are exported. The kit adds no wallet currency
  literal.
  
  `@mpgd/adapter-verse8` keeps its `coin` and `gem` balance map and now fails a
  currency grant for any other catalog currency with a clear error instead of
  writing an untracked balance.
  
  `@mpgd/game-services` accepts any currency the product catalog declares: the
  ledger grant validator no longer hard-codes `coin` and `gem` (it requires a
  trimmed non-empty code), and `createGameServicesBackend` rejects a catalog
  product grant or placement reward whose currency the catalog does not declare,
  so an undeclared currency fails at startup instead of at the first grant. — Thanks @imjlk!
- Updated dependencies: analytics@0.4.5, catalog@0.9.0, platform@0.19.0

## 0.19.1 — 2026-10-11

### Patch changes

- [4eb0f79b](https://github.com/imjlk/mpgd-kit/commit/4eb0f79b7216a86989ac5ebfc9ed90cf1a93811e) Fix the Google Play Publisher and ONE play purchase clients on Cloudflare
  Workers, which reject `redirect: 'error'`. Requests now use `redirect: 'manual'`,
  and any redirect response is still rejected instead of being treated as success. — Thanks @imjlk!
- Updated dependencies: analytics@0.4.4, catalog@0.8.1, platform@0.18.0

## 0.19.0 — 2026-10-09

### Added

- [8cd3e3f8](https://github.com/imjlk/mpgd-kit/commit/8cd3e3f81d49235bd537a02ac97ac157f6b40f5b) Add ONE play rewarded advertisements with authenticated server request issuance, raw-byte HMAC SSV verification, durable callback bindings and backend ledger recovery. Keep client callbacks as correlation evidence and quarantine uncertain native presentations. Allow explicit same-format physical placement sharing for selected catalog targets. — Thanks @imjlk!
- [a483af3f](https://github.com/imjlk/mpgd-kit/commit/a483af3fb7f789a9edc71cc513e7c122d0b1e4b6) Add ONE play managed purchases with authenticated checkout intents, independent API V7 verification, ledger-before-consume or acknowledge finalization, signed PNS recovery and authoritative cancellation hooks. Map partial product detail batches and expose trusted native checkout presentation facts through the shared commerce contract and runtime. Keep subscriptions unsupported and server integrations required. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.4.3, catalog@0.8.0, platform@0.17.0

## 0.18.1 — 2026-10-09

### Patch changes

- Updated dependencies: analytics@0.4.2, catalog@0.7.8, platform@0.16.0

## 0.18.0 — 2026-10-09

### Added

- [0b14ed3a](https://github.com/imjlk/mpgd-kit/commit/0b14ed3a9576c4ac848ec4cd072ec541196fda38) Add an optional Microsoft Store consumption receipt persistence hook before recovery ownership release. Validate provider order attribution and keep finalization pending when persistence fails. Expose missing retry order IDs explicitly so integrations can require an exact durable receipt instead of inventing refund attribution. — Thanks @imjlk!
- [a0736142](https://github.com/imjlk/mpgd-kit/commit/a0736142e7bab338ab5580f1e319c5f6f43092f4) Add explicitly registered client reward evidence normalization and use it consistently for claims and journal recovery. Keep server verification independent, preserve legacy callback consumers, and support registered providers without editing common reward handling. — Thanks @imjlk!
- [b8447285](https://github.com/imjlk/mpgd-kit/commit/b844728577c623f835f6e8d8fbb14a4f1fe284c7) Add deployment-owned advertising evidence verifier registrations keyed by schema, provider, target, and deployment. Permit all existing build targets to route rewarded claims through independently configured server proof verification, while preserving authoritative impression replay identities. — Thanks @imjlk!

### Patch changes

- [ce43de12](https://github.com/imjlk/mpgd-kit/commit/ce43de128c8a0f665aea520bd51884d63f4d8a85) Allow Microsoft Store consumption receipt persistence when the response omits the product ID echo. Use verified request attribution and keep rejecting conflicting product IDs, mismatched item or tracking IDs, and invalid order data before releasing recovery ownership. — Thanks @imjlk!
- Updated dependencies: analytics@0.4.1, catalog@0.7.7, platform@0.15.0

### Fixed

- [0b0ec05c](https://github.com/imjlk/mpgd-kit/commit/0b0ec05c4347246be3aa9fb0b07553af3679723c) Bound newly generated Microsoft Store recovery keys to the purchase request limit. Long provider identities use a stable digest while verification and consumption retain the original provider identity. Reject oversized caller-supplied generations before recording recovery ownership. — Thanks @imjlk!
- [0e5008a0](https://github.com/imjlk/mpgd-kit/commit/0e5008a08fe89638e832182af701310bf4af3406) Attach late registered advertising correlation to a reserved pending journal operation and retry the original claim without reopening native UI. Preserve recorded evidence, request identity, and timestamps, and provide an application-owned observer that uses the original idempotency key without asserting SDK eligibility or a ledger grant. — Thanks @imjlk!

## 0.17.2 — 2026-10-04

### Patch changes

- [e968e105](https://github.com/imjlk/mpgd-kit/commit/e968e1057d6d39a5ae956c2bc88ba41c7c3597cd) `createAppsInTossProductionEvidenceVerifier` now rejects purchases whose catalog product has `type: 'subscription'` with the stable reason `APPS_IN_TOSS_SUBSCRIPTION_UNSUPPORTED`, before the order-status authority is called. This mirrors the Google Play and App Store verifiers so the Apps in Toss path no longer relies on the adapter hiding `SUBSCRIPTION` products or on target config leaving subscriptions disabled. The conformance suite gains a `purchase-subscription-unsupported` scenario. — Thanks @imjlk!

## 0.17.1 — 2026-10-04

### Patch changes

- [f4c4e9ad](https://github.com/imjlk/mpgd-kit/commit/f4c4e9ad3325a4497f5f555f1de5f01299d3be87) Harden the game-services request boundary. The HTTP and oRPC fetch handlers now cap request bodies (64 KiB by default, configurable through `maxBodyBytes`) and answer oversized payloads with 413 `PAYLOAD_TOO_LARGE`; client identifiers and timestamps are limited to 256 characters and evidence payloads to 64 entries before they reach ledger keys. Error responses use stable codes instead of echoing internal messages: validation failures return 400 `INVALID_REQUEST` with the field-level message (oRPC: `BAD_REQUEST`), malformed JSON returns 400 `INVALID_JSON`, and store or other unexpected failures return 500 `INTERNAL_ERROR` and are reported through the new `onInternalError` hook. Ad reward claims only persist the client-reported `platformImpressionId` as the globally unique platform evidence identity when the verifier vouches for it, mirroring purchases: a verifier-supplied `platformEvidenceId` replaces it and `null` suppresses it, so an attacker can no longer pre-register another player's impression id to deny their legitimate claim. The AdMob SSV verifier now supplies the signed transaction id as `platformEvidenceId`. — Thanks @imjlk!
- [c3e9f87c](https://github.com/imjlk/mpgd-kit/commit/c3e9f87cd7dc4f7c4ebcfbe6a1458b4977d363d1) Stop client adapters from returning grant-shaped rewarded-ad results.
  
  - `@mpgd/adapter-verse8`: a Verse8 `rewarded` SDK callback now resolves to
    `status: 'completed', rewardGranted: false` with the `verse8.ads.reward.v1`
    evidence envelope and no `ledgerEntryId`. The Verse8 `requestId` is an
    impression id, not a ledger entry; only the backend verifier may grant.
  - `@mpgd/adapter-browser`: `createBrowserPlatformGateway()` never returns a
    grant on any code path. By default commerce and ads report unavailable and
    `purchase()` fails closed. The new `mockCommerce: true` option adds a
    local-demo sample catalog with evidence-only results: `purchase()` resolves
    `status: 'completed'` with a mock `transactionId`, empty `entitlementIds`,
    no `authoritativeGrant`, and `mpgd.browser.mock-purchase.v1` evidence;
    `showRewarded()` resolves `status: 'completed', rewardGranted: false` with
    no `ledgerEntryId` and `mpgd.browser.mock-reward.v1` evidence. Neither
    schema is accepted by backend claim APIs. The schema strings are exported as
    `browserMockPurchaseEvidenceSchema` and `browserMockRewardEvidenceSchema`.
    `withMicrosoftStoreCommerceAdapter` now replaces the base `ads` surface with
    an unavailable adapter and reports ad capabilities as false.
    `createUnavailableAdAdapter` is exported for custom gateways.
  - `@mpgd/game-services`: `createGameServicesClient` forwards allow-listed
    client reward evidence (AdMob and Verse8) to `claimAdReward`, deriving
    `platformImpressionId` from the Verse8 evidence `requestId`. New exports:
    `isClientRewardEvidence`, `isVerse8ClientRewardEvidence`,
    `resolveRewardPlatformImpressionId`, `clientRewardEvidenceSchemas`,
    `verse8ClientRewardEvidenceSchema`. Recoverable monetization clients bind
    journaled Verse8 claims to the evidence-derived impression id. — Thanks @imjlk!

## 0.17.0 — 2026-09-28

### Minor changes

- [3f36bc6b](https://github.com/imjlk/mpgd-kit/commit/3f36bc6b5269908681405de6567d63fadadd9653) Add an opt-in AdMob rewarded-ad provider with explicit UMP consent and per-operation server-side verification binding. Route provisional SDK reward evidence to the authoritative game-services claim without setting the platform grant flag. — Thanks @imjlk!
- [c2a14a1c](https://github.com/imjlk/mpgd-kit/commit/c2a14a1ccfde885fc0fb34b8e52e2a8070f63a3d) Add an OAuth-backed Google Play Publisher transport for ProductPurchaseV2 verification and post-ledger acknowledge or consume operations. Keep purchase tokens and response bodies out of transport error messages. — Thanks @imjlk!
- [9c3b6cc0](https://github.com/imjlk/mpgd-kit/commit/9c3b6cc0656ac7b2722cc658b585e6775e9b20b6) Add an opt-in durable monetization operation journal and explicit pending purchase and rewarded-ad outcomes, so games can reconcile server grants and provider finalization without replaying purchase or ad UI. — Thanks @imjlk!
- [81420942](https://github.com/imjlk/mpgd-kit/commit/814209428240ee0206e62325992a52dd00211996) Add a server-side StoreKit recovery adapter that reuses the original durable checkout key or a matching App Store ledger grant, and leaves unrecognized transactions pending without minting a new idempotency key. — Thanks @imjlk!
- [46172f4b](https://github.com/imjlk/mpgd-kit/commit/46172f4b43c4426e5fdc53c64820e1d92671fc48) Accept a server-recomputed SHA-256 token transaction identifier for Google Play one-time purchases when the client has not yet observed an order ID. Keep token matching authoritative and preserve the existing mismatch rejection for unrelated order IDs. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.4.0, catalog@0.7.6, platform@0.14.0

## 0.16.0 — 2026-09-25

### Minor changes

- [f5974b1d](https://github.com/imjlk/mpgd-kit/commit/f5974b1d87b4eb9d085211ffeaf43fb740b5baf5) Allow an HTTP JSON backend transport to be injected through
  `createGameServicesRuntime` while preserving authoritative backend validation,
  backend status handling, and per-request credential resolution. Keep oRPC on
  its distinct Fetch-based path. — Thanks @imjlk!
- [ffc27594](https://github.com/imjlk/mpgd-kit/commit/ffc27594d7284be851003f34898e73b6be75d8af) Add a guest session coordinator that stores refresh tokens only through a
  dedicated secure credential port, serializes refresh and logout, rejects
  principal changes, and delegates server issuance, revocation, and verified
  account binding to an injected authoritative backend. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.15, catalog@0.7.5, platform@0.13.0

## 0.15.3 — 2026-09-24

### Patch changes

- Updated dependencies: analytics@0.3.14, catalog@0.7.4, platform@0.12.2

## 0.15.2 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.13, catalog@0.7.3, platform@0.12.1

## 0.15.1 — 2026-09-13

### Patch changes

- [bd4de7b](https://github.com/imjlk/mpgd-kit/commit/bd4de7b086d19b6d9ede5ace460baf97c07f2f01) Keep the operation client declarations independent of catalog schema and DOM
  types. Headless TypeScript consumers can check `@mpgd/game-services/operations`
  with `lib: ["ES2022"]`, no ambient Node types, and `skipLibCheck: false`. — Thanks @imjlk!

## 0.15.0 — 2026-09-13

### Added

- [bf2b493](https://github.com/imjlk/mpgd-kit/commit/bf2b4933567bf6d63f809c9f601db5a9e27d363a) Expose optional, invocation-scoped purchase and rewarded-ad progress observers through the client entrypoint. Report actual platform and backend request/result stages without exposing evidence or changing grants, pending results, authoritative completion, or observer-free calls. Isolate observer exceptions and promise rejections from business results.
  
  Repair extensionless internal imports and re-exports so every existing game-services public entrypoint loads directly in Node ESM, and validate those compiled entrypoints during tests.
  
  Expose a DOM-free operations type entrypoint for headless service consumers.
  
  Restore the durable grant idempotency key when finalizing evidence-based purchase recovery, so Microsoft Store offer-token migration can finish consumption without creating a second grant. — Thanks @imjlk!

## 0.14.0 — 2026-09-02

### Minor changes

- [916f648](https://github.com/imjlk/mpgd-kit/commit/916f648d113c975f8a2bf7074deb38d9506ce014) Add experimental WeChat and TikTok native mini-game target contracts, shared runtime classification, and notification target validation. — Thanks @imjlk!
- [0e04a4a](https://github.com/imjlk/mpgd-kit/commit/0e04a4a8ee8294bdf4a716fec34831e3af71106e) Add a strict, game-scoped Microsoft Store identity authority protocol for sharing one private
  provider service across multiple game-service Workers without exposing Store credentials to clients. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.12, catalog@0.7.2, platform@0.12.0

## 0.13.1 — 2026-08-29

### Patch changes

- [d8f8578](https://github.com/imjlk/mpgd-kit/commit/d8f8578c9d32c5fdea63d16e7c738387fbf7b7ee) Use the documented Apps in Toss game identity API for AIT game wrappers and accept both the current OpenAPI boolean and legacy string anonymous-key verification response shapes. — Thanks @imjlk!
- Updated dependencies: analytics@0.3.11, catalog@0.7.1, platform@0.11.0

## 0.13.0 — 2026-08-27

### Minor changes

- [1834243](https://github.com/imjlk/mpgd-kit/commit/1834243e55affa81cba197620c544258025978ca) Allow Apps in Toss IAP order verification by order ID without forcing a Toss Login user key. Callers may still supply `tossUserKey` to narrow the authoritative lookup to a linked account. — Thanks @imjlk!

## 0.12.1 — 2026-08-26

### Patch changes

- Updated dependencies: analytics@0.3.10, catalog@0.7.0, platform@0.10.0

## 0.12.0 — 2026-08-12

### Added

- [949dc45](https://github.com/imjlk/mpgd-kit/commit/949dc45be7ec60d4961bf26cc8cc0d0bf400c9ee) Add opt-in Apps in Toss IAP authority hooks, partner API contracts, and stable SDK 3 target support. — Thanks @imjlk!
- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.9, catalog@0.6.0, platform@0.9.0

## 0.11.1 — 2026-08-04

### Changed

- [6ae2720](https://github.com/imjlk/mpgd-kit/commit/6ae27206b4aaae601c7feaa4ca7946b7cad5c654) Allow safe game-owned `kind: "web"` target names in build, smoke, and matrix CLI workflows while preserving the existing browser and web aliases. Support additive game-owned target-config policies at build time and runtime, monetization identifiers, authoritative purchase and reward verification for custom deployments, verified non-installable browser artifacts, and bounded static web artifact overlays for custom browser deployments while reserving platform-specific PWA policy for its canonical target. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.5.2

## 0.11.0 — 2026-07-23

### Added

- [8f71019](https://github.com/imjlk/mpgd-kit/commit/8f710196ec0602181ea83599b390d47cb78a1cf6) Add an Apps in Toss partner API client for mTLS user-key verification and functional-message delivery. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.8, catalog@0.5.1, platform@0.8.0

## 0.10.0 — 2026-07-17

### Added

- [e20c08a](https://github.com/imjlk/mpgd-kit/commit/e20c08a59e15adb664022a120babb07bb1f18dca) Add a Google Play one-time-product server verification boundary with token-safe evidence identities and fixtures, independent account/profile binding resolvers, fail-closed rental handling, race-safe idempotency rechecks and post-ledger acknowledge or consume finalization, authoritative identity suppression, independently bounded and observable finalizer retries, abort-safe lease recovery, stored-context recovery, retry metadata, and deterministic fail-closed conformance fixtures. — Thanks @imjlk!
- [807eb4b](https://github.com/imjlk/mpgd-kit/commit/807eb4b322f06c879a79f97187b74b9b74fc1a81) Add a fail-closed Apps in Toss purchase and rewarded-ad evidence verifier boundary, a deadline-bounded SDK-compatible in-callback product-grant API with a nominal abort-aware transport port and failure diagnostics, versioned callback envelopes, grant-time purchase source enforcement, deterministic order timestamp parsing, explicit-zone reward timestamps, three-way request/evidence/authority reward correlation, authority fixtures, and conformance coverage for server matching, pending-order recovery, idempotent retries, replays, and authority failures. — Thanks @imjlk!
- [876992e](https://github.com/imjlk/mpgd-kit/commit/876992e6f76fcf88156f0097200f5819e42f1b1a) Add a fail-closed App Store Server API one-time-purchase verifier, explicit dependency-outage errors with cancellation propagation and bounded response-stream handling, retryable lookup/response handling, original-transaction replay identity for non-consumables, deterministic conformance fixtures, and a CI smoke boundary that accepts only cryptographically verified, single-grant transactions matching the configured app, product, UUID account binding, environment, provider purchase timestamp, and active transaction state. — Thanks @imjlk!
- [4d3634a](https://github.com/imjlk/mpgd-kit/commit/4d3634adfd1e65aa32c6ab6e1ea19e4c19b9192b) Add a Web Crypto AdMob server-side reward verifier with signed claim binding, bounded callback freshness, deterministic transaction replay protection through the entitlement ledger, and a portable conformance fixture. — Thanks @imjlk!

## 0.9.0 — 2026-07-17

### Added

- [4307985](https://github.com/imjlk/mpgd-kit/commit/4307985f02743278703cb87abb835ed14a92d5d9) Add validated generic consumable resource product grants, preserve them through current and legacy authoritative ledger transactions, and keep unsupported resource products out of Verse8 shops and effective target configurations. — Thanks @imjlk!
- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [6acccf2](https://github.com/imjlk/mpgd-kit/commit/6acccf217463fc3280f19273188f660285707d5e) Add a provider-neutral verified leaderboard durability conformance suite with ambiguous-commit fixtures and apply it to D1, Redis, and Agent8 recovery paths. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.7, catalog@0.5.0, platform@0.7.0

## 0.8.2 — 2026-07-15

### Fixed

- [d5a434a](https://github.com/imjlk/mpgd-kit/commit/d5a434a05d1b23e9fb8046a995a691cb8bfe7c18) Reject verified leaderboard snapshots with inconsistent page ordering, ranks, totals, or continuation cursors before they cross provider and transport boundaries. — Thanks @imjlk!

## 0.8.1 — 2026-07-15

### Fixed

- [a18483a](https://github.com/imjlk/mpgd-kit/commit/a18483a286bfae17641951e0322fedd7ca45a7df) Reject calendar-impossible UTC timestamps in server-driven platform fulfillment
  and refund orders instead of accepting `Date.parse` overflow normalization. — Thanks @imjlk!

## 0.8.0 — 2026-07-15

### Added

- [947a834](https://github.com/imjlk/mpgd-kit/commit/947a8347ec6e55c07b086ff06954deab7ad331c3) Add a server-driven platform order contract for Reddit fulfillment and refunds,
  including strict runtime assertions and deterministic order idempotency keys. — Thanks @imjlk!
- [ec79bf0](https://github.com/imjlk/mpgd-kit/commit/ec79bf095f2a35b78d18b0b8a91ebdb5124c9df2) Added a provider-neutral purchase and rewarded-ad evidence verifier boundary,
  versioned adapter evidence envelopes, explicit development verifier helpers,
  bounded verifier execution, authority-level replay protection, and fail-closed
  entitlement grants when production verification is unavailable. Idempotency
  retries now reject changes to the original logical grant or platform target,
  including raced writes, while concurrent identical retries return the original
  successful ledger result. Existing stores can use list fallbacks when optional
  indexed idempotency, authority-evidence, or historical platform-evidence
  lookups are not implemented; both evidence identities are serialized per store
  instance before the fallback write. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.6, catalog@0.4.0, platform@0.6.0

## 0.7.0 — 2026-07-14

### Added

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Add bounded immutable numeric metrics to verified attempts and ranked entries,
  preserving them across memory, Devvit Redis, Cloudflare D1, and authenticated
  snapshot transports without changing score-based ranking behavior. — Thanks @imjlk!

## 0.6.0 — 2026-07-14

### Added

- [f81d3fa](https://github.com/imjlk/mpgd-kit/commit/f81d3fa30da83537d838442ef934642b433e347b) Add authenticated read-only verified leaderboard fetch helpers and opaque
  keyset cursor pagination shared by memory and D1 providers, with bounded,
  well-formed board and attempt identifiers that keep every generated continuation
  cursor transport-safe. — Thanks @imjlk!
- [8599f11](https://github.com/imjlk/mpgd-kit/commit/8599f11b891535635e4aab1cb37d180f1ab861c2) Add a reusable, test-framework-independent conformance suite for verified
  leaderboard providers, including concurrent idempotency and mutation isolation. — Thanks @imjlk!
- [4eb7cee](https://github.com/imjlk/mpgd-kit/commit/4eb7cee9b2088e3734af673af6db33e8c8a7c51b) Add a provider-neutral verified leaderboard boundary with separate public-read
  and trusted server-write ports, first/best attempt selection, deterministic
  snapshots, and an in-memory reference implementation. — Thanks @imjlk!

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.5, catalog@0.3.5, platform@0.5.1

## 0.5.0 — 2026-07-13

### Added

- [fd25ffe](https://github.com/imjlk/mpgd-kit/commit/fd25ffec5041036288c5aa4b10bd8ab5114b0499) Add a shared Game Services runtime factory that disables production clients without an authoritative backend URL and permits process-local backends only through explicit non-production opt-in. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.4, catalog@0.3.4, platform@0.5.0

## 0.4.0 — 2026-07-11

### Added

- [3742ee6](https://github.com/imjlk/mpgd-kit/commit/3742ee60abce4339823af78013c13d958b3ef64a) Add bounded, verified guest-progress reconciliation and durable, idempotent notification delivery provider and ledger contracts. — Thanks @imjlk!

### Changed

- [84b3f83](https://github.com/imjlk/mpgd-kit/commit/84b3f836041c5c3513f3b2bf8b2c5414adfded0a) Allow games to define their own logical product and ad placement identifiers while preserving the starter identifiers as suggested literals. — Thanks @imjlk!

### Patch changes

- Updated dependencies: analytics@0.3.3, catalog@0.3.3, platform@0.4.0

## 0.3.3 — 2026-07-08

### Changed

- [09fc2d9](https://github.com/imjlk/mpgd-kit/commit/09fc2d9e44041325de0a91a07fb355ac3014f290) Document and regression-test the game-services ledger idempotency contract for
  source-scoped entitlement grants and leaderboard run records. — Thanks @imjlk!

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: analytics@0.3.2, catalog@0.3.2, platform@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: analytics@0.3.1, catalog@0.3.1, platform@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: analytics@0.3.0, catalog@0.3.0, platform@0.3.0

## 0.2.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: analytics@0.2.0, catalog@0.2.0, platform@0.2.0

## 0.1.0 — 2026-07-04

### Added

- [500e57d](https://github.com/imjlk/mpgd-kit/commit/500e57da6e25d7cbc9aeff2a6222d267f077cd87) Add a ledger-first Game Services vertical slice for reusable purchase, rewarded ad, and leaderboard flows. Platform callbacks are now treated as evidence, while grants and score records are accepted only after backend verifier or ledger APIs respond. — Thanks @imjlk!
- [500e57d](https://github.com/imjlk/mpgd-kit/commit/500e57da6e25d7cbc9aeff2a6222d267f077cd87) Add a game services backend contract using oRPC v2 beta, async store-backed authoritative grants and leaderboard records, and a Cloudflare Vite plugin Worker starter with HTTP, oRPC, and WorkerEntrypoint service binding surfaces. — Thanks @imjlk!
- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!
- [500e57d](https://github.com/imjlk/mpgd-kit/commit/500e57da6e25d7cbc9aeff2a6222d267f077cd87) Add a typed Game Services backend API boundary with endpoint transport helpers, a fetch transport, and an in-process backend handler for local demos and smoke tests. — Thanks imjlk!

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Patch changes

- Updated dependencies: analytics@0.1.0, catalog@0.1.0, platform@0.1.0

