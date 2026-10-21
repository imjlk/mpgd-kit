# @mpgd/capacitor-play-billing

Android-only, opt-in Google Play one-time purchase collection for Capacitor 8.
The native module uses Google Play Billing Library 9.1.0. It queries product
details, launches a purchase, listens for purchase updates, and requeries
currently owned, unconsumed purchases. It intentionally does **not** call
BillingClient acknowledge or consume. The game-owned backend must verify the
purchase via Google Play Publisher, commit the mpgd ledger grant, and perform
acknowledge/consume after the grant. A device callback alone never grants a
purchase.

This package is published for opt-in integration, but Kit's mock and compile
checks do not establish live Play purchase behavior. Validate it in a
game-owned Play Console project before relying on it in a published game.

## Commerce provider

Commerce ([RFC](../../docs/specs/commerce/commerce-v2-rfc.md)) is a `StoreSdk`
over this plugin and a `CommerceProvider` built from it with
`createStoreCommerceProvider` from `@mpgd/adapter-capacitor` (a peer
dependency). Register the service provider with the Capacitor gateway and it
serves the six `commerce.v2.*` bridge methods as `gateway.commerce`, reports
its capability block in `getCapabilities().commerce`, and declares no
`features` or `methods` of its own. The `@mpgd/game-services` reconciler
drives it; a scene never calls it.

```ts
import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import { createCapacitorPlayBillingServiceProvider } from '@mpgd/capacitor-play-billing';

export function createPlayGateway(getObfuscatedAccountId: () => Promise<string>) {
  return createCapacitorPlatformGateway({
    target: 'android',
    appVersion: '1.0.0',
    buildId: 'game-build',
    providers: [
      createCapacitorPlayBillingServiceProvider({
        products: [
          { logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' },
          { logicalId: 'remove_ads', storeSku: 'remove.ads', kind: 'durable', offerId: 'intro' },
        ],
        // Must agree with the backend's resolveObfuscatedAccountId.
        accountBinding: async () => ({
          kind: 'obfuscated-account-id',
          value: await getObfuscatedAccountId(),
        }),
      }),
    ],
  });
}
```

`createCapacitorPlayBillingStoreSdk({ products, plugin?, isAndroid? })` is
the `StoreSdk`: store `google-play`; capabilities consumable and durable
(no subscriptions, no multi-quantity), `pending: true`, `restore: false`,
`offers: true`, and `finish: 'server'`. `fetchProducts` is `getProducts`
with the selected one-time offer as the price (`PLAY_BILLING_OFFER_REQUIRED`
when several offers are eligible and none is configured) and every eligible
offer listed as `offers[].offerId` (the Play `offerToken`). `requestPurchase`
is `purchase` with the obfuscated account id from the request's
`accountBinding` (`kind: 'obfuscated-account-id'`; anything else is
`PLAY_BILLING_ACCOUNT_REQUIRED`) and `offerToken` from `offerId`: a
`purchased` outcome is `purchased`, a `pending` outcome is `launched` because
Play resolves it later through `purchaseUpdated` or `getPurchases`, a
`cancelled` outcome is `cancelled`, and a plugin rejection is `failed` with
the plugin code. `getAvailablePurchases` is `getPurchases` filtered to
unfinished entries: `purchased` with `isAcknowledged: false`, plus `pending`
when `includePending` is set; each carries `token = purchaseToken` and
`transactionId = orderId`, or the `play-token-sha256:<hex>` token key until
Play assigns an order id, so the same purchase deduplicates in the ledger. A
purchased entry whose `isAcknowledged` flag is absent counts as unfinished so a
paid purchase is never dropped. A purchase for a SKU that is not in `products`
(a retired product) is still listed and emitted, with that product id as
`sku` and the purchase token intact, so the reconciler can submit it when a
logical id is still known. A multi-line purchase is listed the same way,
with every product id joined by a comma (not a product-id character, so it
cannot match one catalog SKU). The reconciler then fails that purchase's
catalog lookup visibly instead of granting one line of it.
`onUnmappedPurchase` still receives both, as diagnostics only: the backend
finalizer acknowledges or consumes a token only after the client submits it
and the ledger grants, and it has no path that can acknowledge a token
without a logical product id. The plugin's `purchaseUpdated` listener backs
`addListener`: deliveries leave in the order the plugin reported them (a
purchase without an order id waits for the token digest, and later updates
queue behind it), and a `cancelled` or `failed` update without a purchase is
the plugin's late terminal result for a purchase call that already timed out
(`PLAY_BILLING_TIMEOUT`), emitted as a `purchaseError` for that product so
the attempt the timeout left open closes. `getAvailability` reports the Android
check, offer configuration, and service state.
`playBillingStoreSdkErrorCodeMap` extends `defaultStoreSdkErrorCodeMap` with
every other `PLAY_BILLING_*` code (`BUSY` is `IN_PROGRESS`, `OFFER_REQUIRED`
and the invalid-product codes are `CONFIGURATION_REQUIRED`,
`ACTIVITY_REQUIRED` is `NOT_PREPARED`, `ANDROID_REQUIRED` is
`STORE_UNAVAILABLE`); `PLAY_BILLING_TIMEOUT`, `PLAY_BILLING_INTERRUPTED`,
`PLAY_BILLING_EMPTY_PURCHASE`, and `PLAY_BILLING_ALREADY_OWNED` stay
recoverable, so the provider answers `launched` and the reconciler resolves
the attempt from `getAvailablePurchases` without reopening the store UI.

`createCapacitorPlayBillingCommerceProvider({ products, accountBinding,
plugin?, isAndroid?, store?, mapError? })` composes the provider: evidence
schema `google-play.product-purchase.v2` with payload `{ purchaseToken }`,
which `createGooglePlayProductPurchaseBoundary` verifies; authority
`{ evidence: 'client-token', accountBinding: 'required' }`; no
`finishTransaction` and no `restorePurchases`. A thrown `accountBinding`
lookup is `ACCOUNT_BINDING_REQUIRED` with `PLAY_BILLING_ACCOUNT_LOOKUP_FAILED`
kept as the store code. `store` defaults to `google-play`; only a conformance
harness overrides it, because the derived idempotency key follows the store
id. `createPlayBillingCommerceCapabilities(availability)` (from
`src/commerce-profile.ts`, which imports types only and no Capacitor code)
returns the full `CommerceCapabilities` block this provider declares while the
store reports `availability`, so a validator or server can read the profile
without loading the plugin; a unit test keeps it equal to
`provider.getCapabilities()`. The conformance test runs every store vector whose profile the Play
capabilities can serve (`purchase-server-finish`) against a fake plugin,
directly and through the gateway bridge path, and lists the skipped vectors
with their reason: the client-finish, host-finish, adapter-settled, and
server-push profiles need a finish owner or evidence authority Play does not
have.

Every purchase the plugin reports (`getPurchases()`, `purchase()`, and
`purchaseUpdated`) carries the Billing Library 9.1.0 `Purchase` getters
`products`, `purchaseState`, `purchaseTime`, `quantity`, `isAcknowledged`,
and `obfuscatedAccountId`, with `priceAmountMicros` on offers. The 0.1 names
`productIds`, `state`, and `purchaseTimeMillis` were removed from the payload
and the type. The TypeScript readers still accept them, so a web bundle that
reaches a 0.1 native build first (a live update) keeps paid purchases
readable; run `cap sync` after upgrading all the same. `purchaseUpdated` is retained
until a listener consumes it, so a purchase that completes after the
`purchase` call timed out, or before the web view attached its listener,
still reaches the provider, and a cancel or non-OK result that arrives after
the 180-second `purchase` timeout is delivered as `{ status: 'cancelled' |
'failed', productId, code? }` for the timed-out product instead of being
discarded. The plugin still never acknowledges or consumes;
`isAcknowledged: false` on a purchased entry marks it unfinished for the
backend finalizer.

### Generated games

Games generated by `mpgd game create` (and the kit's private starter) ship
this wiring in `src/platform/buildGateways/capacitorAndroid.ts` (commerce v2
PR C3): the service provider is registered for every catalog product whose
`platformProductIds.android` names a Play SKU (subscriptions are skipped),
and `accountBinding` is the reference binding in
`src/platform/commerceAccountBinding.ts`, the 64-character hex SHA-256 of
`mpgd-commerce-account:<playerId>` for the authenticated player (a guest
session binds nothing, so the purchase is refused with
`ACCOUNT_BINDING_REQUIRED`). The backend's `resolveObfuscatedAccountId`
must derive the same value, or both are replaced together.

`mpgd target init capacitor --providers play-billing` installs this package
into the game-owned shell and the game at one exact version and lets
`cap add` or `cap sync` register its native module; on a game that still has
the unwired gateway of an earlier template it also writes the wiring above.
A build whose shell lacks the native module still runs: the plugin answers
Capacitor's `UNIMPLEMENTED`, which the SDK reports as
`configuration-required`, so no purchase UI opens.

### Migrating from v1

Commerce v2 PR C4 removed the v1 provider and its recovery driver.

| Removed | Replacement |
| --- | --- |
| `createCapacitorPlayBillingProvider`, `PlayBillingProviderOptions`, `CapacitorPlayBillingProvider`, `PlayBillingProductMapping`, `PlayBillingAvailability` | `createCapacitorPlayBillingServiceProvider` (registry entry) or `createCapacitorPlayBillingCommerceProvider`; rename `id`/`storeId`/`type` to `logicalId`/`storeSku`/`kind` (`non_consumable` becomes `durable`) and `offerToken` to `offerId`; `getObfuscatedAccountId` becomes an `accountBinding` resolver returning `{ kind: 'obfuscated-account-id', value }` |
| `recoverOwnedPlayPurchases`, `getOwnedPurchases`, `OwnedPlayPurchase`, `RecoveredPlayPurchase`, `PlayPurchaseVerification`, `PlayPurchaseRecoveryBackend` | the reconciler in `@mpgd/game-services` (`createCommerceReconciler`, behind `createGameServicesClient` and `monetizationRecovery.reconcile()`), which reads `getAvailablePurchases` and `purchaseUpdated` from the provider and verifies each purchase under the same `play-token-sha256` key; the backend contract is unchanged because the evidence payload is the same |
| `createGooglePlayTokenTransactionId` | `createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce` (the same function) |
| `gateway.commerceV2`, the v1 `commerce.*` bridge methods | `gateway.commerce` and the `commerce.v2.*` methods |
| `features: ['nativeIap']` on the registry entry | none: the entry declares no `features` and its readiness is `getCapabilities().commerce` |
| `PlayPurchase.productIds`, `.state`, `.purchaseTimeMillis` (plugin payload and TypeScript type) | `products`, `purchaseState`, `purchaseTime` |

`src/commerce-reconciler-play-smoke.test.ts` shows the reconciler resubmitting
owned purchases over the fake plugin: a purchased token is verified once, a
pending purchase is never sent, a rejection is terminal, and an outage stays
retryable.

## Native compile check

The Kit reference app includes an opt-in Gradle compile target, without
bundling Billing into the base app:

```sh
cd apps/mobile-capacitor/android
./gradlew -PmpgdPlayBillingPluginTest=true \
  :mpgd-capacitor-play-billing:compileDebugJavaWithJavac
```

This compile and the TypeScript fixture do not prove a live Play purchase,
license-test configuration, or device behavior. Validate those in a game-owned
Play Console project before enabling commerce for players.
