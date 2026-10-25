# @mpgd/capacitor-storekit

Opt-in StoreKit 2 one-time purchase collector for Capacitor 8 on iOS.
It does not enable native IAP in the base Capacitor shell. Install it only in a
game-owned iOS project and register `createCapacitorStoreKitServiceProvider(...)`
in that game's provider list.

Map each logical game product to its App Store Connect product ID and provide
an authenticated, stable UUID `getAppAccountToken()` value. The game backend
must resolve the same UUID for the player. Product lookup, purchase results,
`Transaction.updates`, unfinished transactions, and current non-consumable
entitlements provide **provisional evidence**, never a wallet or entitlement
grant. A completed native purchase returns no `authoritativeGrant`.

## Commerce provider

Commerce ([RFC](../../docs/specs/commerce/commerce-v2-rfc.md)) is the only
surface of this package. It exposes the native plugin as a `StoreSdk` from
`@mpgd/adapter-capacitor` and a `CommerceProvider` from
`@mpgd/platform/commerce` built on `createStoreCommerceProvider`, registered
with the Capacitor gateway as `gateway.commerce`.

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

`createCapacitorStoreKitStoreSdk({ products, getAppAccountToken, sdk?, isIos?,
onDiagnostic? })` is the `StoreSdk`: `store: 'app-store'`; capabilities
consumable and durable, no subscription, no quantity, `pending` (Ask to
Buy), `restore` (`AppStore.sync()`), and `finish: 'client'`; `fetchProducts`
over `getProducts` (subscription lookups are empty without a native call);
`requestPurchase` over `purchase` with the `app-account-token` binding as the
`appAccountToken` (a missing binding fails with `ACCOUNT_BINDING_REQUIRED`,
a non-UUID one with `STOREKIT_CONFIGURATION_ERROR`, and the store never
opens), answering `purchased` with the transaction, `launched` for a pending
Ask to Buy, and `cancelled` for a dismissed sheet; `getAvailablePurchases`
over `getTransactions`, listing unfinished transactions and finished durables
once (a current non-consumable entitlement the native side marks
`unfinished: false` stays listed so a finish that raced the ledger grant can
still be verified; the server ledger dedupes. A finished consumable is not
listed. A `revokedAt` maps to `state: 'revoked'`, and one malformed
transaction is reported as a `purchaseError` without blocking its siblings);
`finishTransaction({ transactionId, ledgerEntryId })` resolves the session
app account token and finishes only a listed, non-revoked transaction bound
to that token;
`restorePurchases` over `sync`; `transactionUpdated` as `purchaseUpdated`;
and an availability probe as `getAvailability`, probing the configured
SKUs batch by batch until one is sold. Every purchase carries the
StoreKit-verified `signedTransaction` JWS as its `token`, the
`transactionId`, `originalTransactionId`, `purchasedAt`, `quantity: 1`, and
the `app-account-token` binding. `storeKitStoreSdkErrorCodeMap` maps every
`STOREKIT_*` plugin code onto the RFC "Errors" codes;
`STOREKIT_PURCHASE_UNCERTAIN` and `STOREKIT_UNKNOWN_RESULT` normalize to
`OUTCOME_UNKNOWN`, which `createStoreCommerceProvider` keeps recoverable (the
attempt stays `launched` and the reconciler resolves it from
`getAvailablePurchases`).

Before any purchase sheet opens, the SDK checks the store product against
the catalog's declared kind (fetching it once if `fetchProducts` has not
seen it): a mapping that declares `durable` for an App Store consumable, or
the reverse, fails with `STOREKIT_CONFIGURATION_ERROR`
(`CONFIGURATION_REQUIRED`), an unmapped SKU with `STOREKIT_PRODUCT_UNKNOWN`
and a SKU the store does not sell with `STOREKIT_PRODUCT_UNAVAILABLE` (both
`ITEM_UNAVAILABLE`), so the player is never charged for a purchase the
backend would reject with `APP_STORE_PRODUCT_TYPE_MISMATCH`; the purchased
transaction's type is checked against the mapping as well. The SDK also
answers only for the configured catalog and the active account, on the
polling and the event path alike: a transaction for a retired or otherwise
unmapped SKU, one whose signed `appAccountToken` is not the token
`getAppAccountToken` resolves (a shared device or an in-game account switch;
it is listed again once that player signs back in), or one whose StoreKit
type disagrees with the catalog kind is never listed or emitted, so the
reconciler never journals a purchase it cannot resolve or that belongs to
another player, and never blocks a valid sibling on one. Each exclusion is
reported through `onDiagnostic` (`unmapped-sku`, `account-mismatch`,
`kind-mismatch`); diagnostics are never a grant signal. The native
`transactionUpdated` listener is attached while either a `purchaseUpdated`
or a `purchaseError` subscriber exists.

`createCapacitorStoreKitCommerceProvider({ products, getAppAccountToken,
bundleId?, sdk?, isIos?, mapError?, onDiagnostic? })` builds the provider
with `authority: { evidence: 'client-token', accountBinding: 'required' }`
and evidence `{ schema: 'app-store.signed-transaction.v1', payload: {
signedTransaction, transactionId, originalTransactionId?, bundleId? } }`,
where `signedTransaction` is the same JWS as `StorePurchase.token`.
`@mpgd/game-services/app-store-verifier` verifies that JWS offline through
its `signedTransactionVerifier` (authenticity and transaction id binding)
and then, by default, decides the grant on the transaction's current status
from the App Store Server API, so a JWS retained from before a refund never
grants; see the backend guide for the opt-in offline-only mode. Subscription
mappings are rejected at construction. `createCapacitorStoreKitServiceProvider`
wraps the provider as a `CapacitorServiceProvider` (id `apple-storekit` by
default, no `features`, no `methods`) so the gateway serves the six
`commerce.v2.*` bridge methods from it, exposes it as `gateway.commerce`, and
reports its capability block in `getCapabilities().commerce`.
`createStoreKitCommerceCapabilities(availability)` (from `src/commerce-profile.ts`,
which imports types only and no Capacitor code) returns the full
`CommerceCapabilities` block this provider declares while the store reports
`availability`, so a validator or server can read the profile without loading
the plugin; a unit test keeps it equal to `provider.getCapabilities()`.

Finishing never grants. The SDK finishes any transaction it is given a
`ledgerEntryId` for: the commerce reconciler
(`createCommerceReconciler` in `@mpgd/game-services`) is the gate, and it
calls `finishTransaction` only for a journal record in `granted` or
`finishing` that holds the ledger entry id the backend grant wrote
(`assertCommerceFinishAllowed`). The journal revision the grant wrote is the
pairing, and the real control stays server-side, in the verifier that checks
the JWS before the ledger grant, and in the native plugin never granting
anything on finish. `src/commerce-reconciler-storekit-smoke.test.ts` shows the
reconciler over the fake plugin: a grant finishes with the ledger entry, a
rejection and an outage never finish, a failed finish is retried, and another
account's transaction is never submitted.

The conformance test runs every store vector whose profile the App Store
supports against a fake plugin, directly and through the gateway bridge path,
and lists each skipped vector with its reason (host or server finish,
quantity, server-push, an asynchronous store error event StoreKit never
emits, and a pending transaction state StoreKit never reports).

### Generated games

Games generated by `mpgd game create` (and the kit's private starter) ship
this wiring in `src/platform/buildGateways/capacitorIos.ts` (commerce v2 PR
C3): the service provider is registered for every catalog product whose
`platformProductIds.ios` names an App Store product id (subscriptions are
skipped), and `getAppAccountToken` is the reference binding in
`src/platform/commerceAccountBinding.ts`, a UUID (version 5 layout) over the
SHA-256 of `mpgd-commerce-account:<playerId>` for the server session's
player (the generated game's `guestIdentity.ts` signs in a server-issued
guest when `VITE_MPGD_IDENTITY_URL` is set) or an authenticated platform
player; the native shell's local player throws an error naming the missing
server session, so no sheet opens without a binding. The backend's
`resolveAppAccountToken` must derive the same UUID, or both are replaced
together.

`mpgd target init capacitor --providers storekit` installs this package into
the game-owned shell and the game at one exact version and lets `cap add` or
`cap sync` register its Swift package; on a game that still has the unwired
gateway of an earlier template it also writes the wiring above. A build
whose shell lacks the native plugin still runs: the plugin answers
Capacitor's `UNIMPLEMENTED`, which the SDK reports as
`configuration-required`, so no purchase sheet opens.

## Recovery

Call the reconciler (`monetizationRecovery.reconcile()` from
`@mpgd/game-services`) on startup, on resume, and after the iOS plugin emits
`transactionUpdated` for a delayed transaction (Ask to Buy, an interrupted
checkout, a transaction finished on another device): the events can be missed
while the game is closed, so `getAvailablePurchases` (`Transaction.unfinished`,
plus finished non-consumables still in `currentEntitlements`) is the source
of truth. The reconciler sends only transactions whose
`appAccountToken` matches the current authenticated game account, verifies
each one on the backend under its original idempotency key or returns the
existing ledger grant, and calls `finishTransaction` only after a verified
response with a ledger entry id. The StoreKit SDK and the native plugin both
refuse to finish a transaction whose app account token is missing or does
not match that session. A caller who can read the token from the plugin can
still present it with a forged ledger entry id; that remaining hole needs a
signed server finish capability. Permanently rejected and account-mismatched
transactions are not finished: the client cannot prove content delivery for
them, so persist that terminal result in the game-owned operation journal and
do not run an automatic retry loop for it. An unknown backend result stays
pending and never opens a new purchase sheet. Process App Store revocations
separately on the server. `restorePurchases` invokes the user-initiated
`AppStore.sync()` and then runs a reconciler pass; it returns no local
entitlements. Subscriptions are not supported by this package; they require a
separate subscription status and renewal flow.

### Migrating from v1

Commerce v2 PR C4 removed the v1 provider and its recovery driver.

| Removed | Replacement |
| --- | --- |
| `createCapacitorStoreKitProvider`, `StoreKitProviderOptions`, `StoreKitProductMapping`, `CapacitorStoreKitProvider` | `createCapacitorStoreKitServiceProvider` (registry entry) or `createCapacitorStoreKitCommerceProvider`; rename `id`/`storeId`/`type` to `logicalId`/`storeSku`/`kind` (`non_consumable` becomes `durable`); `getAppAccountToken` keeps its meaning |
| `recoverStoreKitPurchases`, `StoreKitRecoveryBackend`, `RecoveredStoreKitPurchase`, `StoreKitPurchaseVerification`, `StoreKitRecoverySnapshot`, `RecoverableStoreKitTransaction`, `InvalidStoreKitTransaction` | the reconciler in `@mpgd/game-services` (`createCommerceReconciler`, behind `createGameServicesClient` and `monetizationRecovery.reconcile()`), driven by `getAvailablePurchases` and `purchaseUpdated` |
| `getRecoverableTransactions`, `finishGrantedTransaction` | `getAvailablePurchases` and `finishTransaction`, called by the reconciler after the ledger grant (`assertCommerceFinishAllowed`) |
| `getAppAccountToken()` on the provider object | the `accountBinding` of the commerce provider resolves the same token |
| `gateway.commerceV2`, the v1 `commerce.*` bridge methods | `gateway.commerce` and the `commerce.v2.*` methods |
| `features: ['nativeIap']` on the registry entry | none: the entry declares no `features` and its readiness is `getCapabilities().commerce` |

The Kit tests use mocked StoreKit responses and a syntax-only local Swift
parse. The macOS CI job compiles the optional Swift package against an iOS
Simulator SDK. Neither check proves a signed App Store purchase, sandbox
checkout, TestFlight installation, or device grant. Validate those with a
game-owned account, keys, and device before a production rollout.
