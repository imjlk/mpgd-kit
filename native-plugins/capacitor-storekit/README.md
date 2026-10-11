# @mpgd/capacitor-storekit

Opt-in StoreKit 2 one-time purchase collector for Capacitor 8 on iOS.
It does not enable native IAP in the base Capacitor shell. Install it only in a
game-owned iOS project and register `createCapacitorStoreKitProvider(...)` in
that game's provider list.

Map each logical game product to its App Store Connect product ID and provide
an authenticated, stable UUID `getAppAccountToken()` value. The game backend
must resolve the same UUID for the player. Product lookup, purchase results,
`Transaction.updates`, unfinished transactions, and current non-consumable
entitlements provide **provisional evidence**, never a wallet or entitlement
grant. A completed native purchase returns no `authoritativeGrant`.

## Commerce v2 provider

Commerce v2 ([RFC](../../docs/specs/commerce/commerce-v2-rfc.md), PR B3)
adds a second surface next to the v1 provider above. The package exposes the
native plugin as a `StoreSdk` from `@mpgd/adapter-capacitor` and a
`CommerceProvider` from `@mpgd/platform/commerce` built on
`createStoreCommerceProvider`. Register the v2 service provider **or** the v1
`createCapacitorStoreKitProvider` in a gateway, never both.

```ts
import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import { createCapacitorStoreKitServiceProvider } from '@mpgd/capacitor-storekit';

export function createIosGateway(getAppAccountToken: () => Promise<string>) {
  return createCapacitorPlatformGateway({
    target: 'ios',
    appVersion: '1.0.0',
    buildId: 'game-build',
    providers: [
      createCapacitorStoreKitServiceProvider({
        products: [
          { logicalId: 'gems_small', storeSku: 'com.example.game.gems.small', kind: 'consumable' },
          { logicalId: 'remove_ads', storeSku: 'com.example.game.remove.ads', kind: 'durable' },
        ],
        // Authenticated, stable UUID; the backend's resolveAppAccountToken returns the same.
        getAppAccountToken,
        bundleId: 'com.example.game',
      }),
    ],
  });
}
```

`createCapacitorStoreKitStoreSdk({ productIds, sdk?, isIos? })` is the
`StoreSdk`: `store: 'app-store'`; capabilities consumable and durable, no
subscription, no quantity, `pending` (Ask to Buy), `restore`
(`AppStore.sync()`), and `finish: 'client'`; `fetchProducts` over
`getProducts` (subscription lookups are empty without a native call);
`requestPurchase` over `purchase` with the `app-account-token` binding as the
`appAccountToken` (a missing binding fails with `ACCOUNT_BINDING_REQUIRED`,
a non-UUID one with `STOREKIT_CONFIGURATION_ERROR`, and the store never
opens), answering `purchased` with the transaction, `launched` for a pending
Ask to Buy, and `cancelled` for a dismissed sheet; `getAvailablePurchases`
over `getTransactions`, listing unfinished transactions once (a current
non-consumable entitlement the native side marks `unfinished: false` is not
listed, a `revokedAt` maps to `state: 'revoked'`, and one malformed
transaction is reported as a `purchaseError` without blocking its siblings);
`finishTransaction({ transactionId, ledgerEntryId })` over the native finish;
`restorePurchases` over `sync`; `transactionUpdated` as `purchaseUpdated`;
and the v1 availability probe as `getAvailability`. Every purchase carries
the StoreKit-verified `signedTransaction` JWS as its `token`, the
`transactionId`, `originalTransactionId`, `purchasedAt`, `quantity: 1`, and
the `app-account-token` binding. `storeKitStoreSdkErrorCodeMap` maps every
`STOREKIT_*` plugin code onto the RFC "Errors" codes;
`STOREKIT_PURCHASE_UNCERTAIN` and `STOREKIT_UNKNOWN_RESULT` normalize to
`OUTCOME_UNKNOWN`, which `createStoreCommerceProvider` keeps recoverable (the
attempt stays `launched` and the reconciler resolves it from
`getAvailablePurchases`).

`createCapacitorStoreKitCommerceProvider({ products, getAppAccountToken,
bundleId?, sdk?, isIos?, mapError? })` builds the provider with
`authority: { evidence: 'client-token', accountBinding: 'required' }` and
evidence `{ schema: 'app-store.signed-transaction.v1', payload: {
signedTransaction, transactionId, originalTransactionId?, bundleId? } }`,
where `signedTransaction` is the same JWS as `StorePurchase.token`.
`@mpgd/game-services/app-store-verifier` verifies that JWS offline through
its `signedTransactionVerifier` and falls back to the App Store Server API
lookup only for requests without it. Subscription mappings are rejected at
construction. `createCapacitorStoreKitServiceProvider` wraps the provider as
a `CapacitorServiceProvider` (id `apple-storekit` by default) so the gateway
serves the `commerce.v2.*` and v1 `commerce.*` bridge methods from it and
exposes it as `gateway.commerceV2`.

Finishing never grants. The v2 SDK finishes any transaction it is given a
`ledgerEntryId` for: the commerce v2 reconciler is the gate, and it calls
`finishTransaction` only after the backend ledger granted the purchase. The
v1 `finishGrantedTransaction` allow-list guard is not reproduced; the real
control stays server-side, in the verifier that checks the JWS before the
ledger grant, and in the native plugin never granting anything on finish.
The v1 recovery helpers (`recoverStoreKitPurchases`,
`getRecoverableTransactions`, `finishGrantedTransaction`) are deprecated in
favor of the single reconciler (RFC C1) and are removed in C4.

The conformance test runs every store vector whose profile the App Store
supports against a fake plugin, directly and through the gateway bridge path,
and lists each skipped vector with its reason (host or server finish,
quantity, server-push, an asynchronous store error event StoreKit never
emits, and a pending transaction state StoreKit never reports).

## v1 provider and recovery

On startup, account restoration, and after a pending or uncertain checkout,
call `recoverStoreKitPurchases({ provider, backend, playerId })`. It sends only
transactions whose `appAccountToken` matches the current authenticated game
account to the game-owned `backend.recoverPurchase` contract. That backend
must reuse the original idempotency key from the durable purchase journal, or
return the existing ledger grant for the same Apple evidence, product and
player. It must not invent a new key for an already-granted transaction: the
generic game-services verifier rejects such evidence replay. For new evidence,
the backend uses the existing App Store Server API/JWS verifier to validate
bundle, product, environment and account binding before the ledger grant.
The recovery helper calls native `finishTransaction` only after a
verified response with a ledger entry ID. If finish fails, it reports
`finishPending: true`; repeat recovery with the original purchase identity.
`provider.finishGrantedTransaction` accepts only a transaction and ledger
entry pair that `recoverStoreKitPurchases` recorded from a backend answer in
the current session. The pair is consumed before the native call, so
overlapping finishes (for example startup recovery and a `transactionUpdated`
recovery) share one native call, and a failed native finish restores the pair
for a retry. Calling it, or the native `finishTransaction` plugin method, with
any other value is rejected so an unfinished purchase keeps its recovery
signal. This guard prevents arbitrary or accidental finish calls with
unverified ledger IDs and binds finishing to the recovery flow; it is **not**
a trust boundary against code that controls the `backend` object it passes to
`recoverStoreKitPurchases`. The real control is server-side: the authenticated
`recoverPurchase` implementation must verify Apple evidence before it grants,
and finishing a transaction never grants anything by itself.
An unknown backend result stays pending and never triggers a
new purchase sheet automatically.

On the game server, `@mpgd/game-services/app-store-recovery` provides
`createAppStoreRecoveryBackend(...)` for this contract. Construct it only after
authenticating the game player, and bind `playerId` to that authenticated
identity. Pass the same durable `GameServicesStore` instance and
`createGameServicesBackend(...).purchases` used for checkout. Its optional
`resolveOriginalIdempotencyKey` callback must query the game's durable
checkout journal for the **original** key associated with this player and
transaction. The adapter first checks existing App Store ledger evidence and
rejects cross-player, cross-product, cross-deployment and key collisions. If
neither a matching grant nor an original journal key exists, it returns
`pending` without attempting a new grant. Do not use the in-memory store for
production recovery. The game's HTTP/RPC endpoint must authenticate the
request; this helper does not expose one or authenticate clients.
For restored non-consumables whose new transaction ID differs from the
original, configure `restoredNonConsumables` with the same catalog and official
App Store evidence verifier, bundle ID and environment used by the game backend.
When no prior grant exists, also bind `deploymentTarget` on the server-side
recovery backend. The client-supplied target is not trusted to select a product;
without a bound target this restore stays pending until the game backend is
configured for its deployment. An existing grant can supply its recorded target.
The bundle/environment identify an existing grant for its deployment target
before product lookup; they must match the verifier configuration. The helper re-verifies
the **current** Apple transaction and looks up the prior grant by its canonical
original-transaction verification ID before reusing the original key. Without
that verifier, this restore remains pending rather than trusting a client-
reported original ID. A verifier that exceeds its timeout also remains pending.
The native provider forwards both IDs and product type.
For production-scale ledgers, implement the store's indexed
`findEntitlementTransactionByPlatformEvidence` and
`findEntitlementTransactionByIdempotency` methods, plus
`findEntitlementTransactionByEvidenceVerificationId` for restored
non-consumables. Without them, the helper
uses the same full-ledger scan fallback as the generic game-services server.

An existing grant is returned by the normal backend idempotent-retry path;
that path relies on the prior verified ledger record rather than fetching
fresh Apple status. Continue to process App Store revocations separately.
Permanently rejected and account-mismatched transactions are reported as
`rejected` and are **not** finished: the helper cannot prove content delivery
for them. Persist that terminal result in the game-owned operation journal and
do not run an automatic retry loop for it. A support flow may recheck a
corrected account or backend decision later. One malformed transaction is
reported separately and cannot block valid sibling transactions.

The iOS native plugin also emits `transactionUpdated` for delayed StoreKit
transactions. Call recovery after this event and on app launch because events
can be missed while the game is closed. `commerce.restore` intentionally
invokes user-initiated `AppStore.sync()` before returning no local entitlements;
call recovery afterward. Subscriptions are not supported by this package;
they require a separate subscription status and renewal flow.

The Kit tests use mocked StoreKit responses and a syntax-only local Swift
parse. The macOS CI job compiles the optional Swift package against an iOS
Simulator SDK. Neither check proves a signed App Store purchase, sandbox
checkout, TestFlight installation, or device grant. Validate those with a
game-owned account, keys, and device before a production rollout.
