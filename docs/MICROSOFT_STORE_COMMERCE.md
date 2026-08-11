# Microsoft Store Commerce

`@mpgd/adapter-browser/microsoft-store` is the client boundary for Store-installed
Windows PWAs. It uses the billing provider
`https://store.microsoft.com/billing`, loads localized product details, opens
Payment Request checkout, and recovers unconsumed purchases with
`listPurchases()`.

The adapter deliberately does not grant inventory or call client-side
`consume()`. Microsoft Digital Goods does not issue a transaction-unique token:
for this provider, `purchaseToken` identifies the add-on product. A game-owned
authority must therefore confirm the purchase with Microsoft Collections before
granting anything.

`purchaseToken` is also not a User Store ID. A Store-installed PWA cannot derive
the purchasing account's `UserCollectionsId` from Digital Goods alone. Treat the
checkout result only as a prompt to ask the trusted authority to query Store
ownership for the already-bound player.

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
2. Resolve an Entra service access token, renewable User Store ID, and stable
   opaque account-link ID from trusted server identity. None may come from
   client purchase evidence. The account-link ID must survive User Store ID
   renewal and change only when the player links a different Store account.
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
`MICROSOFT_STORE_XSTS_REQUIRED_FOR_SANDBOX`; sandbox testing requires delegated
XSTS authentication supplied by the game service.

## Game-owned setup

Generated and initialized Store targets start with `commerce.mode: "disabled"`
and `authoritativeGameServices: false`, so their effective target disables IAP
and every product. After the requirements below are configured, switch the
submission commerce mode to `microsoft-store` and the target's
`authoritativeGameServices` flag to `true` together.

Before enabling commerce, the game must provide:

- published Partner Center developer-managed consumable add-ons;
- both `inAppOfferToken` and `storeId` for every catalog product;
- an Entra application authorized for Microsoft Store service APIs;
- a secure User Store ID acquisition and player-binding path with a stable,
  non-secret account-link ID separate from the renewable User Store ID;
- a public HTTPS Game Services endpoint and durable entitlement ledger;
- retry and alerting for pending consume finalizations.

Until all of these exist, return `configuration-required` from the adapter
authority so product enumeration and checkout stay unavailable.

### User Store ID acquisition for a PWA

Choose and document one trusted account-linking strategy before enabling the
commerce capability:

1. A Windows host bridge obtains a User Collections ID for the account signed in
   to Microsoft Store, then sends it to the game service over an authenticated
   player session.
2. The service links the player through Microsoft/Xbox OAuth and uses delegated
   X-tokens to create the User Collections ID server-side.

Do not accept a User Store ID, service access token, account-link ID, or player
identifier from Digital Goods purchase evidence. The Microsoft Store purchasing
account can be different from the Xbox or game account, so the game must show
which account is being linked and bind the resulting key to one authenticated
player. User Store IDs expire and require a renewal path; use the server's own
durable account-link record identity for `accountBindingId` so renewal does not
look like an account switch. A missing or expired binding must make verification
pending without writing another grant.

Worker deployments must configure
`GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER` and
`GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER` together. A verifier-only
deployment is rejected because granting without consume finalization would
prevent the user from buying that developer-managed consumable again.

Official references:

- [Digital Goods API for Microsoft Store PWAs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/digital-goods-api)
- [Collections v9 publisherQuery](https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/microsoft-store-apis/xstore-v9-query-for-products)
- [Collections v8 consume](https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/microsoft-store-apis/xstore-v8-consume)
- [Requesting a User Store ID](https://learn.microsoft.com/en-us/xbox/gdk/docs/store/commerce/service-to-service/xstore-requesting-a-userstoreid)
- [Creating a User Store ID from delegated authentication](https://learn.microsoft.com/en-us/xbox/gdk/docs/store/commerce/service-to-service/xstore-requesting-a-userstoreid-from-services)
