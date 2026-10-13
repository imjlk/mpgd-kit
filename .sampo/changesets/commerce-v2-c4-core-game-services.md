---
npm/@mpgd/game-services: minor
---

BREAKING: commerce v2, PR C4 removes the v1 purchase path from the game-services
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

Provider readiness is checked before optional catalog resolution. A retryable provider failure whose presentation source proves checkout never started stays requested with its diagnostic, so the original bound key can be retried across restarts. Recovery does not reopen the payment surface; failures without that proof retain their prior terminal behavior.
