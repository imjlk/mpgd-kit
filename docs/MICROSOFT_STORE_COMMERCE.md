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
   Digital Goods evidence matches neither the current catalog `inAppOfferToken`
   nor an explicitly configured historical product mapping.
2. Resolve an Entra service access token, renewable User Store ID, and stable
   opaque account-link ID from trusted server identity. None may come from
   client purchase evidence. The account-link ID must survive User Store ID
   renewal, be identical for the same Store account across attempted game-player
   links, and change only when the player links a different Store account.
3. Query Collections v9 for the configured `storeId` and require an active
   `UnmanagedConsumable` with remaining quantity.
4. Record the product grant in the Game Services idempotency ledger.
5. Call Collections v8 `consume` with a deterministic retry-safe GUID and check
   the returned item, product, tracking ID, and zero remaining quantity.

If verification is unavailable, no grant is written. If consume fails after a
successful ledger write, finalization stays pending and can be retried with the
same tracking ID.

The browser adapter also preserves the first checkout idempotency key and the
purchased Store identity while the item remains pending. It uses `localStorage`
by default, with `recoveryIdStorage` available for a game-owned compatible store,
so a PWA restart or later `restore()` resumes the same verification identity and
does not fabricate evidence from a newer catalog mapping. The required
`getRecoveryScope()` callback must return a stable, non-secret identifier for the
currently authenticated player. Recovery storage is partitioned by that scope
and the stable logical product ID to avoid accidental cross-account retries;
the partition is not an authorization boundary. Refresh
`getProducts()` after the authenticated player changes; checkout fails before
opening Payment Request if the scope changed after catalog preparation. The
scope is checked again after the payment UI returns and after the asynchronous
ownership lookup; if it changed in either window, no authority call is made and
no new browser recovery record is trusted or created.

Browser recovery records are retry metadata, never player-ownership evidence.
Implement the required `claimRecoveryOwnership()` and `hasRecoveryOwnership()`
methods on the purchase authority with an authenticated, durable backend
binding keyed by the stable Store-account binding and Collections Store product
ID. A successful checkout claims that binding before verification; `restore()`
calls `hasRecoveryOwnership()` before
it submits either a scoped pending record or a global `listPurchases()` item to
the grant authority. An approved result returns the durable checkout
`idempotencyKey`; this lets a global Store listing resume the original ledger
identity even after browser retry storage is lost. Recovery fails closed when
the ownership method returns `denied`, and keeps a scoped retry when it returns
`unavailable`. Legacy `pending-owner` localStorage
records are deliberately ignored, so rewriting or copying browser storage
cannot authorize a grant.

The claim endpoint must derive the player from its authenticated server session,
not from `getRecoveryScope()` or another browser-supplied player ID. Make claims
idempotent for the same player and reject an exact Store identity already bound
to a different player. Store the original idempotency key as an opaque ownership
generation: a retry with the same generation is idempotent, while a fresh
generation cannot replace the same unconsumed provider purchase even for the
same player. Persist the record's `providerPurchaseId`, which the boundary
derives from the Collections item ID, Store product ID, and modified date. A
different provider purchase may atomically replace the same player's stale
claim left behind after the prior item was consumed; it must not transfer the
binding to another game player. Release only the exact player, generation, and
provider purchase after authoritative consume succeeds, so a delayed release
cannot erase the replacement. If that release is unavailable, keep finalization
pending so the same deterministic consume and release can be retried. Pass
the current, server-trusted product catalog tokens as
`inAppOfferTokens`; the boundary rejects a claim whose browser-supplied current
token does not match that mapping. Never construct this mapping from the claim
request. Pass a durable, atomically implemented
`recoveryOwnershipStore` to `createMicrosoftStorePurchaseBoundary()`; the
in-memory implementation is for tests and single-process development only. The
credential resolver must return the same stable `accountBindingId` for the same
Store account even if a different game player attempts to use it. If checkout
ends before the durable claim succeeds,
automatic recovery intentionally fails closed because a globally listed Store
item does not contain enough information to attribute it to a game player
safely.

The scoped pending record is removed only after the authority reports a
completed or failed result; a transient exception or pending consume keeps it.
Because a checkout can complete before `listPurchases()` reflects the item, game
services must keep historical `inAppOfferToken` mappings recognizable until
every pending record for that mapping is verified. The durable recovery-owner
binding is only player attribution; the authority must still validate Store
ownership, account binding, and the historical product mapping before granting.

Configure those aliases with `historicalProductMappings` on
`createMicrosoftStorePurchaseBoundary()`. Each logical product entry pairs the
old `inAppOfferToken` with its old Collections `storeId`. Keep the pair until
operational telemetry confirms that no player-scoped pending recovery record or
unconsumed Store entitlement references it; removing it earlier makes a charged
pre-grant checkout unverifiable. Current mappings come from the server-trusted
`inAppOfferTokens` and `storeIds` passed to the boundary, and unknown old tokens
remain rejected.

Pass the same old Digital Goods tokens as `historicalInAppOfferTokens` on the
browser adapter product. That client-side alias lets `listPurchases()` associate
an old unconsumed item with its logical product when its exact durable authority
binding survives but its scoped pending-grant record does not; the server-side
alias remains the authority that permits the corresponding old Collections
product ID. Historical tokens are recovery aliases only and are never offered
by `getProducts()` or used for new checkout.

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
- a stable, non-secret player identifier wired to the browser adapter's
  `getRecoveryScope()` callback, plus a catalog refresh on account changes;
- a public HTTPS Game Services endpoint, durable entitlement ledger, and an
  atomic shared implementation of `MicrosoftStoreRecoveryOwnershipStore`;
- retry and alerting for pending consume finalizations.

The Store commerce wrapper reports Digital Goods IAP availability independently
from leaderboard support. Pass `{ remoteLeaderboard: true }` as the third
argument to `withMicrosoftStoreCommerceAdapter()` only when the game also
installs a real Game Services leaderboard adapter. The wrapper otherwise
preserves the base gateway capability and never infers a leaderboard from IAP
availability. Target availability requires the feature flag plus either the
native or remote capability before delegating calls.

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
