---
npm/@mpgd/adapter-devvit: minor
---

Commerce v2, PR B6: the Devvit provider on the server-push lookup.

Not yet usable in production before C2: the backend lookup verifier for
`devvit.order.v1` is C2 work, so today a verify request for a Devvit purchase
is refused by `@mpgd/game-services` (no verifier for the schema, `reddit` not
a store target) instead of answering `pending`, and no journal record can
reach `granted`. The gateway `commerce` option is opt-in; without it nothing
changes.

`@mpgd/adapter-devvit` adds `createDevvitCommerceProvider({ products, client,
orders, store?, onOrdersChanged?, onCheckoutError? })`, a `CommerceProvider`
with `store: 'devvit'` and the RFC profile (consumable and durable one-time
products, no subscription, no quantity, `lifecycle.finish: 'none'`,
`authority.evidence: 'server-push'`, `accountBinding: 'host'`, available
purchases, pending, restore, events). It runs over the v1
`DevvitPaymentsClient` checkout and never grants: Reddit's fulfillment handler
writes the ledger on the server, and the backend's lookup verifier answers
`pending` until that entry exists.

- `requestPurchase` opens the Reddit checkout. A `completed` result carrying
  the order id answers `purchased` with the order id as `transactionId` and
  `token`, `devvit.order.v1` evidence `{ orderId, sku, source: 'checkout' }`
  and a `host-identity` binding; a result without an order id, or `pending`,
  is `launched`, and so is a `purchase()` call that rejects (a missing
  response does not prove a missing order); `cancelled` is `USER_CANCELLED`;
  `failed` keeps the platform code as `storeCode` (`DevvitCheckoutResult.error`,
  new and optional), with `OUTCOME_UNKNOWN` and `ALREADY_OWNED` classes kept
  open as `launched`.
- `getAvailablePurchases` lists the paid orders whose delivery Reddit has not
  acknowledged, read from the `orders` source (`DevvitOrderSource`, whose
  entries carry a `delivered` flag), bounded by `maximumDevvitAvailableOrders`;
  `restorePurchases` and the first listener re-read it and emit
  `purchaseUpdated` once per order not reported before, delivered orders
  included (so a checkout result lost to a restart still reaches the
  reconciler), as the `onOrdersChanged` signal does (orders it carries are
  reported first). An unconfigured catalog, or one without a consumable or
  durable product, is `configuration-required`.
- `createDevvitCommerceCapabilities`, `createDevvitStorePurchase`,
  `createDevvitOrderEvidence`, and `assertDevvitOrderEvidence` (the server-side
  validation of `devvit.order.v1`) are exported for registries and tests;
  `normalizeDevvitCommerceProducts` is exported from `./payments`.

`@mpgd/adapter-devvit/server` adds `createDevvitCommerceV2BridgeHandler({
payments, products, store?, warn? })`, which serves the six `commerce.v2.*`
bridge methods over the Devvit `payments` plugin (`PaymentsClient` of
`@devvit/payments/server` fits `DevvitServerPaymentsLike`): `PAID` and
`DELIVERED` orders of configured SKUs as purchases (evidence `status` says
which; pages of 64 newest first, stopping after two pages without one or at
eight pages), configured
products from `getProducts` priced in Reddit Gold, the profile capabilities,
`restorePurchases` as `{ restored: false }`, `requestPurchase` refused with
`DEVVIT_COMMERCE_CHECKOUT_CLIENT_ONLY` (the checkout is a webview effect), and
`finishTransaction` refused with `COMMERCE_V2_METHOD_UNSUPPORTED`. Payloads and
results are validated with the `@mpgd/platform/commerce` asserts; a plugin
failure is the retryable `DEVVIT_PAYMENTS_UNAVAILABLE`.

`createDevvitPlatformGateway` takes an optional `commerce` option
(`DevvitGatewayCommerceOptions`) that installs the provider as `commerceV2`
over the gateway's bridge (`createDevvitBridgeOrderSource`:
`commerce.v2.getAvailablePurchases` and `commerce.v2.getCapabilities`; a
`COMMERCE_V2_UNAVAILABLE` answer is `configuration-required` and a
`CONFIGURATION_REQUIRED` list error, a transport failure a retryable
`NETWORK` error) and adds the
`commerce` capability block with `nativeIap` and `subscriptionIap` derived from
it. Without the option the gateway is unchanged. The sandbox bridge keeps
answering commerce v2 with `COMMERCE_V2_UNAVAILABLE`.

Conformance: `adapters/devvit/src/devvit-commerce-provider.conformance.test.ts`
runs the RFC vectors through `runCommerceConformanceVectors` with a fake
Reddit, directly and through the server bridge handler and gateway path;
`server-push-settlement` passes with its fixture expectations, and
`event-before-listener`, `purchase-client-finish`, `restart-before-verify`, and
`revoked-after-grant` run with finish-none expectations derived for the
`devvit` id.
