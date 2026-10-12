---
npm/@mpgd/game-services: minor
---

Commerce v2, PR C1: one reconciler in the game-services client replaces the
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
  the store UI; `OUTCOME_UNKNOWN` and `ALREADY_OWNED` keep an attempt open.
  Transport failures on verify or finish keep the state and are reported
  through `onEvent` / `subscribe` as `failure` events, then retried on the
  next pass.
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
optional `listGranted(playerId)` read for the revocation pass, and
`@mpgd/game-services/monetization-operation-store` exports
`isMonetizationOperationRecoverable` (the `listRecoverable` rule for every
kind), `isMonetizationOperationGranted`, and
`createInMemoryMonetizationOperationStore` (session-only, for tests and
clients without a durable store). A store that narrows records on `result`
or `platform` must check `kind` first.

Tests: every transition and the match order in
`commerce-reconciler.test.ts`; the fourteen RFC vectors run through the real
reconciler in `commerce-reconciler-conformance.test.ts` via the runner's new
`createRuntime` hook; and the Play and StoreKit plugins carry smoke tests
showing the deprecated v1 drivers and the reconciler reach the same outcomes
over their fake SDKs.
