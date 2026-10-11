---
npm/@mpgd/platform: minor
npm/@mpgd/catalog: minor
npm/@mpgd/adapter-verse8: patch
---

`@mpgd/platform` adds the commerce v2 contract module as the new `./commerce`
and `./commerce-vectors` subpaths: the client contract types (`StoreProduct`,
`StorePurchase`, `RequestPurchaseInput`, `CommerceEvent`, `CommerceProvider`,
`CommerceCapabilities`, `ActiveSubscription`, credit wallet types), the bridge
v2 payload shapes and event envelope, `CommerceError` with normalized codes,
the purchase lifecycle state machine, typia validators that reject unknown
keys, `createDerivedPurchaseIdempotencyKey`, the bounded pre-listener event
buffer, `assertRequestPurchaseSupported`, the v1 `toCommerceAdapter` wrapper
(which never grants), and the conformance vector format. `PlatformCapabilities`
gains an optional `commerce` block that the capability conformance runner
checks for fresh objects, exact keys, and agreement with `nativeIap` and
`subscriptionIap`. This is additive: no reference provider implements v2 yet,
and the protocol version stays `2.0.0-draft.1`. The package now depends on
`typia`.

`@mpgd/catalog` opens `ProductGrant.currency` and `AdReward.currency` to any
non-empty string validated against a new optional `ProductCatalog.currencies`
list (non-empty, unique, trimmed); when absent the catalog accepts `coin` and
`gem` as before. `assertProductCatalog` and `validate:catalog` reject a currency
grant that names an undeclared currency, `validate:ads` cross-checks reward
currencies against the catalog, and `resolveCatalogCurrencies` and
`defaultCatalogCurrencies` are exported. The kit adds no wallet currency
literal.

`@mpgd/adapter-verse8` keeps its `coin` and `gem` balance map and now fails a
currency grant for any other catalog currency with a clear error instead of
writing an untracked balance.
