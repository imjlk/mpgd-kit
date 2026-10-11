---
npm/@mpgd/adapter-verse8: minor
---

Commerce v2, PR B6: the Verse8 provider on the server-push lookup.

Not yet usable in production before C2: the backend lookup verifier for
`verse8.agent8-event.v1` is C2 work, so today a verify request for a Verse8
purchase is refused by `@mpgd/game-services` (no verifier for the schema,
`verse8` not a store target) instead of answering `pending`, and no journal
record can reach `granted`. `vxShop.purchases` is opt-in; without it nothing
changes.

`@mpgd/adapter-verse8` adds `createVerse8CommerceProvider({ products, client,
purchases, store?, init?, canOpenShop?, onPurchasesChanged? })`, a
`CommerceProvider` with `store: 'verse8'` and the RFC profile (consumable and
durable one-time products, no subscription, no quantity, no available-purchase
list, `lifecycle.finish: 'none'`, `authority.evidence: 'server-push'`,
`accountBinding: 'host'`, pending, restore, events). It drives the same VXShop
client as the v1 adapter and never grants: the Agent8 server's reserved
`$onItemPurchased` event writes the record, and the backend's lookup verifier
answers `pending` until it exists.

- `requestPurchase` refreshes VXShop, checks the live item, and opens the
  dialog with `buyItem`, answering `launched`; outside the Verse8 iframe it
  fails with `CONFIGURATION_REQUIRED` (`VERSE8_SHOP_UNAVAILABLE`), an unlisted,
  unpurchasable, or limit-reached item with `ITEM_UNAVAILABLE`
  (`VERSE8_PRODUCT_NOT_LISTED`, `VERSE8_PRODUCT_NOT_PURCHASABLE`,
  `VERSE8_PURCHASE_LIMIT_REACHED`), and a failed refresh with a retryable
  `STORE_UNAVAILABLE`.
- `getAvailablePurchases` is empty; `restorePurchases` re-reads the
  `purchases` source (`Verse8PurchaseSource`) and emits `purchaseUpdated` once
  per recorded purchase not reported before (the Agent8 purchase id as
  `transactionId` and `token`, `verse8.agent8-event.v1` evidence
  `{ purchaseId, productId, quantity }`, a `host-identity` binding). The
  `onPurchasesChanged` signal does the same and may carry the purchases it
  knows; by default it is the VXShop dialog closing after a purchase
  (`VXShop.onClose`, now an optional member of `Verse8VXShopClient`), observed
  from creation until `dispose()` so a purchase signalled while nobody listens
  is buffered. The first listener triggers a re-read (a restart finds the
  purchases recorded meanwhile), a signal nothing was recorded for yet is
  followed by re-reads at `verse8PurchaseFollowUpDelaysMs` (the Agent8 event
  may land after the dialog closed), and the newest
  `maximumVerse8ReportedPurchases` records are the ones reported. Events
  before the first listener are buffered.
- `createVerse8CommerceCapabilities`, `createVerse8StorePurchase`,
  `createVerse8Agent8EventEvidence`, and `assertVerse8Agent8EventEvidence` (the
  server-side validation of `verse8.agent8-event.v1`) are exported from the
  main entry and from `./agent8`.

`createVerse8Agent8CommerceService` adds `listPurchases(account, context)`,
the purchases `$onItemPurchased` recorded for an account, oldest first
(`Verse8RecordedPurchase`), for a game-owned authenticated Agent8 method to
expose as the provider's purchase source.

`createVerse8PlatformGateway` takes `vxShop.purchases` and
`vxShop.onPurchasesChanged`; with `purchases` configured it exposes the
provider as `commerceV2` and adds the `commerce` capability block with
`nativeIap` and `subscriptionIap` derived from it. Without it the gateway is
unchanged, and the v1 adapter keeps its behaviour either way.

Conformance: `adapters/verse8/src/verse8-commerce-provider.conformance.test.ts`
runs the RFC vectors through `runCommerceConformanceVectors` with a fake VXShop
and Agent8 record, directly and through the gateway; `server-push-settlement`
passes with its fixture expectations, and `event-before-listener`,
`purchase-client-finish`, `restart-before-verify`, and `revoked-after-grant`
run with finish-none expectations derived for the `verse8` id.
