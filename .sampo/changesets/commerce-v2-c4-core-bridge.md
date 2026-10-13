---
npm/@mpgd/bridge: minor
---

BREAKING: commerce v2, PR C4 removes the commerce v1 bridge methods. The six
`commerce.v2.*` methods (`bridgeCommerceV2Methods`) are the whole commerce
bridge.

- `BridgeMethod` no longer contains `commerce.getProducts`,
  `commerce.purchase`, `commerce.restore`, or `commerce.getEntitlements`:
  `assertBridgeRequest` rejects them, `isBridgeCommerceV2Method` is `false` for
  them, and a transport that dispatches on the method answers
  `UNSUPPORTED_METHOD`. Use `commerce.v2.fetchProducts`,
  `commerce.v2.requestPurchase`, `commerce.v2.restorePurchases`, and
  `commerce.v2.getAvailablePurchases`; entitlements come from the backend
  ledger, not from a bridge method.
- The Cloudflare Pages host bridge (`@mpgd/bridge/cloudflare-pages`) stops
  answering the four v1 methods. Its `runtime.getCapabilities` no longer sends
  `nativeIap` and now carries `commerce: createUnsupportedCommerceCapabilities()`,
  since the Pages host sells nothing; its `commerce.v2.*` answers stay the
  non-retryable `COMMERCE_V2_UNAVAILABLE` error.
- The `commerce.v2.*` wire names, the `mpgd.commerce.v2` protocol constant,
  `BridgeCommerceV2Method`, `isBridgeCommerceV2Method`,
  `createCommerceV2UnavailableBridgeError`, and the
  `COMMERCE_V2_UNAVAILABLE` code are unchanged: they name the protocol version,
  not the removed gateway property.
