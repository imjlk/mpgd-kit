# @mpgd/capacitor-play-billing

## 0.2.0 — 2026-10-12

### Minor changes

- [a133b175](https://github.com/imjlk/mpgd-kit/commit/a133b175421c4b2f9ccf1a84c7a99912ed181c4d) Commerce v2, PR B2: the Google Play `StoreSdk` and commerce provider in
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
  `play-token-sha256:<hex>` key (an absent `isAcknowledged` from a 0.1 native
  build counts as unfinished; a retired or multi-line SKU is left out and handed
  to the optional `onUnmappedPurchase` hook), `addListener` is backed by the
  plugin's `purchaseUpdated` listener with deliveries kept in plugin order and
  a late `cancelled` or `failed` result for a timed-out product emitted as a
  `purchaseError`, and `getAvailability` keeps the v1 logic.
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
  listener consumes it, delivers a cancel or non-OK result that arrives after
  the `purchase` timeout as a `cancelled` or `failed` update for the timed-out
  product, and still never acknowledges or consumes.
  `createCapacitorPlayBillingProvider` is unchanged; `recoverOwnedPlayPurchases`
  is deprecated in favour of the commerce v2 reconciler (PR C1). — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-capacitor@0.9.0, bridge@0.12.1, game-services@0.21.0, platform@0.20.0

## 0.1.8 — 2026-10-11

### Patch changes

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
- Updated dependencies: bridge@0.12.0, game-services@0.20.0, platform@0.19.0

## 0.1.7 — 2026-10-11

### Patch changes

- Updated dependencies: game-services@0.19.1, platform@0.18.0

## 0.1.6 — 2026-10-09

### Patch changes

- Updated dependencies: game-services@0.19.0, platform@0.17.0

## 0.1.5 — 2026-10-09

### Patch changes

- Updated dependencies: game-services@0.18.1, platform@0.16.0

## 0.1.4 — 2026-10-09

### Patch changes

- Updated dependencies: bridge@0.11.0, game-services@0.18.0, platform@0.15.0

## 0.1.3 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.2

## 0.1.2 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.1

## 0.1.1 — 2026-09-28

### Patch changes

- [ad66eaf0](https://github.com/imjlk/mpgd-kit/commit/ad66eaf0659b3fce6cacbcec609409479aea0985) Enable automated releases for the separately registered Play Billing and StoreKit Capacitor plugins. — Thanks @imjlk!
- Updated dependencies: game-services@0.17.0, platform@0.14.0

