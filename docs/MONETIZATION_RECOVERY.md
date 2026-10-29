# Recovering purchases and rewarded ads

`@mpgd/game-services` journals every purchase and rewarded-ad operation before it opens the platform UI. Purchases go through the commerce reconciler (below), the only purchase path since commerce v2 PR C4; rewarded ads keep their per-operation journal record. Supply a durable `MonetizationOperationStore` to `createGameServicesRuntime({ operationStore })`, or use `createRecoverableMonetizationClient` directly. The runtime routes its purchase and rewarded-ad methods through the journal and exposes `monetizationRecovery.reconcile()` for app startup and resume.

The game owns the journal implementation. Its `reserve` must atomically insert or return a globally unique operation key; `replace` must compare revisions atomically; and `listRecoverable` must return only the requested player's unresolved operations. Keep terminal records addressable by `read` for duplicate-key protection, but index or archive them out of `listRecoverable` so startup reconciliation does not scan a player's entire history. Persist records across restarts in encrypted, access-controlled storage. They may contain purchase receipts, transaction IDs, and ad proof. An in-memory map is suitable only for tests, not production recovery.

Use one idempotency key for one player, target, and logical product or placement. Do not derive a fresh key when retrying a server call. The coordinator saves a platform result before it requests the authoritative backend grant, and saves the backend request before sending it. If a response is lost, `reconcile()` repeats that same request; the backend ledger remains responsible for deduplication. A verified purchase may still have `finalization.status: 'pending'` while consume, acknowledge, or finish needs another attempt. This is not another grant.

If the process stops before a platform result is saved, the journal stays pending and **does not reopen the purchase or ad UI**. A failed journal write keeps the returned platform evidence in this runtime for a same-process retry and exposes it with the pending result; it cannot make that evidence durable across a process crash. For a rewarded ad, the installed native provider must deliver the original callback after restart and call `recoverRewardResult(idempotencyKey, result)`. A recorded platform `pending` result can advance to a later terminal callback; a conflicting already-terminal result is rejected. The Capacitor adapter also accepts a pending rewarded-ad provider result without treating it as a grant. Delayed SSV may likewise leave a rewarded-ad claim pending until the backend sees its callback. A provider without replay/recovery cannot promise automatic settlement for that window; keep the operation visible for operator/support reconciliation. A purchase has no callback to replay: the commerce provider lists the store's unfinished purchases (`getAvailablePurchases`) and emits `purchaseUpdated`, and the reconciler decides from those (below). `recoverPurchaseResult` was removed in commerce v2 PR C4.

`pending` means no client-side grant is allowed. `rejected` means the backend returned a definitive non-grant decision. The backend makes that decision one request at a time per operation key within one backend process, including the awaited analytics call, so a concurrent same-key grant there wins. Across backend processes, a rejection can still race another process's grant; route a player's monetization requests to one process where that matters. Handled verifier, backend, and per-record journal read/write failures remain retryable or pending; malformed verifier decisions are rejected rather than retried forever. Initial `store.reserve()` failures in `purchase()` or `claimRewardedAd()`, and `store.listRecoverable()` failures in `reconcile()`, reject the call instead: callers must catch these outages and retry rather than interpreting them as a pending result. An already-recorded purchase or ad grant remains granted when a later retry is unavailable or the result journal write collides. When this runtime persists a backend grant that an earlier journal write lost, it also discards any non-grant result another runtime recorded meanwhile, so the operation is re-settled as granted instead of staying rejected. Calls for the same operation key are serialized within one runtime, and `reconcile()` skips an operation already running there. Progress observers see the whole journaled call. When a journal failure is resolved into a pending or already-known granted result, the call still ends with `completed` for the status it returns; `exception` means the call itself rejected. Cross-process deduplication still depends on the atomic store and authoritative backend ledger. `reconcile()` reports a malformed same-player journal entry as `action-required` without blocking other entries; records for another target are not processed. No client-side purchase result is a grant: the helpers that read a settlement from a platform purchase result (`findAuthoritativePurchaseSettlement`, `findAdapterSettledGrant`) were removed in C4, and a provider's `settlement` pointer is a reconciler hint the backend still confirms. Account switching cannot adopt a journaled operation: its key remains bound to the original player.

## The commerce reconciler

A gateway that exposes a commerce provider (`gateway.commerce`; the
Capacitor store providers, Microsoft Store, Apps in Toss, Devvit, Verse8, and
a project's credit wallet) needs no per-store recovery driver.
`createGameServicesClient` purchases through `createCommerceReconciler`
(`@mpgd/game-services/commerce-reconciler`), one reconciler per provider that
journals every purchase the game starts or the store reports as a
`commerce-purchase` record in the same `MonetizationOperationStore`, moving
through the RFC lifecycle (`requested`, `launched`, `pending`, `purchased`,
`verifying`, `granted`, `finishing`, `finished`, plus `cancelled`, `failed`,
`rejected`, and `revoked`), one compare-and-replace revision per transition.
The client exposes it as `commerceReconciler`; the recovery client and
`createGameServicesRuntime` share one over the durable journal.

It is the only purchase path. A gateway without `gateway.commerce` sells
nothing through this client: `purchase()` answers `rejected` with a failed
platform result (`purchase.status: 'failed'`, no entitlements), reports the
`purchase_rejected` analytics event with the reason `commerce_unavailable`,
opens no store UI, sends nothing to the backend, and there is no
`commerceReconciler`. The same holds for a target whose build configuration
removed the provider.

Call `monetizationRecovery.reconcile()` at startup and on app resume: with a
provider it starts the reconciler (subscribe, read
`getAvailablePurchases` when declared, reconcile until idle) and runs a pass
on every later call, and it resumes any open rewarded-ad record. Without a
provider `reconcile()` and `restorePurchases()` only resume rewarded-ad records.
Every
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
kept so ledgers written by the former v1 drivers still deduplicate); builds and saves
the verify request once and resends it unchanged while `purchased`,
`verifying`, or server-side `pending` (a restore the backend answered
`pending` with `PURCHASE_HOLDER_LIMIT_REACHED` is resent only by
`restorePurchases()`, since nothing an automatic pass observes frees a
holder); finishes `granted` records according
to the provider's `lifecycle.finish` (`client` and `host` call
`finishTransaction` with the ledger entry id, `server` resends the saved
request until the backend reports `finalization: 'completed'`, `none` marks
`finished`); and moves reversed grants to `revoked` once the backend offers
`PurchaseVerificationApi.getPurchaseLedgerStatus` (C2). A second `purchase()`
for a product whose attempt is still `launched` or `pending` fails with
`IN_PROGRESS`; a replayed key answers from the journal and never reopens the
store UI, and a key reused for another product or source rejects;
`OUTCOME_UNKNOWN` and `ALREADY_OWNED` keep an attempt open until the
available purchases decide. A `requested` record left behind by a crash
before the store answer was journaled, and a `launched` record with no store
purchase after `staleLaunchedAfterMs` (24 hours by default; pass `Infinity`
to keep the RFC rule without expiry; `createGameServicesRuntime` and
`createGameServicesClient` take it as `commerceStaleLaunchedAfterMs`), end as
`failed` with the `OUTCOME_UNKNOWN` class so the product is not serialized
behind them; a purchase the store reports later is still journaled under its
derived key.
An error event never ends a record that already holds a store purchase or a
saved verify request. Transport failures on verify or finish keep the
state, are reported as `failure` events, and are retried on the next pass;
`finishTransaction` must be idempotent per transaction, since a crash between
a successful finish and its journal write calls it again. A backend-pending
resend, a verify or finish that failed in transport, a finalization re-read,
and a catalog lookup are retried by event-triggered passes at most once per
`retryIntervalMs` (one minute by default); `reconcile()` and
`restorePurchases()` always retry and read the provider's capability block
again. Events for a product whose store call is still running wait for that
call to journal the store answer, for at most `inFlightTimeoutMs` (ten
minutes by default). The store call of a purchase runs outside the journal lock, so events
that arrive while the store sheet is open are reconciled at once, and a
refusal before the store call (`IN_PROGRESS`, `NOT_PREPARED`, an unknown
product) leaves no record, so the same key may be retried.
Nothing is granted from a provider result: an adapter-settled purchase and a
wallet spend (`credit-wallet.spend.v1`, no `settlement`) are verified like any
other, and `finishTransaction` is only ever called for a `granted` or
`finishing` record that holds the backend's ledger entry id
(`assertCommerceFinishAllowed`), or for a `finished` consumable that a
`client`-finish store reports again: a store lists a consumable only while it
is unfinished, so the reconciler finishes it again with the journaled ledger
entry, once per session (a call that failed in transport is tried again on
the next report), without verifying it again and without rewriting the record
(on a retry, `retry: true` for a record already `finishing` before the call,
StoreKit answers a consumable that already left `Transaction.unfinished` as
finished, which can end a record before a late or unverifiable entry shows up
in the list; a first finish never sets it). Once the journal has dropped the
finished record, the transaction is verified under its derived key: for a
consumable of a `client`-finish registry entry (the App Store) the reference
backend answers this player's recorded grant (`verified`, `alreadyProcessed:
true`, the same ledger entry) instead of `EVIDENCE_ALREADY_PROCESSED`, so the
reconciler finishes it and nothing is granted twice; another player, a
durable, a reversed grant, and a backend without a registry keep the
refusal.

The durable store rules above apply to the new record kind: `listRecoverable`
returns a `commerce-purchase` record while its `state` is not terminal
(`isMonetizationOperationRecoverable` from
`@mpgd/game-services/monetization-operation-store` applies the rule for every
kind), terminal records stay addressable by `read`, and the optional
`listGranted(playerId)` returns `granted`, `finishing`, and `finished`
records within the retention window for the revocation pass, and the
optional `findByTransaction({ playerId, target, deploymentTarget, store,
transactionId })` returns the
commerce record, terminal or not, that holds a store transaction. Records
are keyed by `createCommercePurchaseOperationKey(target, idempotencyKey)`,
which is the same for every player of the install. After a logout, a
durable that the player's `restorePurchases()` finds and whose derived key
another player's record already holds is reserved under the player-scoped key `createCommercePurchaseOperationKey(target,
idempotencyKey, playerId)` instead, so a store must treat `record.key` as
opaque (store and replace by it, never rebuild it from the record's fields)
and must not assume one record per idempotency key across players.
`commerceReconciler.read(idempotencyKey)` answers this player's record under
either key and still refuses a key only another player's record holds. Implement
both: with them a purchase the store lists again after a restart (an owned
durable, a rejected or finished purchase) meets its own record instead of
being verified again under a derived key (the backend's platform-evidence
unique index remains the backstop when it is not). A
`createGameServicesClient` without an `operationStore` keeps the v2 journal
in memory for the session only and warns once (`warn`, default
`console.warn`); duplicates are then caught by the backend ledger, not by
the client.

A runtime and its reconciler act for one `playerId`. When the session can
change player within a run, pass `createGameServicesRuntime({ sessionPlayerId })`
(the reconciler's `sessionCheck`): from the moment the session names another
player, the old runtime closes before that player's headers or store account
binding reach the old player's records, and every refusal is retryable and
ends no record (see "One player per runtime" in the `@mpgd/game-services`
README). Verifying one player's purchase with another player's session gains
nothing: the kit's Google Play and App Store verification answers it (for
anything but a restored non-consumable) as
[another account's purchase](GAME_SERVICES_BACKEND.md#another-accounts-purchase),
HTTP 409 `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT`. The reconciler then parks that
player's record (kept in `verifying`, never resent automatically, `rejected` in
its summary) and leaves the derived key to the purchase's own account on the
install; an older backend's `rejected` receipt with the mismatch reason
(`GOOGLE_PLAY_ACCOUNT_MISMATCH`, `GOOGLE_PLAY_PROFILE_MISMATCH`,
`APP_STORE_ACCOUNT_TOKEN_MISMATCH`) is parked the same way.
`runtime.dispose()` closes a runtime the same way before the host creates one
for the new player; the generated game reloads instead (template README,
"Guest identity").

### The retired v1 purchase record

Releases before commerce v2 C4 wrote a `purchase` journal record for every
purchase, with the store result embedded. The reconciler replaced that path
and no code starts or resumes a purchase from those records any more, but a
durable journal may still hold them, so the record type stays readable
(`RetiredPurchaseOperationRecord`, part of `LegacyMonetizationOperationRecord`)
and `read` returns it unchanged. The store UI is never reopened for one and the
client never grants from one. The only thing left is finishing a verification
the record was in the middle of: `isMonetizationOperationRecoverable` answers
`true` for a retired record that holds a completed platform result and no
terminal result, and `reconcile()`/`restorePurchases()` of the recoverable
client send its saved verify request (or the one its own fields describe) to
the backend once more under the same idempotency key, journal the backend's
answer as the closing result (`granted` or `rejected`), and report it. A
backend outage leaves the record open for the next pass. A retired record whose
platform result never completed is not open and is never sent. Whatever the
store still holds is found again by the reconciler under a derived key
(`store:<store>:<transactionId>`, `play-token-sha256:<hex>`,
`apps-in-toss:purchase:<orderId>`), and the backend's platform-evidence index
keeps a repeated verification from granting twice. Stores without an
unfinished-purchase list (ONE play) rely on this drain and on the server-side
PNS recovery the game owns. A store may purge closed retired records at any
time. Rewarded-ad records are unchanged.

### Reading entitlements

The v1 gateway offered `gateway.commerce.getEntitlements()` and a client-side
entitlement list built from store receipts. Both are gone: a client list is
not a grant. The backend ledger owns ownership. Read it on the server with
`listActiveEntitlementTransactions(store, { playerId })` from
`@mpgd/game-services/commerce-ledger` (reversed grants are subtracted) or the
batched `getPurchaseLedgerStatus`, and serve the result to the game through
its own authenticated endpoint. On the client, `purchase()` and the
reconciler's journal report what this session bought and whether the grant was
confirmed; the recovery summaries report open work only.

This contract and its mock tests do not prove that a native Billing, StoreKit, or AdMob provider can recover its callbacks on a device. Provider-specific replay, secure storage, SSV delivery, and real account/device evidence are separate release gates.

## Phaser starter assembly

The private starter and newly generated games construct one game-owned runtime
above their scenes. Supply `bootstrapStarter({ monetization: { operationStore,
reconciliation, purchasePresentation } })` in the private example, or provide
those bootstrap options in a generated game's entrypoint.

Without an `operationStore` the starter installs its reference journal,
`createStorageMonetizationOperationStore({ storage: gateway.storage })` from
`src/platform/monetizationJournal.ts` (commerce v2 PR C3), so the reconciler
and the rewarded-ad recovery always have a durable journal and versioned
rewarded display is no longer policy-disabled for want of one. It keeps one
JSON document under `mpgd:monetization-journal` in the platform storage,
serializes every call so `replace` is a real compare-and-swap inside the
WebView (the expected revision, the next revision, and the record's player,
targets, and kind must match), and implements `listRecoverable`,
`listGranted`, and `findByTransaction`. Open records are never dropped,
except records parked as another account's purchase; terminal records leave
on the next write after 30 days or beyond the 100 most recently settled
(`retentionMs`, `maxTerminalRecords`), which keeps the document inside
per-value storage limits such as the Devvit bridge's 256 KiB. Parked records
leave 30 days after their last write (the parking or the player's last
Restore Purchases resend), and at most the 20 most recently written are kept
across every player of the install (`parkedRetentionMs`, `maxParkedRecords`).
Nothing of their player is in progress and the backend's answer granted and
recorded nothing, so dropping one cannot lose a grant: the backend ledger
decides every grant (a later verify of the same purchase finds one whose
answer was lost), and the store keeps the purchase for its own account, which
recovers it under its own key. A dropped purchase the store still lists is
verified once more by the next pass that meets it and parked again; beyond
the count bound that repeats on each such pass, as an older client does for
every such purchase. A Restore Purchases resend rewrites the record first,
and no bound (the byte budget included) drops a parked record written within
the in-flight window (`parkedInFlightMs`, 10 minutes by default, the
reconciler's default `inFlightTimeoutMs`; a game that changes that timeout
passes the same value), in any tab, or the one the journal wrote last, so a
resend's record is there when its answer arrives. A parked record without a
readable time is never in flight: only the count bound and the byte budget
drop it. The rule only
removes records; the document format is unchanged. A document it cannot parse fails every call instead of being
replaced, since starting over could verify a purchase twice. The journal is
durable on the host, but platform storage is not encrypted: a game whose
host cannot keep that storage private, or that must keep purchase receipts
encrypted at rest, passes its own encrypted, access-controlled store, which
must satisfy the rules above. Backend URL/auth and independent server
authorities are still required; a journal is not grant authority.

The scene receives the coordinated gateway, services and action coordinator.
It disposes its action view on shutdown, while the game retains late evidence
observation and the original recovery client. Startup/resume recovery never
opens advertising or purchase UI. Native presentation facts release execution;
SDK eligibility and backend ledger results do not release a live native owner.
