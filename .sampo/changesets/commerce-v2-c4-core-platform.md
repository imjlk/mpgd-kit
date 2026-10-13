---
npm/@mpgd/platform: minor
---

BREAKING: commerce v2, PR C4 removes the commerce v1 surfaces from the platform
contract. `CommerceProvider` (`@mpgd/platform/commerce`) is the only commerce
surface of a gateway, and the `commerce` capability block is the only commerce
capability source.

- `CommerceAdapter` is removed. `PlatformGateway.commerceV2` is renamed to
  `PlatformGateway.commerce` and is now `CommerceProvider | undefined`: a
  gateway whose target sells nothing omits it. The v1 methods map to the
  provider as `getProducts` to `fetchProducts`, `purchase` to `requestPurchase`
  (a `RequestPurchaseResult`, never a grant), `restore` to `restorePurchases`
  and `getAvailablePurchases`. `getEntitlements` has no replacement on the
  gateway: ownership comes from the backend ledger (server-side
  `listActiveEntitlementTransactions` in `@mpgd/game-services`), and
  `@mpgd/game-services` drives the provider, so a scene never calls it.
- `PlatformCapabilities.nativeIap` and `.subscriptionIap` are removed, and
  `PlatformCapabilities.commerce: CommerceCapabilities` is now required. Read
  `commerce.availability` and `commerce.purchase` instead (`nativeIap` was
  `availability === 'available'` with a consumable or durable kind;
  `subscriptionIap` was `purchase.subscription`).
  `PlatformProviderFeature` no longer contains `'nativeIap'` or
  `'subscriptionIap'`, so `providerAvailability.nativeIap` and
  `.subscriptionIap` are gone too: the block's own `availability` carries
  commerce readiness. `deriveLegacyCommerceCapabilities` and
  `LegacyCommerceCapabilities` are removed.
- `createUnsupportedCapabilities()` now includes
  `commerce: createUnsupportedCommerceCapabilities()`, which is exported from
  both `@mpgd/platform` and `@mpgd/platform/commerce` and returns a fresh object
  on every call. A gateway that sells nothing reports it instead of omitting the
  block.
- `toCommerceAdapter`, `ToCommerceAdapterOptions` (`@mpgd/platform/commerce`)
  and `findAuthoritativePurchaseSettlement` are removed. The result vocabulary
  adapters and `GameServicesPurchaseResult` still use is kept: `PurchaseResult`,
  `PurchaseRestoreResult`, `PurchaseSettlement`, `ProductInfo`, `ProductType`,
  `Entitlement`, `CommerceDiagnostic`, and `PlatformPurchasePresentationEvent`.
  A platform purchase result is never an input to a grant.
- `CommerceProvider` gains an optional `presentation.subscribe(listener)` of
  trusted native facts about the payment surface (opened, closed, never
  started), for providers whose host can prove closure; the game runtime's
  presentation gate uses it. Providers that cannot prove closure omit it.
- `@mpgd/platform/capability-conformance` requires the `commerce` block and
  rejects `nativeIap` and `subscriptionIap` as unknown keys.
  `optionalPlatformCapabilityKeys` is now `['bannerAds']`, and
  `platformCapabilityKeys` no longer lists `nativeIap`.
- `createGooglePlayTokenPurchaseKey` is the only Play token key helper.
