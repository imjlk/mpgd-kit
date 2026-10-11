---
npm/@mpgd/capacitor-play-billing: minor
---

Commerce v2, PR B2: the Google Play `StoreSdk` and commerce provider in
`@mpgd/capacitor-play-billing`, with `@mpgd/adapter-capacitor` (`^0.8.0`) as
a new peer dependency.

`createCapacitorPlayBillingStoreSdk({ products, plugin?, isAndroid? })`
implements the adapter's `StoreSdk` over the plugin: store `google-play`,
capabilities consumable and durable (no subscriptions, no multi-quantity),
`pending: true`, `restore: false`, `offers: true`, `finish: 'server'`.
`fetchProducts` maps `getProducts` (selected one-time offer as the price,
every eligible offer as `offers[].offerId`, the Play `offerToken`),
`requestPurchase` maps `purchase` with the obfuscated account id from the
request's `accountBinding` and the offer token from `offerId` (`purchased`
stays `purchased`, `pending` becomes `launched`, `cancelled` becomes
`cancelled`, a plugin rejection becomes `failed` with the plugin code),
`getAvailablePurchases` maps `getPurchases` filtered to unfinished entries
(`purchased` and not acknowledged, plus `pending` on request) with `token =
purchaseToken` and `transactionId = orderId` or the v1
`play-token-sha256:<hex>` key, `addListener` is backed by the plugin's
`purchaseUpdated` listener, and `getAvailability` keeps the v1 logic.
`playBillingStoreSdkErrorCodeMap` extends `defaultStoreSdkErrorCodeMap` with
`PLAY_BILLING_BUSY` (`IN_PROGRESS`), `PLAY_BILLING_OFFER_REQUIRED`,
`PLAY_BILLING_INVALID_PRODUCTS`, `PLAY_BILLING_INVALID_PRODUCT`,
`PLAY_BILLING_INVALID_REQUEST` (`CONFIGURATION_REQUIRED`),
`PLAY_BILLING_ACTIVITY_REQUIRED` (`NOT_PREPARED`),
`PLAY_BILLING_ANDROID_REQUIRED` (`STORE_UNAVAILABLE`), and
`PLAY_BILLING_ERROR` (`UNKNOWN`).

`createCapacitorPlayBillingCommerceProvider({ products, accountBinding,
plugin?, isAndroid?, store?, mapError? })` is `createStoreCommerceProvider`
over that SDK with evidence schema `google-play.product-purchase.v2` and the
payload `{ purchaseToken }` the v1 provider emits (pinned by a test), the
authority block `{ evidence: 'client-token', accountBinding: 'required' }`,
and a lookup failure of `accountBinding` reported as
`ACCOUNT_BINDING_REQUIRED` with `PLAY_BILLING_ACCOUNT_LOOKUP_FAILED` kept.
`createCapacitorPlayBillingServiceProvider` returns the registry entry for
`createCapacitorPlatformGateway({ providers })`, serving `gateway.commerceV2`
and the v1 `commerce.*` methods through `toCommerceAdapter`. The conformance
test runs every store vector the Play profile can serve
(`purchase-server-finish`) directly and through the gateway bridge path and
lists the client-finish, host-finish, adapter-settled, and server-push
vectors as not applicable with their reason.

The plugin surface gains the Billing Library 9.1.0 `Purchase` getters on
every reported purchase: `products`, `purchaseState`, `purchaseTime`,
`quantity`, `isAcknowledged`, and `obfuscatedAccountId`, plus
`priceAmountMicros` on offers. The 0.1 names `productIds`, `state`, and
`purchaseTimeMillis` keep their values and are deprecated until the next
major version. The Android plugin now retains `purchaseUpdated` until a
listener consumes it and still never acknowledges or consumes.
`createCapacitorPlayBillingProvider` is unchanged; `recoverOwnedPlayPurchases`
is deprecated in favour of the commerce v2 reconciler (PR C1).
