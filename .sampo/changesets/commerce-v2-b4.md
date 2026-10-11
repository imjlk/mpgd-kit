---
npm/@mpgd/adapter-browser: minor
npm/@mpgd/game-services: patch
---

Commerce v2, PR B4: the Microsoft Store commerce provider.

`@mpgd/adapter-browser/microsoft-store` adds
`createMicrosoftStoreCommerceProvider(input)`, a `CommerceProvider` with
`store: 'microsoft-store'` over the same Digital Goods engine as the v1
`createMicrosoftStoreCommerceAdapter`, which keeps its behaviour and input
unchanged. The capability block follows the RFC profile: consumable only,
products with localized prices, `availablePurchases`, `restore`, `events`,
`finish: 'server'` (no `finishTransaction`; the backend consume finalizer
finishes), `pending: false` (Microsoft has no store-side pending state; scoped
recovery records are listed as `purchased`), and `authority: { evidence:
'adapter-settled', accountBinding: 'required' }`. `fetchProducts` maps
`getDetails()` to `StoreProduct`; `requestPurchase` runs the
`claimRecoveryOwnership` → Payment Request → `verifyAndGrant` flow and answers
`purchased` with `settlement: { ledgerEntryId }` on a grant, `launched` while
the authority answer is open or the Store has not listed the purchase,
`cancelled` for a dismissed sheet, and `failed` with the client outcome code as
`storeCode` (`MICROSOFT_STORE_*`, `microsoftStoreCommerceErrorCodeMap`)
otherwise; `getAvailablePurchases` lists `listPurchases()` items plus scoped
recovery records with `settlement` on purchases granted this session for the
same checkout key and player scope; `restorePurchases` replays recovery without
the v1 entitlement read and emits `purchaseUpdated` and `purchaseError` events,
buffered before the first subscriber; a buffered settlement is delivered only
to the player scope that restored it. A throwing availability probe degrades
`getCapabilities` to `temporarily-unavailable` and surfaces as a retryable
`STORE_UNAVAILABLE` from the other operations. `StorePurchase.transactionId`
and `token` are the Digital Goods `purchaseToken`, which the server boundary
already matches. The provider never grants: `settlement` is the authority's
ledger pointer.

`withMicrosoftStoreCommerceProvider(gateway, provider, options)` installs the
provider as `commerceV2`, serves v1 `commerce` through `toCommerceAdapter`,
adds the `commerce` capability block with `nativeIap`/`subscriptionIap` derived
from it, and replaces ads with the unavailable adapter like
`withMicrosoftStoreCommerceAdapter`. A gateway that migrates to this wiring
sees the wrapper's v1 surface instead of the v1 adapter's: `getEntitlements()`
and `restore().restoredEntitlements` are empty (entitlements come from the
ledger), `restore()` returns `settledPurchases` and rejects when Digital Goods
fails instead of resolving empty, and a checkout whose Store identity is bound
to another player is `failed` (`ACCOUNT_BINDING_REQUIRED`) instead of
`pending`. `withMicrosoftStoreCommerceAdapter` and the v1 adapter are
unchanged. The `adapter-settled` conformance vector passes directly and through
the gateway.

`@mpgd/game-services`: the client grants a completed purchase with
`authoritativeGrant` without a second verification when the gateway's
`commerceV2` provider declares `authority.evidence: 'adapter-settled'`
(`findAdapterSettledGrant`; the declaration is read once per provider instance
and cached, a failed read is retried on the next checkout), and the ledger
entry is taken from `authoritativeGrant.ledgerEntryId`. Gateways without
`commerceV2` keep the target-name rule;
`isAuthoritativeMicrosoftStoreCompletion` is deprecated for removal in C4.
