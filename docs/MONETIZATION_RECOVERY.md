# Recovering purchases and rewarded ads

`@mpgd/game-services` can journal a purchase or rewarded-ad operation before it opens the platform UI. Supply a durable `MonetizationOperationStore` to `createGameServicesRuntime({ operationStore })`, or use `createRecoverableMonetizationClient` directly. The runtime routes its purchase and rewarded-ad methods through the journal and exposes `monetizationRecovery.reconcile()` for app startup and resume.

The game owns the journal implementation. Its `reserve` must atomically insert or return a globally unique operation key; `replace` must compare revisions atomically; and `listRecoverable` must return only the requested player's unresolved operations. Keep terminal records addressable by `read` for duplicate-key protection, but index or archive them out of `listRecoverable` so startup reconciliation does not scan a player's entire history. Persist records across restarts in encrypted, access-controlled storage. They may contain purchase receipts, transaction IDs, and ad proof. An in-memory map is suitable only for tests, not production recovery.

Use one idempotency key for one player, target, and logical product or placement. Do not derive a fresh key when retrying a server call. The coordinator saves a platform result before it requests the authoritative backend grant, and saves the backend request before sending it. If a response is lost, `reconcile()` repeats that same request; the backend ledger remains responsible for deduplication. A verified purchase may still have `finalization.status: 'pending'` while consume, acknowledge, or finish needs another attempt. This is not another grant.

If the process stops before a platform result is saved, the journal stays pending and **does not reopen the purchase or ad UI**. A failed journal write keeps the returned platform evidence in this runtime for a same-process retry and exposes it with the pending result; it cannot make that evidence durable across a process crash. A Microsoft Store completion whose adapter already finished the authoritative grant is reported as granted, just as it is without a journal. The installed native provider must enumerate unfinished transactions or deliver the original callback after restart and call `recoverPurchaseResult(idempotencyKey, result)` or `recoverRewardResult(idempotencyKey, result)`. A recorded platform `pending` result can advance to a later terminal callback; a conflicting already-terminal result is rejected. The Capacitor adapter also accepts a pending rewarded-ad provider result without treating it as a grant. Delayed SSV may likewise leave a rewarded-ad claim pending until the backend sees its callback. A provider without replay/recovery cannot promise automatic settlement for that window; keep the operation visible for operator/support reconciliation.

`pending` means no client-side grant is allowed. `rejected` means the backend returned a definitive non-grant decision. The backend makes that decision one request at a time per operation key within one backend process, including the awaited analytics call, so a concurrent same-key grant there wins. Across backend processes, a rejection can still race another process's grant; route a player's monetization requests to one process where that matters. Handled verifier, backend, and per-record journal read/write failures remain retryable or pending; malformed verifier decisions are rejected rather than retried forever. Initial `store.reserve()` failures in `purchase()` or `claimRewardedAd()`, and `store.listRecoverable()` failures in `reconcile()`, reject the call instead: callers must catch these outages and retry rather than interpreting them as a pending result. An already-recorded purchase or ad grant remains granted when a later retry is unavailable or the result journal write collides. When this runtime persists a backend grant that an earlier journal write lost, it also discards any non-grant result another runtime recorded meanwhile, so the operation is re-settled as granted instead of staying rejected. Calls for the same operation key are serialized within one runtime, and `reconcile()` skips an operation already running there. Progress observers see the whole journaled call. When a journal failure is resolved into a pending or already-known granted result, the call still ends with `completed` for the status it returns; `exception` means the call itself rejected. Cross-process deduplication still depends on the atomic store and authoritative backend ledger. `reconcile()` reports a malformed same-player journal entry as `action-required` without blocking other entries; records for another target are not processed. Purchase settlement helpers such as `findAuthoritativePurchaseSettlement` remain UI evidence only and must not credit a wallet. Account switching cannot adopt a journaled operation: its key remains bound to the original player.

## Commerce v2 reconciler

A gateway that exposes a commerce v2 provider (`gateway.commerceV2`; the
Capacitor store providers, Microsoft Store, Apps in Toss, Devvit, Verse8, and
a project's credit wallet) no longer needs a per-store recovery driver.
`createGameServicesClient` purchases through `createCommerceReconciler`
(`@mpgd/game-services/commerce-reconciler`), one reconciler per provider that
journals every purchase the game starts or the store reports as a
`commerce-purchase` record in the same `MonetizationOperationStore`, moving
through the RFC lifecycle (`requested`, `launched`, `pending`, `purchased`,
`verifying`, `granted`, `finishing`, `finished`, plus `cancelled`, `failed`,
`rejected`, and `revoked`), one compare-and-replace revision per transition.
The client exposes it as `commerceReconciler`; the recovery client and
`createGameServicesRuntime` share one over the durable journal.

Call `monetizationRecovery.reconcile()` at startup and on app resume as
before: with a v2 provider it starts the reconciler (subscribe, read
`getAvailablePurchases` when declared, reconcile until idle) and runs a pass
on every later call, while v1 records keep their existing resume path. Every
`purchaseUpdated` or `purchaseError` event and the end of every `purchase()`
call run a pass too, and `restorePurchases()` is the manual restore trigger
(`provider.restorePurchases` when offered, then a pass). A `purchase()` call
answers `pending` when the store answers later; the grant then arrives as a
journal transition (`onCommerceEvent` / `commerceReconciler.subscribe`) and
is reported through the usual `purchase_granted` analytics event once.

One pass matches each reported purchase by store and transaction id, then to
the single open (`launched` or `pending`) record for the player, store, and
product, otherwise under a derived key (`store:<store>:<transactionId>`, with
`play-token-sha256:<hex>` for Google Play and `apps-in-toss:purchase:<orderId>`
kept so ledgers written by the v1 drivers still deduplicate); builds and saves
the verify request once and resends it unchanged while `purchased`,
`verifying`, or server-side `pending`; finishes `granted` records according
to the provider's `lifecycle.finish` (`client` and `host` call
`finishTransaction` with the ledger entry id, `server` resends the saved
request until the backend reports `finalization: 'completed'`, `none` marks
`finished`); and moves reversed grants to `revoked` once the backend offers
`PurchaseVerificationApi.getPurchaseLedgerStatus` (C2). A second `purchase()`
for a product whose attempt is still `launched` or `pending` fails with
`IN_PROGRESS`; a replayed key answers from the journal and never reopens the
store UI; `OUTCOME_UNKNOWN` and `ALREADY_OWNED` keep an attempt open until the
available purchases decide. Transport failures on verify or finish keep the
state, are reported as `failure` events, and are retried on the next pass.
Nothing is granted from a provider result: an adapter-settled purchase and a
wallet spend (`credit-wallet.spend.v1`, no `settlement`) are verified like any
other, and `finishTransaction` is only ever called for a `granted` or
`finishing` record that holds the backend's ledger entry id
(`assertCommerceFinishAllowed`).

The durable store rules above apply to the new record kind: `listRecoverable`
returns a `commerce-purchase` record while its `state` is not terminal
(`isMonetizationOperationRecoverable` from
`@mpgd/game-services/monetization-operation-store` applies the rule for every
kind), terminal records stay addressable by `read`, and the optional
`listGranted(playerId)` returns `granted`, `finishing`, and `finished`
records within the retention window for the revocation pass. A
`createGameServicesClient` without an `operationStore` keeps the v2 journal in
memory for the session only; duplicates are then caught by the backend
ledger, not by the client. The deprecated v1 drivers
(`recoverOwnedPlayPurchases`, `recoverStoreKitPurchases`, the Microsoft Store
recovery records, and the Apps in Toss pending-order pass) keep working for
v1 gateways and are removed in C4; `recoverPurchaseResult` on a v2 gateway
reconciles and answers from the journal instead of replaying the callback.

This contract and its mock tests do not prove that a native Billing, StoreKit, or AdMob provider can recover its callbacks on a device. Provider-specific replay, secure storage, SSV delivery, and real account/device evidence are separate release gates.

## Phaser starter assembly

The private starter and newly generated games construct one game-owned runtime
above their scenes. Supply `bootstrapStarter({ monetization: { operationStore,
reconciliation, purchasePresentation } })` in the private example, or provide
those bootstrap options in a generated game's entrypoint. The operation store
is application-owned and must satisfy the durability, encryption and CAS
requirements above. No in-memory production fallback is installed. Without a
recovery journal, versioned rewarded display remains policy-disabled before
the SDK call. Backend URL/auth and independent server authorities are still
required; a journal is not grant authority.

The scene receives the coordinated gateway, services and action coordinator.
It disposes its action view on shutdown, while the game retains late evidence
observation and the original recovery client. Startup/resume recovery never
opens advertising or purchase UI. Native presentation facts release execution;
SDK eligibility and backend ledger results do not release a live native owner.
