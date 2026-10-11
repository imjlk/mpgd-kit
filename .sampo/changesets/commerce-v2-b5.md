---
npm/@mpgd/adapter-ait: minor
---

Commerce v2, PR B5: the Apps in Toss provider.

`@mpgd/adapter-ait` adds `createAitCommerceProvider({ dependencies, iapProducts,
prepareIap, verifyIapProductGrant, readIapEntitlements?, iapProductGrantTimeoutMs?,
onPendingOrdersChanged? })`, a `CommerceProvider` with `store: 'apps-in-toss'`
and the RFC profile (consumable and durable one-time products, no subscription,
no quantity, `lifecycle.finish: 'host'`, `authority.evidence: 'host-callback'`,
`accountBinding: 'host'`, pending, restore, events, available purchases,
localized prices). It runs the host bridge's own IAP machinery, now shared
through an internal controller, so a v1 `commerce.purchase` and a v2
`requestPurchase` hold the same IAP lock and the same durable attempt markers,
pre-checkout pending-order barrier and acknowledgement barriers; the v1
`commerce.*` bridge methods behave exactly as before.

- `fetchProducts` lists the configured one-time SKUs from `getProductItemList`
  (`CONSUMABLE` as `consumable`, `NON_CONSUMABLE` as `durable`, subscriptions hidden).
- `requestPurchase` opens `createOneTimePurchaseOrder`. The game-owned
  `verifyIapProductGrant` hook inside the SDK grant callback stays the only
  server confirmation: a `purchased` result (order id as `transactionId` and
  `token`, `apps-in-toss.iap.callback.v1` evidence `{ orderId, sku, source }`,
  `host-identity` binding) is produced only after that hook confirmed the
  grant. A cancellation is `cancelled` and a terminal failure `failed` with the
  `AIT_IAP_*` code as `storeCode` (`aitIapCommerceErrorCodeMap`); every
  outcome the host cannot settle yet (grant pending, acknowledgement
  unconfirmed, checkout timeout, `OUTCOME_UNKNOWN` and `ALREADY_OWNED`
  classes) is `launched`, so the attempt stays open for the reconciler.
- `getAvailablePurchases` lists the paid, ungranted orders of `getPendingOrders`
  as `purchased`, server-granted orders whose `completeProductGrant()` was not
  confirmed as `purchased`, and, with `includePending`, orders a checkout of
  this session observed that the host does not list yet as `pending`.
- `finishTransaction({ transactionId, ledgerEntryId, isConsumable })` is the
  host finish: it refuses to run without the reconciler's ledger entry id,
  confirms the grant for the order through `verifyIapProductGrant` first
  (the game side of the bridge is not trusted to hold a grant; the hook must
  be idempotent per order, as the v1 restore pass already requires, and
  reachable from a v2-only integration, or the order stays unfinished), then
  acknowledges a listed order with `completeProductGrant()` (marking the
  linked client attempt completed first, as the restore pass does) and
  settles the barrier of an order the host already finished. It never grants,
  and an order the provider lists under another SKU is never acknowledged.
- `restorePurchases` runs the pending-order recovery pass (prepare, verify
  through `verifyIapProductGrant`, acknowledge) and reports settled and
  still-pending orders as `purchaseUpdated` events; events before the first
  listener are buffered (`createCommerceEventBuffer`).
- `onPendingOrdersChanged` is the signal that the pending-order list may have
  changed (the app resuming from the checkout page by default); the provider
  observes it while a listener exists, re-reads the list, reports orders the
  signal carries (`AitPendingOrdersChange`) at once, and emits
  `purchaseUpdated` once per order. Orders the host finished stay available
  until the reconciler finishes them. The provider emits no `purchaseError`:
  every checkout outcome is a synchronous result.

The host bridge (`createAitHostBridge`) now serves the six `commerce.v2.*`
bridge methods from that provider with the `@mpgd/platform/commerce` asserts
on payloads and results, pushes `BridgeEvent` envelopes through the new
`GamePlatformBridge.commerceV2` event channel, and answers
`runtime.getCapabilities` with the `commerce` block and `subscriptionIap: false`
added, `nativeIap` now derived from the block (its value is unchanged). The
v1 `commerce.*` bridge methods keep their behaviour. `createAitPlatformGateway` exposes
`commerceV2` (`createAitBridgeCommerceProvider`) whenever the installed bridge
has the event channel. The sandbox bridge answers commerce v2 with an
evidence-only stub for the `ait-sandbox` build id only; every other build keeps
`COMMERCE_V2_UNAVAILABLE`.

Conformance: `adapters/ait/src/ait-commerce-provider.conformance.test.ts` runs the
RFC vectors through `runCommerceConformanceVectors` with a fake Apps in Toss
host, directly and through the host bridge and gateway; `purchase-host-finish`
is the canonical family member, and `event-before-listener`,
`finish-failure-retry`, `restart-before-verify` and `revoked-after-grant` run
with host-finish expectations derived for the `apps-in-toss` id.
