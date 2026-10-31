# @mpgd/capacitor-storekit

Opt-in StoreKit 2 one-time purchase collector for Capacitor 8 on iOS, built
on the [OpenIAP](https://github.com/hyodotdev/openiap) Apple core (4.0.7).
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
listed. A `revokedAt` maps to `state: 'revoked'`, and an unfinished revoked
transaction stays listed in that state so a refund before the finish can be
finished later (see Recovery); one malformed
transaction is reported as a `purchaseError` without blocking its siblings);
`finishTransaction({ transactionId, ledgerEntryId, isConsumable, retry?, revoked? })`
resolves the session app account token and finishes only a listed,
non-revoked transaction bound to that token, or a durable of another token or
of no token a restore shared to this player (see Recovery), and on a retry (`retry: true`)
answers `finished: true` without a native call for a consumable the list no
longer carries (a lost acknowledgement, see Recovery); with `revoked: true`
(the SDK declares `acceptsRevokedFinish`; `ledgerEntryId` may then be
absent) it finishes only a listed, revoked consumable bound to that token (a
refund before the finish, see Recovery);
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
`kind-mismatch`); diagnostics are never a grant signal. One exception: the
player's Restore Purchases read (`getAvailablePurchases({ restore: true })`,
sent only by the reconciler's `restorePurchases`) also lists a durable bound
to another or no token, the state of every earlier purchase after a reinstall
or on a new iPhone or iPad, so the backend's restore sharing can decide;
consumables of another token stay excluded. The native
`transactionUpdated` listener is attached while either a `purchaseUpdated`
or a `purchaseError` subscriber exists.

`createCapacitorStoreKitCommerceProvider({ products, getAppAccountToken,
purchaseGate?, bundleId?, sdk?, isIos?, mapError?, onDiagnostic? })` builds the provider
with `authority: { evidence: 'client-token', accountBinding: 'required' }`
and evidence `{ schema: 'app-store.signed-transaction.v1', payload: {
signedTransaction, transactionId, originalTransactionId?, bundleId? } }`,
where `signedTransaction` is the same JWS as `StorePurchase.token`.
`@mpgd/game-services/app-store-verifier` verifies that JWS offline through
its `signedTransactionVerifier` (authenticity and transaction id binding)
and then, by default, decides the grant on the transaction's current status
from the App Store Server API, so a JWS retained from before a refund never
grants; see the backend guide for the opt-in offline-only mode, which instead
refuses a refund the backend recorded from App Store Server Notifications
(its `revocations` registry is required). Subscription
mappings are rejected at construction. `getAppAccountToken` also filters
recovery and finishing to the current player, so it must keep answering
while sales are paused: pause new sales with the optional `purchaseGate`
instead, which is asked only before a new purchase opens the StoreKit sheet
(never by recovery, restore, or finishing) and refuses with `failed`,
`ITEM_UNAVAILABLE`, and `PURCHASES_PAUSED` (see the adapter-capacitor
README). With an adapter-capacitor from before
the gate, which would ignore it, the plugin detects the missing gate support
and answers every new purchase itself with a `failed` result, `ITEM_UNAVAILABLE` and
`PURCHASE_GATE_UNSUPPORTED` instead of selling; recovery is unaffected.
A token that cannot be resolved is a `failed` result with
`STOREKIT_ACCOUNT_LOOKUP_FAILED` (a thrown `CommerceError` keeps its own code). `createCapacitorStoreKitServiceProvider`
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
(`assertCommerceFinishAllowed`), or for a `finished` consumable StoreKit
lists again, with that same ledger entry (see Recovery). The journal revision
the grant wrote is the pairing, and the real control stays server-side, in
the verifier that checks the JWS before the ledger grant, and in the native
plugin never granting anything on finish.
`src/commerce-reconciler-storekit-smoke.test.ts` shows the reconciler over
the fake plugin: a grant finishes with the ledger entry, a rejection and an
outage never finish, a failed finish is retried, another account's
transaction is never submitted, a finish whose answer was lost ends
`finished` on the next run, a transaction listed again is finished again
without a second verify, and an Ask to Buy purchase finishes once approved.

The conformance test runs every store vector whose profile the App Store
supports against a fake plugin, directly and through the gateway bridge path,
and lists each skipped vector with its reason (host or server finish,
quantity, server-push, an asynchronous store error event StoreKit never
emits, and a pending transaction state StoreKit never reports).

### Purchase sheet facts

The provider offers `CommerceProvider.presentation` (see "Store sheet facts"
in the `@mpgd/adapter-capacitor` README), so the gateway keeps the game
paused, and the game runtime keeps ads out, for the life of the purchase
sheet rather than until a result event. The native plugin reports `open`
right before OpenIAP calls `Product.purchase()` and `closed` when that call
returns or throws, before it answers; a call it refuses earlier (invalid
input, provider not ready, product unavailable) is `not-started`. An Ask to
Buy (`pending`) is `closed` when the call returns; its purchase still arrives
later through `transactionUpdated`. Facts reach JavaScript as
`purchasePresentation` events (retained, keyed by a random id per call) and
in the `presentation` field of the `purchase` answer or rejection data. The
adapter adds a 15-minute safety timeout.

Apple documents that `purchase(options:)` "displays the confirmation sheet"
and returns a `PurchaseResult`
([purchase(options:)](https://developer.apple.com/documentation/storekit/product/purchase(options:)),
[purchase(confirmIn:options:)](https://developer.apple.com/documentation/storekit/product/purchase(confirmin:options:)-6dj6y)),
but not that it returns only once the sheet is dismissed. `closed` therefore
means "the purchase call ended"; that the sheet is gone by then is unverified
until device testing.

`getPresentationSupport` declares the facts. A web bundle running on a native
build from before them (a live update) gets `UNIMPLEMENTED` there: while an
adapter follows the facts, the store then reads `configuration-required` (the
shop sells nothing and the reconciler spends no idempotency key), and a
purchase that still gets through is refused with `CONFIGURATION_REQUIRED` /
`STOREKIT_PRESENTATION_UNSUPPORTED` instead of opening a sheet the game would
wait on; recovery is unaffected. `purchasePresentation: false` on the
provider keeps the result-based pause of earlier releases.

Device acceptance (not run; no device was available): the sheet cancelled, a
completed purchase, an Ask to Buy request, the app backgrounded with the
sheet up and resumed, and an iPad (sheet as a form sheet). Each must pause
the game from `open` to `closed`, and `closed` must not arrive while the sheet
is still visible. The steps and expected signals are in the kit's
[purchase device acceptance checklist](https://github.com/imjlk/mpgd-kit/blob/main/docs/PURCHASE_DEVICE_ACCEPTANCE.md).

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
refuse to call `transaction.finish()` on a transaction whose app account
token is missing or does not match the token they are given; the SDK gives the
session's, except for a durable of another token or of no token (below). A caller who can read the token from the plugin can
still present it with a forged ledger entry id; that remaining hole needs a
signed server finish capability. A listed, non-revoked durable StoreKit
already finished (`unfinished: false`) answers `{ finished: true }` without a
native call whatever its token, so a purchase shared to this guest from an
earlier guest's restore ends there. A durable of the configured catalog still
unfinished under another token (the earlier guest crashed between its grant
and its finish, then the app was reinstalled; or a native build omits
`unfinished`) is finished with that transaction's own token, which the native
token match accepts, so the shared grant's record does not retry forever. The
reconciler calls it only for this player's ledger grant, and finishing a
durable takes nothing from the earlier guest: StoreKit keeps it in
`Transaction.currentEntitlements`, where that guest's own read still lists it
(`unfinished: false`). The native plugin is unchanged and still filters
nothing by token on reads. A webview caller can therefore finish another
token's unfinished durable, which, for the same reason, grants or removes
nothing.

A durable of the configured catalog still unfinished and bound to no token
(an offer code redeemed in the App Store, or another purchase made outside
the app, then restored; the backend's restore sharing grants it as
`APP_STORE_ACCOUNT_TOKEN_MISSING`) is finished with the explicit no-token
match: `finishTransaction({ transactionId, ledgerEntryId,
withoutAppAccountToken: true })`, with no `appAccountToken` field at all.
The native plugin then matches only a verified, non-revoked non-consumable
bound to no token; a missing token without the flag is still refused
(`STOREKIT_FINISH_REQUIRES_GRANT`), never read as "any token". The SDK sends
it only for a durable its catalog declares, for a record the reconciler
holds a ledger grant for, and only when the native build declares the match
through `getFinishSupport` (`{ withoutAppAccountToken: 1 }`). A native build
from before it answers that method with `UNIMPLEMENTED` (remembered) and would
refuse the call, so the SDK leaves the durable unfinished there and the record
keeps retrying `finishing`, as in earlier releases; the entitlement is
unaffected. Rebuild the app with this package's native code to finish it.
The catalog and ledger-grant conditions are the SDK's and the reconciler's;
the native match checks only the transaction itself and, like the token
match, is not a signed server capability, so a webview caller could finish
such a durable too, which grants or removes nothing.
Finishing takes nothing from anyone for the same reason as above:
StoreKit keeps a finished non-consumable in `Transaction.currentEntitlements`
([Apple](https://developer.apple.com/documentation/storekit/transaction/currententitlements)).

A consumable of another token or of no token is never finished: the SDK
never admits it, the backend refuses one bound to no token for every
player (`APP_STORE_ACCOUNT_TOKEN_MISSING`), and it stays in
`Transaction.unfinished`, reported as an `account-mismatch` diagnostic on each
read. Subscriptions are never reported or finished by this plugin.
Permanently rejected and account-mismatched
transactions are not finished: the client cannot prove content delivery for
them, so persist that terminal result in the game-owned operation journal and
do not run an automatic retry loop for it. An unknown backend result stays
pending and never opens a new purchase sheet. Process App Store revocations
separately on the server. `restorePurchases` invokes the user-initiated
`AppStore.sync()` and then runs a reconciler pass; it returns no local
entitlements. Subscriptions are not supported by this package; they require a
separate subscription status and renewal flow.

A finish whose answer is lost after StoreKit applied it (the app is closed
between the native finish and the journal write) leaves the record
`finishing`. The reconciler's next finish of a record that was already
`finishing` carries `retry: true`, and on a retry the SDK reads the
consumable missing from `getTransactions` as finished: StoreKit keeps a
transaction in
[`Transaction.unfinished`](https://developer.apple.com/documentation/storekit/transaction/unfinished)
until `finish()`, and a finished consumable is in neither that list nor
`currentEntitlements`, so the SDK answers `finished: true` without a native
call and the record ends `finished`. The first finish after the grant never
does: right after a purchase the list may not carry the new transaction yet,
so a missing one stays `{ finished: false }` and the reconciler retries (by
then StoreKit lists it and it is finished natively). A caller that never
sets `retry` (an older reconciler) keeps the earlier behaviour. The
reconciler finishes only records holding a ledger grant, and nothing is
verified again. A durable missing from the list is never answered finished
(a finished durable stays listed with `unfinished: false`, so a missing one
is revoked or unverifiable), nor is an entry of that id in a malformed
shape. The kind of a missing transaction is the caller's `isConsumable`
(the list no longer says, and reading `Transaction.all` would need a native
change); a durable the catalog maps as a consumable never reaches a grant
through this SDK, which excludes kind mismatches (`kind-mismatch`).

Should StoreKit list the consumable again (an entry the native read skipped
as unverifiable), the reconciler finishes it again with the journaled ledger
entry, once per session, without a second verify. If the finished record has
already left the journal (the generated game's journal keeps terminal
records for 30 days), the transaction is verified under its derived key; the
reference backend answers that with this player's recorded grant
(`alreadyProcessed: true`, the same ledger entry, no second grant) because
the App Store entry is a `client`-finish consumable, and the reconciler then
finishes it. Another player's ask under another key stays refused
(`EVIDENCE_ALREADY_PROCESSED`), so nothing is granted twice. Ask to Buy is
unaffected: a deferred purchase has no transaction
until it is approved, so its `launched` record holds no ledger grant and is
never finished; the approved transaction arrives through `transactionUpdated`
and is verified and finished once.

A consumable the App Store refunds while it is still unfinished (the app
closed between the grant and the finish, or before the verify answered, and
the refund came first) stays in `Transaction.unfinished`, which StoreKit
redelivers at every launch until `finish()`, and the ordinary finish refuses
a revoked transaction. The SDK keeps it listed as `revoked` (its launch-time
`transactionUpdated` usually fires before the web listener attaches), and
the reconciler finishes it with `revoked: true` once the backend has
answered for it without a standing grant: the ledger reversed the grant
(App Store Server Notifications `REFUND`, read through
`getPurchaseLedgerStatus`), or the verify was refused as revoked
(`APP_STORE_TRANSACTION_REVOKED` or `LEDGER_GRANT_REVERSED`). A refunded
consumable of the session's own app account token that the journal holds no
record of is finished at once, without a verify. Nothing is granted or
verified again, and `REFUND_REVERSED` never re-grants. A revoked finish
names the reversed grant's ledger entry, or none when nothing was granted;
the native method requires a non-empty `ledgerEntryId`, so the SDK then
sends `revokedLedgerEntryIdPrefix` plus the transaction id, which names no
ledger entry and which the native code never reads. The SDK and the native
plugin (`StoreKitTransactionPolicy.finishableRevoked`, over
`Transaction.unfinished` only) finish only a revoked consumable bound to the
session token; a transaction still paid, a durable, another or no token,
and a malformed entry stay refused. So does one the list does not carry
(`finished: false`, no native call): the list cannot tell a consumable
already finished from one an early read does not carry yet, or from an
entry the native read skipped as unverifiable. The reconciler does not
count that answer as asked, so the next report asks again. Only revoked
consumables of the catalog are listed; a refunded durable is not. OpenIAP's finish takes the transaction by id and
does not check the revocation date. While the grant stands (a backend
without the ledger status read, or a refund not recorded yet) the
transaction stays unfinished, as before, and so does one the backend
refused for another reason. Version mixes keep the earlier behaviour: a
native build from before `revoked` ignores the flag and its ordinary gate
refuses the revoked transaction (`finished: false`, reported as a `finish`
failure and asked again on the next launch), an older adapter neither lists
revoked purchases nor forwards the flag, and an older reconciler never
sends it.

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

## Native engine

The Swift package keeps its 0.3 Capacitor contract (methods,
`transactionUpdated`, payload fields, `STOREKIT_*` codes, the finish gate)
over OpenIAP's `OpenIapModule`; the
[migration record](../../docs/specs/commerce/openiap-migration.md) lists the
contract, the call mapping, and every behavior difference. Two points to know
when integrating:

- `getTransactions` and the `finishTransaction` lookup read StoreKit's
  verified lists directly (a read-only shim), because OpenIAP's queries fail
  as a whole on one unverifiable transaction; an unverified entry is skipped
  on its own, as in 0.3. The lists carry every app account token; the
  TypeScript SDK admits the session account.
- OpenIAP does not deliver revoked transactions, so a small shim forwards
  verified revocations from `Transaction.updates`; it never finishes anything.

The package declares the products `MpgdCapacitorStoreKit` and
`MpgdCapacitorStorekit` (the spelling `cap sync ios` links). SwiftPM clones
the OpenIAP monorepo on first resolution.

The Kit tests use mocked StoreKit responses, Swift XCTests of the native
policy (`MPGD_STOREKIT_BRIDGE_TESTS=1 swift test` on a Mac), and simulator
builds of the workspace and the packed package
(`pnpm smoke:native-packed-store-plugins ios`). None of these checks proves a
signed App Store purchase, sandbox checkout, TestFlight installation, or
device grant. Validate those with a
game-owned account, keys, and device before a production rollout.
