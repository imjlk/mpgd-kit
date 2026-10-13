---
npm/@mpgd/adapter-devvit: minor
---

BREAKING: commerce v2, PR C4 removes the commerce v1 surfaces from the Devvit
adapter. The commerce v2 provider (`createDevvitCommerceProvider`) is the only
commerce path.

- `createDevvitCommerceAdapter`, `withDevvitCommerceAdapter`, and
  `CreateDevvitCommerceAdapterInput` are removed from
  `@mpgd/adapter-devvit` and `@mpgd/adapter-devvit/payments`. Use
  `createDevvitPlatformGateway({ commerce: { products, client } })`, which
  installs the provider, or `createDevvitCommerceProvider` directly.
- `createDevvitPlatformGateway()` no longer builds the v1 `gateway.commerce`
  adapter (`getProducts`, `purchase`, `restore`, `getEntitlements`). The
  provider the `commerce` option builds is now `gateway.commerce` (it was
  `gateway.commerceV2`); without the option the gateway sells nothing, has no
  `commerce`, and reports `createUnsupportedCommerceCapabilities()`. The option
  keeps its name `commerce`.
- `gateway.getCapabilities()` returns the server snapshot without the removed
  `nativeIap` and `subscriptionIap` flags (dropped if an older server still
  sends them) and with a `commerce` block that is always valid: the provider's
  when the gateway has one, otherwise the unsupported block (a fresh object on
  every read).
- `DevvitPaymentsClient` loses `getEntitlements()`; it is now only
  `purchase(sku)`, and `DevvitWebPaymentsClient` is that same type. Nothing in
  the provider read entitlements: `getAvailablePurchases` is the paid-order
  list from the server bridge. Owned entitlements come from the backend ledger
  (server-side `listActiveEntitlementTransactions` in `@mpgd/game-services`).
- `createDevvitSandboxBridge()` drops the v1 `commerce.*` cases and the
  `nativeIap` flag; its `runtime.getCapabilities` carries the unsupported
  `commerce` block. A request for a removed `commerce.getProducts`,
  `commerce.purchase`, `commerce.restore`, or `commerce.getEntitlements` method
  answers `UNSUPPORTED_METHOD` (the bridge protocol dropped them); the six
  `commerce.v2.*` methods keep answering `COMMERCE_V2_UNAVAILABLE`.
- The `@mpgd/adapter-devvit/payments` entry keeps `normalizeDevvitCommerceProducts`
  and the checkout types (`DevvitCheckoutResult`, `DevvitCheckoutFailure`,
  `DevvitCommerceProduct`).

Retired commerce flags are also removed from nested `providerAvailability`
records returned by older Devvit bridges while current feature entries remain.
