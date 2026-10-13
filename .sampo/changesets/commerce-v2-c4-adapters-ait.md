---
npm/@mpgd/adapter-ait: minor
---

BREAKING: commerce v2, PR C4 removes the commerce v1 surfaces from the Apps in
Toss adapter. The `commerce.v2.*` provider is the only commerce path.

- `createAitPlatformGateway()` no longer builds the v1 `gateway.commerce`
  adapter (`getProducts`, `purchase`, `restore`, `getEntitlements`). The
  provider the gateway builds over the host bridge's commerce event channel is
  now `gateway.commerce` (it was `gateway.commerceV2`); the gateway has no
  `commerce` when the installed bridge exposes no channel. The
  `GamePlatformBridge.commerceV2` event-channel field keeps its name: it is the
  protocol's channel, not the gateway property.
- `gateway.getCapabilities()` returns the host answer without the removed
  `nativeIap` and `subscriptionIap` flags and with a `commerce` block that is
  always valid: the host's block when the gateway has a commerce provider and
  the block is well formed, otherwise `createUnsupportedCommerceCapabilities()`
  (a fresh object on every read).
- `createAitHostBridge()` / `installAitHostBridge()` no longer serve the
  `commerce.getProducts`, `commerce.purchase`, `commerce.restore` and
  `commerce.getEntitlements` methods (the bridge protocol dropped them, so a
  request for one is rejected), and `runtime.getCapabilities` no longer sends
  `nativeIap` or `subscriptionIap`; the `commerce` block is the only source.
  Replacement for each: `commerce.v2.fetchProducts`, `commerce.v2.requestPurchase`,
  `commerce.v2.restorePurchases` and `commerce.v2.getAvailablePurchases`
  (through `gateway.commerce`, which `@mpgd/game-services` drives).
- The `readIapEntitlements` option, the `AitIapEntitlementReader` type, and the
  `AIT_IAP_ENTITLEMENT_READ_FAILED` diagnostic code
  (`aitIapDiagnosticCodes.entitlementReadFailed`, and its
  `aitIapCommerceErrorCodeMap` entry) are removed. Selling no longer requires
  an entitlement reader: with `iapProducts`, `prepareIap`, `verifyIapProductGrant`
  and the four native IAP methods the commerce block reports `available`.
  Ownership that survives a wrapper restart comes from the backend ledger
  (server-side `listActiveEntitlementTransactions` in `@mpgd/game-services`).
- `createAitSandboxBridge()` drops the v1 `commerce.*` cases (its v1 purchase
  completed itself with entitlement ids) and the `nativeIap` flag. Its
  `runtime.getCapabilities` answers `createAitCommerceCapabilities('available')`
  only for the `ait-sandbox` build and the unsupported block otherwise.
- `AitIapControllerOptions`, the base of `CreateAitCommerceProviderInput` for
  `createAitCommerceProvider()`, loses `readIapEntitlements`. The provider's
  behavior (purchase, available purchases, `finishTransaction`,
  `restorePurchases`) is unchanged.

Gateway commerce capabilities follow the same pinned host bridge as purchase commands and events after a global bridge replacement.
