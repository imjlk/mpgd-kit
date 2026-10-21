# Devvit Payments and Commerce v2

> **The commerce gateway option needs the backend's C2 pieces.** The
> fulfillment handler path (`normalizeDevvitFulfillmentOrder` and the ledger
> write) is unchanged. For `createDevvitPlatformGateway`'s `commerce` option the
> backend must (1) register the `devvit.order.v1` lookup entry
> (`createDevvitOrderLookupCommerceEvidenceEntry({ ledger })` in its
> `createCommerceEvidenceRegistry`; the Worker does so with
> `MPGD_COMMERCE_LOOKUP_STORES = ["devvit"]`), which answers `granted` once
> the fulfillment handler's ledger entry for the order exists and `pending`
> before it, and never grants from the client envelope; and (2) have the
> fulfillment handler write that entry in the lookup's shape, through
> `createPlatformOrderLedgerGrant` (key `reddit:<orderId>`, target `reddit`,
> store `devvit`, the order id as the platform transaction id) or through
> `verifyPurchase` with `createPlatformOrderVerifyRequest` and the
> `devvit.payment-order.v1` entry. Refund orders
> (`normalizeDevvitRefundOrder`) go to `revokePlatformOrder`, which appends
> the `revoke` entry the reconciler's revocation pass reads.

Reddit settles a Devvit purchase on the server: the payment handler your app
registers (`fulfillOrder`) runs when an order is `PAID`, and only the backend
ledger that handler writes grants anything. The webview never grants, never
finishes, and never trusts its own checkout result. `@mpgd/adapter-devvit`
ships one client surface over that rule, the commerce v2 `CommerceProvider`
described below (the v1 `CommerceAdapter` is gone, see
[Migrating from v1](#migrating-from-v1)).

The provider runs over a game-owned `DevvitPaymentsClient`, a thin wrapper
around `purchase()` from `@devvit/payments/client`
(`import { purchase } from '@devvit/payments/client'`; `@devvit/web/client`
re-exports it). The wrapper maps the `OrderResultEvent` it returns:
`STATUS_SUCCESS` with `orderId` to `completed`, `STATUS_CANCELLED` to
`cancelled`, and `STATUS_ERROR` to `failed` with `{ error: { code:
String(errorCode), message: errorMessage } }`. The order id is Reddit's; do
not attach client metadata that identifies the attempt.

The server side normalizes the handler request with
`normalizeDevvitFulfillmentOrder` and `normalizeDevvitRefundOrder` from
`@mpgd/adapter-devvit/server` (evidence `devvit.payment-order.v1`) and writes
the ledger through `@mpgd/game-services` platform orders
(`createPlatformOrderIdempotencyKey`, key `reddit:<orderId>`). That path is
unchanged by commerce v2.

## Commerce v2 provider

`createDevvitCommerceProvider(input)` from `@mpgd/adapter-devvit` is the
commerce v2 `CommerceProvider` (RFC:
[docs/specs/commerce/commerce-v2-rfc.md](specs/commerce/commerce-v2-rfc.md))
with `store: 'devvit'`. It takes `products` and `client` (a
`DevvitPaymentsClient`, which only has `purchase(sku)`), plus an `orders`
source (the server-push lookup, see below), an optional `store` id
(conformance vectors name their fixture store), an optional `onOrdersChanged`
signal, and an `onCheckoutError` hook.

Capability block (`createDevvitCommerceCapabilities`), the RFC profile row:

- `purchase`: consumable and durable (Reddit `INSTANT`, `CONSUMABLE`, and
  `DURABLE` accounting types); no subscription, no quantity.
- `catalog`: products, no offers, no localized price (prices are Reddit Gold
  amounts, formatted by the adapter).
- `lifecycle`: `availablePurchases`, `pending`, `restore`, `events`,
  `finish: 'none'`. The fulfillment handler settles on the server, so the
  provider has no `finishTransaction`; a `granted` journal record moves
  straight to `finished`. `pending` is the server-side pending of a
  server-push store: the backend's lookup verifier answers `pending` until the
  fulfillment push wrote the ledger. Reddit reports no store-side pending
  order.
- `authority`: `evidence: 'server-push'`, `accountBinding: 'host'` (the
  purchasing Reddit account is the server request context, never a payload).
- `availability`: `available` when products are configured and the order
  source reports the server serves commerce v2; `configuration-required`
  without products or when the server bridge answers
  `COMMERCE_V2_UNAVAILABLE`; `temporarily-unavailable` when the read fails.

Methods:

- `fetchProducts` lists the configured products (`ProductInfo` as
  `StoreProduct`, `storeSku` is the Devvit SKU); subscriptions never list.
- `requestPurchase` opens the Reddit checkout through `client.purchase(sku)`.
  A `completed` result that carries the order id answers `purchased`: the
  order id is `transactionId` and `token`, the evidence is
  `devvit.order.v1` `{ orderId, sku, source: 'checkout' }`, the account
  binding is `host-identity`, and no `settlement` is attached because the
  backend verify is what grants. A `completed` result without an order id or
  a `pending` result is `launched`: an order may exist, and the reconciler
  resolves it from `getAvailablePurchases`. `cancelled` is `USER_CANCELLED`;
  `failed` keeps the platform code as `storeCode` (a v2 code the wrapper
  already classified is kept as is; `OUTCOME_UNKNOWN` and `ALREADY_OWNED`
  classes stay open as `launched`). A `purchase()` call that rejects (the
  checkout effect produced no usable response, which does not prove that no
  order was created) also stays open as `launched`, after `onCheckoutError`,
  and the paid-order list is re-read. An
  unconfigured product fails with `ITEM_UNAVAILABLE` before any checkout; a
  quantity above one is rejected by `assertRequestPurchaseSupported`.
- `getAvailablePurchases` lists the paid orders whose delivery Reddit has not
  acknowledged (`PAID`), as `purchased` with `devvit.order.v1`
  `{ source: 'order-list', status: 'PAID' }` evidence, bounded by
  `maximumDevvitAvailableOrders` (64). Orders for SKUs this build does not
  sell are not listed. `includePending` adds nothing.
- `restorePurchases` re-reads the order source and emits `purchaseUpdated`
  once per order not reported before, delivered orders included (`status:
  'DELIVERED'`): Reddit marks an order delivered as soon as the fulfillment
  handler answered, so a session that lost its checkout result to a restart
  finds the order this way, the backend lookup answers `granted` for it, and
  the open journal record closes. The first listener triggers the same read.
  The `onOrdersChanged` signal does the same and may carry the orders it
  already knows (`DevvitOrdersChange`), which are reported before the read;
  it is observed only while a listener exists. Events before the first
  `subscribe` are buffered (`createCommerceEventBuffer`). The provider emits
  no `purchaseError`.

### The server-push lookup

Devvit lists orders on the server only (`payments.getOrders` from
`@devvit/payments/server`), so the webview reads the paid-order list through
the server bridge. `createDevvitCommerceV2BridgeHandler({ payments, products
})` from `@mpgd/adapter-devvit/server` serves the six `commerce.v2.*` bridge
methods over the plugin:

- `getCapabilities` answers the profile above (`available` with products,
  `configuration-required` without).
- `fetchProducts` lists the configured SKUs from `payments.getProducts`,
  priced in Reddit Gold (`{ formatted: '<amount> Gold', currencyCode: 'GOLD'
  }`); time-limited goods (`VALID_FOR_*`) are not listed.
- `getAvailablePurchases` pages `payments.getOrders` (64 per page) until the
  cursor ends, or until `maximumDevvitOrderScanPages` (32). `@devvit/payments`
  0.14 ignores the `buyer` and `status` filters (`GetOrdersRequest` marks both
  "currently does nothing"), so the handler filters status itself and cannot
  stop after pages that hold only canceled or new orders. A scan that still
  has a next page at the cap fails with the retryable
  `DEVVIT_ORDER_SCAN_INCOMPLETE` instead of returning a partial list: an order
  that was not read is not delivered. The handler lists the `PAID` and
  `DELIVERED` orders of configured SKUs with exactly one product, each as
  `purchased` with order evidence whose `status` says which; a `NEW`,
  `CANCELED`, or `REVERTED` order is not listed. The webview provider keeps
  only the `PAID` ones as available and reports both as events.
<!-- @link ../adapters/devvit/src/server/commerce-bridge.ts#createDevvitCommerceV2BridgeHandler Pages until the cursor ends, or fails the request at the scan cap. -->
<!-- @link ../adapters/devvit/src/server/commerce-bridge.ts#maximumDevvitOrderScanPages Bounded page cap for a time-limited Devvit request. -->
<!-- @link ../adapters/devvit/src/server/commerce-bridge.ts#devvitOrderScanIncompleteBridgeErrorCode Visible incomplete scan; unseen orders are not delivered. -->
  The plugin runs in the
  request context of the authenticated Reddit user, and Reddit documents
  server-side `payments.getOrders()` as that user's orders in reverse
  chronological order (Devvit docs, "Manage Payments", "Check orders", whose
  example exposes "orders for the current user" with a `sku` filter only); the
  `buyer` and `status` filters of `getOrders` do nothing in `@devvit/payments`
  0.14, which is why the handler filters the status itself. Even if a foreign
  order were ever listed, nothing would be granted for it: the backend lookup
  answers from the ledger entry the fulfillment handler wrote for the
  purchasing player.
- `requestPurchase` is refused with `DEVVIT_COMMERCE_CHECKOUT_CLIENT_ONLY`:
  the checkout is a webview effect. `finishTransaction` is refused with
  `COMMERCE_V2_METHOD_UNSUPPORTED`. `restorePurchases` answers `{ restored:
  false }`; the webview provider re-reads the list itself.
- Payloads and results are validated with the `@mpgd/platform/commerce`
  asserts (`COMMERCE_V2_INVALID_PAYLOAD` on a rejected payload); a plugin
  failure crosses the bridge as the retryable `DEVVIT_PAYMENTS_UNAVAILABLE`.

The Devvit server bridge (`createDevvitBridgeHandler` in
`apps/target-devvit/src/server/bridge.ts`, byte-identical in the CLI template)
takes that handler as its optional `commerce` dependency. Without it every
`commerce.v2.*` method keeps failing closed with `COMMERCE_V2_UNAVAILABLE`,
and the sandbox bridge (`createDevvitSandboxBridge`) always does: it has no
payments plugin and no order list. Both bridges answer the removed v1
`commerce.getProducts`, `commerce.purchase`, `commerce.restore`, and
`commerce.getEntitlements` methods with `UNSUPPORTED_METHOD`. The bridge's
`runtime.getCapabilities` answer carries a `commerce` block: the unsupported
block (`createUnsupportedCommerceCapabilities()`) without the handler, the
handler's own `commerce.v2.getCapabilities` block with it, and the unsupported
block again if the handler fails or answers something that is not a block. It
no longer carries `nativeIap`. Wiring `payments` from `@devvit/web/server` and
the catalog SKUs into the generated server entry is C3 work.

On the webview, `createDevvitPlatformGateway({ ..., commerce: { products,
client, onOrdersChanged?, onCheckoutError?, store? } })` installs the provider
as the gateway's `commerce` over the gateway's own bridge: the order source is
`createDevvitBridgeOrderSource(request)` (`commerce.v2.getAvailablePurchases`
and `commerce.v2.getCapabilities`), and `getCapabilities()` replaces the
server snapshot's `commerce` block with the provider's (dropping `nativeIap`
and `subscriptionIap` if an older server still sends them). The option keeps
its name `commerce`; it configures the provider, and the gateway property it
sets is `gateway.commerce`. Without the option the gateway sells nothing: it
has no `commerce` and reports `createUnsupportedCommerceCapabilities()`,
whatever the server answers.

### Entitlements come from the backend ledger

The v1 payments client had a `getEntitlements()` read, and the server bridge
answered `commerce.getEntitlements`. Both are gone, and the commerce provider
needs neither: `getAvailablePurchases` is the paid-order list the server
bridge reads from `payments.getOrders`, and whether a purchase granted
anything is the backend ledger's answer. Reddit settles on the server, so the
fulfillment handler's ledger entry is the only grant. A game that shows what
the player owns reads that ledger on the server, for example
`listActiveEntitlementTransactions(store, { playerId })` from
`@mpgd/game-services/commerce-ledger` (reversed grants subtracted), behind a
game-owned authenticated route, and the reconciler (`@mpgd/game-services`)
reports each purchase's journal state next to it.

The backend side of the lookup is the server-push verifier C2 added
(`createDevvitOrderLookupCommerceEvidenceEntry` in
`@mpgd/game-services/commerce-evidence-registry`): a verify request carrying
`devvit.order.v1` evidence is `granted` when the ledger holds the grant the
fulfillment handler wrote for that order (target `reddit`, the order id as the
platform transaction id, as `createPlatformOrderLedgerGrant` writes it) for
the same player and product, `pending` (`LEDGER_GRANT_PENDING`) otherwise,
and `rejected` when the envelope names another transaction or SKU than the
request or the grant belongs to someone else. A purchase discovered without a
journal record derives the key `store:devvit:<encodeURIComponent(orderId)>`;
the fulfillment handler keeps writing under `reddit:<orderId>`, and the
platform-evidence unique index remains the backstop between the two.

### Conformance

`adapters/devvit/src/devvit-commerce-provider.conformance.test.ts` runs the
RFC vectors through `runCommerceConformanceVectors` with a fake Reddit,
directly and through the server bridge handler and gateway path.
`server-push-settlement` passes with its fixture expectations (the provider
runs under the fixture store id); `event-before-listener`,
`purchase-client-finish` (the canonical `purchase-<owner>-finish` member for
`finish: 'none'`), `restart-before-verify`, and `revoked-after-grant` run with
expectations derived for the `devvit` id. `finish-failure-retry` is skipped by
the runner (it scripts a client finish), `cancelled-and-failed` (a later
`store.error` event; a Devvit checkout outcome is the result of the purchase
call) and `purchase-pending-then-purchased` (store-side pending) are listed as
not applicable, and `adapter-settled` and the wallet vectors belong to other
profiles.

## Starter wiring and catalog SKUs

Commerce v2 PR C3 connects the generated game and the private starter. The
catalog is the single source of the Devvit SKUs: `platformProductIds.reddit`
of each one-time product (a subscription with a `reddit` SKU fails
`pnpm validate:catalog`, since Devvit sells one-time goods only). The
sample `@mpgd/catalog` catalog names no Reddit SKU: Devvit SKUs are
app-owned, so a game adds `platformProductIds.reddit` together with
`permissions.payments` and the matching `payments` block in `devvit.json`.
Until then the Reddit target reports its products as `missing-platform-id`
and no payments wiring is installed.

- **Webview.** `buildGateways/reddit.ts` passes `commerce` to
  `createDevvitPlatformGateway` when the catalog names any Reddit SKU:
  `createDevvitCommerceProducts(catalog)` (the products, with the logical id
  as title and a Reddit Gold placeholder price unless a `describe` callback
  supplies copy) and `createDevvitWebPaymentsClient()` from
  `@mpgd/adapter-devvit/web`, the checkout client over `purchase()` from
  `@devvit/web/client`. `toDevvitCheckoutResult` maps the `OrderResultEvent`:
  `STATUS_SUCCESS` with an order id to `completed`, without one to `pending`
  (the reconciler resolves it from the paid-order list), `STATUS_CANCELLED`
  to `cancelled` (`USER_CANCELLED`), `STATUS_ERROR` to `failed` with the
  platform `errorCode` as `storeCode`, and an unknown status to `pending`.
  Without Reddit SKUs the gateway offers no `commerce`.
- **Server.** `apps/target-devvit/src/server/index.ts` builds
  `createDevvitCommerceV2BridgeHandler({ payments, products })` with
  `createDevvitCommerceBridgeProducts(catalog)` (`{ productId, sku }`, from
  `@mpgd/adapter-devvit/server`) and hands it to the bridge as `commerce`
  only when `devvit.json` sets `permissions.payments: true`, declares a
  fulfillment endpoint (`payments.endpoints.fulfillOrder`), **and** the
  catalog names at least one Reddit SKU. The shipped `devvit.json` keeps
  `permissions.payments: false`, so every `commerce.v2.*` method keeps
  failing closed with `COMMERCE_V2_UNAVAILABLE` until the game opts in; the
  server logs which way it started.
- **Opting in.** Set `permissions.payments: true`, add the `payments` block
  Devvit requires (`products` or `productsFile` whose `sku` values are the
  catalog's `reddit` keys, and `endpoints.fulfillOrder`, plus
  `refundOrder` for refunds), and implement the fulfillment handler that
  writes the ledger grant as described at the top of this page. The handler
  only lists orders and products; the grant still comes from the
  fulfillment handler's ledger entry, which the backend's `devvit.order.v1`
  lookup reads.

Both sides always read the `reddit` key, whatever the deployment target is
named, and `pnpm validate:effective-config` rejects an IAP-enabled Devvit
target whose effective products or SKUs differ from the server's list.

## Migrating from v1

C4 removed the commerce v1 surfaces of `@mpgd/adapter-devvit` in one major
release. The removed exports and their replacements:

| Removed | Replacement |
| --- | --- |
| `createDevvitCommerceAdapter(input)` | `createDevvitCommerceProvider({ products, client, orders, ... })`, or the gateway option `createDevvitPlatformGateway({ commerce })` |
| `withDevvitCommerceAdapter(gateway, commerce)` | `createDevvitPlatformGateway({ commerce })` sets `gateway.commerce` and the `commerce` capability block |
| `CreateDevvitCommerceAdapterInput` | `CreateDevvitCommerceProviderInput` |
| `DevvitPaymentsClient.getEntitlements()` | The backend ledger: `listActiveEntitlementTransactions` on the server, the reconciler's journal on the client |
| `gateway.commerceV2` | `gateway.commerce` (a `CommerceProvider`, absent when the gateway sells nothing) |
| the v1 `gateway.commerce.getProducts`, `purchase`, `restore`, `getEntitlements` | `fetchProducts`, `requestPurchase`, `restorePurchases`, `getAvailablePurchases` of the provider; games call `@mpgd/game-services`, not the provider |
| `capabilities.nativeIap`, `capabilities.subscriptionIap` | `capabilities.commerce` (`availability`, `purchase`, `lifecycle`, `authority`) |
| bridge methods `commerce.getProducts`, `commerce.purchase`, `commerce.restore`, `commerce.getEntitlements` | `UNSUPPORTED_METHOD`; the six `commerce.v2.*` methods |

Kept: `createDevvitCommerceProvider`, `createDevvitCommerceV2BridgeHandler`,
the catalog helpers (`createDevvitCommerceProducts`,
`createDevvitCommerceBridgeProducts`), `normalizeDevvitCommerceProducts`,
`DevvitCheckoutResult`, `DevvitPaymentsClient` (now only `purchase`), and the
web checkout client (`createDevvitWebPaymentsClient`). `ProductInfo`,
`PurchaseResult`, and `Entitlement` stay in `@mpgd/platform` as result
vocabulary; `DevvitCheckoutResult.status` still uses the `PurchaseResult`
status values.
