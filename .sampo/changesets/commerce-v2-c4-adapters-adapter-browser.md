---
npm/@mpgd/adapter-browser: minor
---

BREAKING: commerce v2, PR C4: the browser adapter drops the v1 commerce
surface and the boolean capabilities. Every gateway now exposes at most one
commerce surface, `gateway.commerce`, a commerce v2 `CommerceProvider`; a
gateway that sells nothing omits it and reports the unsupported commerce block.

Removed, with the replacement:

- The v1 `CommerceAdapter` on every gateway. `createBrowserPlatformGateway()`
  (and the CrazyGames gateway) now has no `commerce` provider and reports
  `createUnsupportedCommerceCapabilities()` (`commerce.availability:
  'unsupported'`) instead of a failing `getProducts` / `purchase` stub.
  `createBrowserPlatformGateway({ mockCommerce: true })` keeps its documented
  invariant (no code path can grant) but is now a small commerce v2 provider:
  store id `browser-mock` (`browserMockCommerceStoreId`), one consumable
  `COINS_100`, `finish: 'none'`, `authority.evidence: 'client-token'`; its
  `requestPurchase` answers `purchased` with a mock `transactionId` and `token`
  and `mpgd.browser.mock-purchase.v1` evidence, with no `settlement`.
- `createMicrosoftStoreCommerceAdapter`, `withMicrosoftStoreCommerceAdapter`,
  `MicrosoftStoreCommerceAdapter`, and `CreateMicrosoftStoreCommerceAdapterInput`
  from `@mpgd/adapter-browser/microsoft-store`. Use
  `createMicrosoftStoreCommerceProvider` and
  `withMicrosoftStoreCommerceProvider` (same input; the wrapper now sets
  `gateway.commerce` and the `commerce` capability block only, with no
  `nativeIap` or `subscriptionIap`) and
  `CreateMicrosoftStoreCommerceProviderInput`.
  `MicrosoftStorePurchaseAuthority.getEntitlements()` is removed: entitlements
  come from the backend ledger, so delete that method from your authority.
  New: `createMicrosoftStoreCommerceCapabilities(availability)`, the pure
  capability declaration the provider returns.
- `createOnePlayCommerceAdapter` from `@mpgd/adapter-browser/oneplay`. Use
  `createOnePlayCommerceProvider({ sdk?, products?, server? })` (store id
  `oneplay`: `purchased` with `oneplay.managed-purchase.v1` evidence, `cancelled`
  for a user cancel, `failed` for the SDK's hard failures, `launched` for an
  unknown, transport, or timeout outcome; `presentation` facts and the
  single-flight rule are unchanged). `OnePlayCommerceServerPort.getEntitlements`
  and `restore` are removed: read the backend ledger, and keep server-record
  restore a game-owned backend concern. `createOnePlayPlatformGateway` always
  installs the provider as `gateway.commerce`. New:
  `createOnePlayCommerceCapabilities(input)`, `onePlayCommerceStoreId`,
  `onePlayManagedPurchaseEvidenceSchema`, and `OnePlayCommerceProvider`.
- The gateways no longer report `nativeIap`, `subscriptionIap`, or
  `providerAvailability.nativeIap`; read `capabilities.commerce`
  (`availability`, `purchase`, `lifecycle`, `authority`).

See `adapters/browser/README.md` ("Migrating from v1"),
`docs/MICROSOFT_STORE_COMMERCE.md`, and `docs/ONEPLAY.md`.

ONE play retries pre-checkout network failures with the original bound identity, and already-owned responses remain open for server reconciliation while releasing the closed native surface.
