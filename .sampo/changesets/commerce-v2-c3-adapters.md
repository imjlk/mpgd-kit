---
npm/@mpgd/adapter-ait: minor
npm/@mpgd/adapter-devvit: minor
---

Commerce v2, PR C3: catalog-derived host products for Apps in Toss and Devvit.

- `@mpgd/adapter-ait/iap-config` exports `extractAitIapProductConfig(catalog,
  { target?, sourceLabel? })`: one `AitIapProductConfig` `{ productId, sku }`
  per one-time product whose `platformProductIds.ait` (or `target`) names the
  console SKU, for `installAitHostBridge({ iapProducts })`. Subscriptions are
  skipped; an invalid catalog, a duplicate product id, and a blank, padded,
  or duplicate SKU throw. It imports no SDK, so a wrapper's build config can
  call it.
- `@mpgd/adapter-devvit` exports `createDevvitCommerceBridgeProducts(catalog,
  target = 'reddit')` (`{ productId, sku }` for
  `createDevvitCommerceV2BridgeHandler`, also from
  `@mpgd/adapter-devvit/server`) and `createDevvitCommerceProducts(catalog,
  { target?, describe? })` (the `DevvitCommerceProduct` list for
  `createDevvitPlatformGateway({ commerce })`), both read from
  `platformProductIds.reddit` so the webview and the server agree on every
  SKU; subscriptions are skipped and blank, padded, or duplicate SKUs throw.
- `@mpgd/adapter-devvit/web` exports `createDevvitWebPaymentsClient()`, the
  checkout client over `purchase()` from `@devvit/web/client` (one SKU, no
  client metadata), and `toDevvitCheckoutResult(event)`: `STATUS_SUCCESS`
  with an order id is `completed`, without one `pending`, `STATUS_CANCELLED`
  is `cancelled` (`USER_CANCELLED`), `STATUS_ERROR` is `failed` with the
  platform `errorCode` as `storeCode`, and an unknown status is `pending`, so
  nothing is granted or dropped on the client.
