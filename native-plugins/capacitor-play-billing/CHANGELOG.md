# @mpgd/capacitor-play-billing

## 0.4.1 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.15.0, @mpgd/bridge@0.16.3, @mpgd/game-services@0.30.1, @mpgd/platform@0.31.0

## 0.4.0 — 2026-10-26

### Fixed

- [718801f9](https://github.com/imjlk/mpgd-kit/commit/718801f9b9544fc9be505dc5994cb81974bdea48) A restore read (`getAvailablePurchases({ restore: true })`, the reconciler's Restore Purchases) lists every owned `purchased` entry of exactly one configured durable from `getPurchases`, acknowledged or not. The backend acknowledges a non-consumable at its first grant, so after a reinstall or on a new device it was never listed again and the new guest's Restore Purchases sent nothing. Acknowledged consumables, unmapped SKUs, and multi-line purchases stay filtered; recovery reads are unchanged. — Thanks @imjlk!

### Changed

- [706ea874](https://github.com/imjlk/mpgd-kit/commit/706ea87435232974aac23c0f1b630f49f957580f) The Android plugin is now Kotlin on the OpenIAP Google core (`io.github.hyochan.openiap:openiap-google` 4.0.6, Play flavor, pinned exactly) instead of its own Java BillingClient code. The Capacitor contract is unchanged: `CapacitorPlayBilling`, `getProducts`/`purchase`/`getPurchases`, the retained `purchaseUpdated` event, the payload fields (the order id stays absent until Play assigns one, so the `play-token-sha256:<hex>` key keeps working), the `PLAY_BILLING_*` codes, and server-only finalization: nothing in the plugin acknowledges, consumes, or calls OpenIAP's `finishTransaction`. The plugin refuses to run unless OpenIAP's provider is `play`. **Shell requirements:** the module applies the Kotlin Gradle plugin (2.2.20 unless the root project sets `kotlin_version`; OpenIAP needs 2.1.20+), compiles to JVM 21, takes Billing 9.1.0 from OpenIAP, and the merged manifest gains OpenIAP's provider entry and `INTERNET`. **Behavior to know:** an `ITEM_ALREADY_OWNED` purchase still rejects `PLAY_BILLING_ALREADY_OWNED`, and the owned purchase now also arrives as `purchaseUpdated`; after the 180 s `PLAY_BILLING_TIMEOUT`, another purchase answers `PLAY_BILLING_BUSY` until OpenIAP releases its flow (up to 15 minutes), whose cancel or failure is then sent as the late terminal event. The npm package ships `android/src/main` only. Rollback is pinning the previous plugin version and re-running `cap sync android`; journals and evidence are unchanged. Details: `docs/specs/commerce/openiap-migration.md`. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.14.0, @mpgd/bridge@0.16.2, @mpgd/game-services@0.30.0, @mpgd/platform@0.30.0

## 0.3.10 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.13.0, @mpgd/bridge@0.16.1, @mpgd/game-services@0.29.0, @mpgd/platform@0.29.0

## 0.3.9 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.12.5, @mpgd/bridge@0.16.0, @mpgd/game-services@0.28.1, @mpgd/platform@0.28.0

## 0.3.8 — 2026-10-24

### Patch changes

- Updated dependencies: adapter-capacitor@0.12.4, game-services@0.28.0

## 0.3.7 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.12.3, @mpgd/bridge@0.15.0, @mpgd/game-services@0.27.2, @mpgd/platform@0.27.2

## 0.3.6 — 2026-10-21

### Patch changes

- [bdb34e19](https://github.com/imjlk/mpgd-kit/commit/bdb34e199439f523784bc80bf48de5b822800fc1) Unfinished Google Play purchases whose SKU is no longer in the client catalog, and purchases that name more than one product id, are listed and emitted with their token and product ids. The reconciler can submit a retired SKU when a logical id is still known. Otherwise it fails that purchase's catalog lookup visibly instead of dropping the token. The client still does not acknowledge or consume; the server finalizer does that only after a ledger grant, and it has no path that can acknowledge a token without a logical product id. — Thanks @imjlk!
- Updated dependencies: @mpgd/adapter-capacitor@0.12.2, @mpgd/bridge@0.14.3, @mpgd/game-services@0.27.1, @mpgd/platform@0.27.1

## 0.3.5 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.12.1, @mpgd/bridge@0.14.2, @mpgd/game-services@0.27.0, @mpgd/platform@0.27.0

## 0.3.4 — 2026-10-20

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.12.0, @mpgd/bridge@0.14.1, @mpgd/game-services@0.26.0, @mpgd/platform@0.26.0

## 0.3.3 — 2026-10-19

### Patch changes

- Updated dependencies: adapter-capacitor@0.11.1, bridge@0.14.0, game-services@0.25.1, platform@0.25.0

## 0.3.2 — 2026-10-19

### Patch changes

- Updated dependencies: adapter-capacitor@0.11.0, bridge@0.13.2, game-services@0.25.0, platform@0.24.0

## 0.3.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-capacitor@0.10.1, bridge@0.13.1, game-services@0.24.1, platform@0.23.1

## 0.3.0 — 2026-10-15

### Minor changes

- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: Commerce v2, PR C4: the v1 provider and recovery driver are removed.
  
  - Removed `createCapacitorPlayBillingProvider` and its types
    (`PlayBillingProviderOptions`, `PlayBillingProductMapping`,
    `CapacitorPlayBillingProvider`, `PlayBillingAvailability`), and
    `recoverOwnedPlayPurchases` with `OwnedPlayPurchase`, `RecoveredPlayPurchase`,
    `PlayPurchaseVerification`, and `PlayPurchaseRecoveryBackend`. Register
    `createCapacitorPlayBillingServiceProvider` (or use
    `createCapacitorPlayBillingCommerceProvider`) and let the
    `@mpgd/game-services` reconciler recover purchases.
  - Removed the `createGooglePlayTokenTransactionId` alias; use
    `createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce`.
  - `createCapacitorPlayBillingServiceProvider` declares no `features` (it was
    `['nativeIap']`); readiness is the gateway's `commerce` capability block, and
    the gateway exposes the provider as `gateway.commerce`.
  - Removed the deprecated `PlayPurchase` fields `productIds`, `state`, and
    `purchaseTimeMillis` from the TypeScript type and the Android plugin's
    payload; use `products`, `purchaseState`, and `purchaseTime`. The TypeScript
    readers still accept the 0.1 names, so a web bundle that reaches a 0.1
    native build first (a live update) keeps every paid purchase recoverable.
  - Added `createPlayBillingCommerceCapabilities(availability)`, a pure
    SDK-free function (`src/commerce-profile.ts` imports types only) that returns
    the `CommerceCapabilities` block the provider declares for an availability.
    The profile constants `googlePlayStoreId`, `playBillingStoreSdkCapabilities`,
    `playBillingCommerceAuthority`, and `googlePlayProductPurchaseEvidenceSchema`
    moved into it and stay exported from the package. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-capacitor@0.10.0, bridge@0.13.0, game-services@0.24.0, platform@0.23.0

## 0.2.3 — 2026-10-12

### Patch changes

- [5871a314](https://github.com/imjlk/mpgd-kit/commit/5871a31405de4caddd7fbb5d252b452310dd44df) Commerce v2, PR C3: a shell without the native plugin is a configuration
  problem, not an outage. Capacitor's `UNIMPLEMENTED` answer (the plugin's
  native code is not in the shell) now makes `getAvailability()` report
  `configuration-required` instead of `temporarily-unavailable`, so a generated
  game that registers the store provider before `mpgd target init capacitor
  --providers` installed the plugin runs and opens no purchase UI. — Thanks @imjlk!
- Updated dependencies: adapter-capacitor@0.9.3, game-services@0.23.0

## 0.2.2 — 2026-10-12

### Patch changes

- Updated dependencies: adapter-capacitor@0.9.2, bridge@0.12.3, game-services@0.22.0, platform@0.22.0

## 0.2.1 — 2026-10-12

### Patch changes

- Updated dependencies: adapter-capacitor@0.9.1, bridge@0.12.2, game-services@0.21.1, platform@0.21.0

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

