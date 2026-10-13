---
npm/@mpgd/adapter-capacitor: minor
---

BREAKING: Commerce v2, PR C4: the v1 commerce surface is removed from the
Capacitor adapter.

- Removed the v1 gateway `commerce` object (`getProducts`, `purchase`,
  `restore`, `getEntitlements`) and the four `commerce.getProducts`,
  `commerce.purchase`, `commerce.restore`, `commerce.getEntitlements` bridge
  methods, including their provider-registry routing, response validation, and
  external-activity hold. `createCommerceProviderBridge` no longer serves them
  through `toCommerceAdapter`: a v1 method answers `UNSUPPORTED_METHOD` (or goes
  to the `fallback` bridge). The `productType` parameter of
  `assertMethodReady` and the `NATIVE_PROVIDER_PRODUCT_UNKNOWN` and
  `NATIVE_PROVIDER_PRODUCT_TYPE_REQUIRED` errors are gone with the
  product-type routing.
- `gateway.commerceV2` is renamed `gateway.commerce` and is the bridge commerce
  provider (`CommerceProvider`); the property is omitted when no commerce
  provider is registered.
- `getCapabilities()` no longer reports `nativeIap` or `subscriptionIap`, and
  strips either key when a native shell still sends it. `commerce` is always
  present and fresh on every read: the registered provider's validated block,
  the degraded block (`temporarily-unavailable`) when its bounded read stalls or
  is invalid, or `createUnsupportedCommerceCapabilities()` without a provider
  (a missing or invalid native `commerce` answer is replaced).
- `CapacitorServiceProvider.features` lists non-commerce features only
  (`PlatformProviderFeature` no longer contains `nativeIap` or
  `subscriptionIap`). A provider with `commerce` serves the six
  `commerce.v2.*` methods, may declare empty `features` and `methods`, and must
  still have a `subscribe` bridge. `createCommerceServiceProvider({ id,
  commerce })` drops its `features` input. `CapacitorProviderCapabilitySnapshot.commerce`
  is no longer optional.
- Removed `CapacitorCommerceFeature` and `deriveCommerceFeatureStates`.
  `createDegradedCommerceCapabilities` stays.
- Removed the deprecated `@mpgd/adapter-capacitor/app-store-server` subpath; use
  `createAppleSignedTransactionVerifier` from
  `@mpgd/game-services/app-store-server`.
