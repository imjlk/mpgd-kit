# Microsoft Store Commerce

`@mpgd/adapter-microsoft-store` is the client boundary for Store-installed
Windows PWAs. It uses the billing provider
`https://store.microsoft.com/billing`, loads localized product details, opens
Payment Request checkout, and recovers unconsumed purchases with
`listPurchases()`.

The adapter deliberately does not grant inventory or call client-side
`consume()`. Microsoft Digital Goods does not issue a transaction-unique token:
for this provider, `purchaseToken` identifies the add-on product. A game-owned
authority must therefore confirm the purchase with Microsoft Collections before
granting anything.

## Product identifiers

Keep these identifiers separate:

- `logicalProductId`: the game catalog ID, such as `HINT_PACK_20`.
- `inAppOfferToken`: the Partner Center add-on Product ID used by Digital Goods
  `getDetails()` and Payment Request.
- `storeId`: the Store catalog ID, typically beginning with `9`, used by
  Collections `publisherQuery` and `consume`.

The Microsoft Store submission preflight accepts the last two fields separately
and rejects duplicate mappings.

## Authoritative fulfillment

`createMicrosoftStorePurchaseBoundary()` implements the shared Game Services
verification/finalization contract for developer-managed consumables:

1. Reject requests that are not from the `microsoft-store` target or whose
   Digital Goods evidence does not match the catalog `inAppOfferToken`.
2. Resolve an Entra service access token and User Store ID from trusted server
   identity. Neither value may come from client purchase evidence.
3. Query Collections v9 for the configured `storeId` and require an active
   `UnmanagedConsumable` with remaining quantity.
4. Record the product grant in the Game Services idempotency ledger.
5. Call Collections v8 `consume` with a deterministic retry-safe GUID and check
   the returned item, product, tracking ID, and zero remaining quantity.

If verification is unavailable, no grant is written. If consume fails after a
successful ledger write, finalization stays pending and can be retried with the
same tracking ID.

User Store ID plus Entra authentication cannot consume developer-managed
consumables in non-RETAIL sandboxes. The boundary fails closed with
`MICROSOFT_STORE_XSTS_REQUIRED_FOR_SANDBOX`; sandbox testing needs delegated
XSTS authentication supplied by the game service.

## Game-owned setup

Before enabling commerce, the game must provide:

- published Partner Center developer-managed consumable add-ons;
- both `inAppOfferToken` and `storeId` for every catalog product;
- an Entra application authorized for Microsoft Store service APIs;
- a secure User Store ID acquisition and player-binding path;
- a public HTTPS Game Services endpoint and durable entitlement ledger;
- retry and alerting for pending consume finalizations.

Until all of these exist, return `configuration-required` from the adapter
authority so product enumeration and checkout stay unavailable.

Official references:

- [Digital Goods API for Microsoft Store PWAs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/digital-goods-api)
- [Collections v9 publisherQuery](https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/microsoft-store-apis/xstore-v9-query-for-products)
- [Collections v8 consume](https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/microsoft-store-apis/xstore-v8-consume)
