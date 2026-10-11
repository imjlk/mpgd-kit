---
npm/@mpgd/adapter-capacitor: minor
npm/@mpgd/platform: minor
---

Commerce v2, PR B1: the `StoreSdk` provider and registry wiring in
`@mpgd/adapter-capacitor`, and the transitional `commerceV2` gateway field in
`@mpgd/platform`.

`@mpgd/adapter-capacitor` adds `StoreSdk`, the in-process surface a store
plugin exposes (`fetchProducts`, `requestPurchase`, `getAvailablePurchases`,
optional `finishTransaction`, `restorePurchases`, and `getAvailability`,
`addListener`, and a static `capabilities` declaration), with its event,
product, purchase, and error types, `defaultStoreSdkErrorCodeMap`, and
`normalizeStoreSdkError`. `createStoreCommerceProvider({ sdk, products,
evidenceSchema, evidencePayload?, accountBinding?, capabilities?, authority,
mapError? })` returns a `CommerceProvider` from `@mpgd/platform/commerce` that
maps logical ids to store SKUs, fails closed before the store UI opens, builds
purchases with the store token and evidence envelope, buffers events until the
first subscriber, composes fresh capabilities on every read, validates every
SDK answer, and normalizes every SDK failure into a `CommerceError` with the
store code kept; it never grants and never sets `settlement`. The provider
registry accepts a `CapacitorServiceProvider` with a `commerce` field
(`createCommerceServiceProvider` builds one): the six `commerce.v2.*` bridge
methods are served through `createCommerceProviderBridge` with the A2 payload
and result asserts and the `{ protocol: 'mpgd.commerce.v2', sequence, event }`
event envelope, the four v1 `commerce.*` methods through `toCommerceAdapter`,
and a provider may not declare both. `createCapacitorPlatformGateway` exposes
the registered provider as `gateway.commerceV2` (through the validated bridge
path, with `createBridgeCommerceProvider`) and adds the `commerce` capability
block from which `nativeIap` and `subscriptionIap` are derived. The
conformance test runs every store vector against a fake `StoreSdk` directly
and through the gateway bridge path. Without a v2 provider nothing changes.

`@mpgd/platform` adds the optional `PlatformGateway.commerceV2?:
CommerceProvider` field, transitional until C4 removes the v1 adapter.
