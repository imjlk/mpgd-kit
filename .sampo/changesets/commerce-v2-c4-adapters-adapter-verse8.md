---
npm/@mpgd/adapter-verse8: minor
---

BREAKING: commerce v2, PR C4 removes the commerce v1 surfaces from the Verse8
adapter. The commerce v2 provider (`createVerse8CommerceProvider`) is the only
commerce path.

- `createVerse8PlatformGateway()` no longer builds the v1 `gateway.commerce`
  adapter (`getProducts`, `purchase`, `restore`, `getEntitlements`, a failing
  stub when `vxShop` was absent). The provider that
  `createVerse8PlatformGateway({ vxShop: { purchases } })` builds is now
  `gateway.commerce` (it was `gateway.commerceV2`); without `vxShop`, the
  `agent8-server` acknowledgement, a product, or a purchase source the gateway
  sells nothing, has no `commerce`, and reports
  `createUnsupportedCommerceCapabilities()`.
- `Verse8CommerceOptions.loadEntitlements` is removed (only the v1 adapter read
  it), and `Verse8CommerceOptions.purchases` is now required, so a `vxShop`
  configured for v1 only fails to compile instead of silently selling nothing.
  The Agent8 service keeps its own server-side reads (`getEntitlements`,
  `getSnapshot`, `listPurchases`); the backend ledger the service writes (the
  `ledger` option) is the commerce record.
- `gateway.getCapabilities()` no longer reports `nativeIap` or `subscriptionIap`;
  `commerce` is always present: the provider's block when `vxShop.purchases` is
  configured, otherwise the unsupported block (a fresh object on every read).
