# @mpgd/capacitor-storekit

## 0.7.2 — 2026-11-01

### Changed

- [a42e13d6](https://github.com/imjlk/mpgd-kit/commit/a42e13d60af5a48213bc8ced63153ea47987335f) Bump the pinned OpenIAP Apple core to `4.0.7` (from `4.0.5`; the SwiftPM pin stays exact). Upstream, the core no longer finishes inactive (expired, revoked, or upgraded) auto-renewable subscription transactions on its own, so it no longer finishes any transaction unless asked (the plugin never enables its automatic finish). The plugin sells only consumables and non-consumables, so purchases, recovery, revocation events, and the finish gate behave as before. A game rebuilding its iOS app resolves the new tag through SwiftPM on the next `cap sync ios`. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.19.2, @mpgd/bridge@0.19.0, @mpgd/game-services@0.34.0, @mpgd/platform@0.35.1

## 0.7.1 — 2026-10-31

### Patch changes

- Updated dependencies: adapter-capacitor@0.19.1, game-services@0.33.1

## 0.7.0 — 2026-10-30

### Fixed

- [cd6b9ceb](https://github.com/imjlk/mpgd-kit/commit/cd6b9ceb313bdd9b9db4a459587f8d073ba35596) A consumable the App Store refunded while it was still unfinished is no longer redelivered at every launch forever. The StoreKit SDK declares `acceptsRevokedFinish`, keeps such a transaction listed as `revoked`, and `finishTransaction` with `revoked: true` finishes it, granting nothing, only when the native list carries it as a revoked consumable of a SKU the catalog declares consumable, bound to the session app account token; the native plugin applies the same gate (`StoreKitTransactionPolicy.finishableRevoked`) over `Transaction.unfinished`. A revoked finish may name no ledger entry; the native method requires the field, so the SDK then sends `revokedLedgerEntryIdPrefix` plus the transaction id, which names no ledger entry. A transaction that is not revoked, a durable, another or no token, a malformed entry, and a transaction the list does not carry (already finished, or not listed yet) stay refused, and an ordinary finish of a revoked transaction is still refused. Rebuild the iOS app (`cap sync ios`) to get the native gate: a native build from before it ignores the flag and leaves the transaction unfinished, as before. — Thanks @imjlk!

### Added

- [f9ebae53](https://github.com/imjlk/mpgd-kit/commit/f9ebae53c77e9c12e6e7edeb3ab7377dbb1b14ab) A durable still unfinished and bound to no `appAccountToken` (an offer code or another purchase made outside the app, then restored and granted by the backend's restore sharing) is now finished once this player's grant is journaled, instead of leaving its record `finishing` and retried on every pass. The native plugin gains an explicit no-token finish match, `finishTransaction({ transactionId, ledgerEntryId, withoutAppAccountToken: true })` with no `appAccountToken` field, which finishes only a verified, non-revoked non-consumable bound to no token; a call without a token and without the flag is still refused with `STOREKIT_FINISH_REQUIRES_GRANT`, so a missing token is never a wildcard. The new native method `getFinishSupport()` declares it (`{ withoutAppAccountToken: 1 }`); new types `StoreKitFinishSupport` and `StoreKitFinishTransactionInput`, and `CapacitorStoreKitStoreSdkPlugin` includes the optional `getFinishSupport`. The StoreKit SDK sends the no-token finish only for a listed, non-revoked `non_consumable` whose SKU the catalog declares durable, for a record the reconciler holds a ledger grant for, and only when the native build declares the match (the native match itself checks only the transaction); with an app binary built from an earlier native plugin (`UNIMPLEMENTED`) it answers `{ finished: false }` as before, so rebuild the app to finish such records. Finishing a durable takes nothing from any player: StoreKit keeps it in `Transaction.currentEntitlements`. Consumables and subscriptions bound to no token are still never finished. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.19.0, @mpgd/bridge@0.18.1, @mpgd/game-services@0.33.0, @mpgd/platform@0.35.0

## 0.6.0 — 2026-10-29

### Added

- [b73b129d](https://github.com/imjlk/mpgd-kit/commit/b73b129d35097331dc6d8de0363191c9cf110dd2) The StoreKit provider reports the purchase sheet (`CommerceProvider.presentation`): the native plugin reports `open` right before `Product.purchase()` and `closed` when it returns or throws (an Ask to Buy is closed when the call returns), `not-started` for a call refused before it. Facts arrive as `purchasePresentation` events and in the `purchase` answer's `presentation`; `getPresentationSupport` declares them. Apple does not document that `Product.purchase()` returns only once the sheet is dismissed, so this is unverified until device testing.
  
  On by default (`purchasePresentation: false` keeps the result-based pause). A web bundle on a native build from before the facts reports the store `configuration-required` and refuses new purchases with `CONFIGURATION_REQUIRED` / `STOREKIT_PRESENTATION_UNSUPPORTED`; recovery is unaffected. An adapter from before the facts sends no presentation id, and purchases run as before. Rebuild the app (`cap sync`) with this version's native code. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.18.0, @mpgd/bridge@0.18.0, @mpgd/game-services@0.32.0, @mpgd/platform@0.34.0

## 0.5.0 — 2026-10-28

### Added

- [c0066ece](https://github.com/imjlk/mpgd-kit/commit/c0066eceb9b8a2d10d4cd311c7eb758883fdb3e0) `createCapacitorStoreKitCommerceProvider` and `createCapacitorStoreKitServiceProvider` take an optional `purchaseGate`, separate from `getAppAccountToken`: it is asked only before a new purchase opens the StoreKit sheet, while recovery, restore, and finishing keep filtering by the app account token alone, so a game can pause new sales without blocking the recovery of paid transactions. A refusal is a `failed` result with `ITEM_UNAVAILABLE` and `PURCHASES_PAUSED`. A token lookup that throws a `CommerceError` keeps its code, and binding failures are answered as `failed` results whose store code survives the bridge. With an `@mpgd/adapter-capacitor` from before the gate, which would ignore it, the plugin detects the missing gate support (`purchasesPausedStoreCode` is not exported) and refuses every new purchase with `ITEM_UNAVAILABLE` and `PURCHASE_GATE_UNSUPPORTED` (exported as `purchaseGateUnsupportedStoreCode`) instead of selling; recovery is unaffected. — Thanks @imjlk!

### Fixed

- [ae7b0f77](https://github.com/imjlk/mpgd-kit/commit/ae7b0f77120c1eb73c92c0249c9048cafa8a9d4f) A consumable whose finish reached StoreKit but whose answer was lost (the app closed between the native finish and the journal write) no longer stays `finishing` forever. On a retried finish (`retry: true`, which the `@mpgd/game-services` reconciler sets for a record that was already `finishing`), `finishTransaction` answers `{ finished: true }` without a native call for a consumable that `getTransactions` no longer lists, since StoreKit keeps a transaction in `Transaction.unfinished` until `finish()`. A first finish keeps the earlier answer (`{ finished: false }` for a missing transaction, since right after a purchase the list may not carry it yet), as does a caller that never sets `retry`. A durable missing from the list (revoked or unverifiable) and an entry of that id in a malformed shape still answer `{ finished: false }`. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.17.0, @mpgd/bridge@0.17.0, @mpgd/game-services@0.31.0, @mpgd/platform@0.33.0

## 0.4.5 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.16.3, @mpgd/game-services@0.30.5

## 0.4.4 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.16.2, @mpgd/game-services@0.30.4

## 0.4.3 — 2026-10-27

### Fixed

- [dd045e6b](https://github.com/imjlk/mpgd-kit/commit/dd045e6b2ce851b48ea8c97e133030730878196a) `finishTransaction` finishes a durable still unfinished under another `appAccountToken` once this player's grant is journaled, instead of refusing it forever. This happens after a crash between an earlier guest's grant and its finish followed by a reinstall (or with a native build that omits `unfinished`): the restore was shared to the new guest, but its record stayed `finishing` and was retried on every pass. The transaction is finished with its own token, read from the native list, so the native token match is unchanged. Finishing a durable takes nothing from any player: StoreKit keeps it in `Transaction.currentEntitlements`, where the earlier guest's own read still finds it. Consumables of another token, transactions bound to no token, and SKUs the catalog does not declare durable are still never finished. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.16.1, @mpgd/game-services@0.30.3

## 0.4.2 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.16.0, @mpgd/bridge@0.16.4, @mpgd/game-services@0.30.2, @mpgd/platform@0.32.0

## 0.4.1 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.15.0, @mpgd/bridge@0.16.3, @mpgd/game-services@0.30.1, @mpgd/platform@0.31.0

## 0.4.0 — 2026-10-26

### Changed

- [706ea874](https://github.com/imjlk/mpgd-kit/commit/706ea87435232974aac23c0f1b630f49f957580f) The iOS plugin now runs on the OpenIAP Apple core (`hyodotdev/openiap` 4.0.5, pinned exactly in `Package.swift`) instead of its own StoreKit 2 code. The Capacitor contract is unchanged: `CapacitorStoreKit`, its methods and `transactionUpdated` event, the payload fields, the `STOREKIT_*` codes, and the finish gate (verified, one-time, not revoked, matching app account token, only after the ledger grant; OpenIAP's auto-finish is never requested). `getTransactions` still lists verified unfinished one-time transactions plus current non-consumable entitlements (`unfinished: false`), never the full history. **Behavior to know:** `getTransactions` and the `finishTransaction` lookup read StoreKit's verified lists directly through a read-only shim (OpenIAP's queries fail as a whole on one unverifiable transaction), so an unverified transaction is skipped on its own as before and never blocks recovering or finishing the others; the lists stay unfiltered by account (the TypeScript SDK admits the session account). The result of a `purchase` call is also emitted as `transactionUpdated` (the reconciler deduplicates); revocations, which OpenIAP does not deliver, still arrive through a small `Transaction.updates` shim. The package also declares the product `MpgdCapacitorStorekit`, the spelling `cap sync ios` links, so a synced shell no longer needs a patch. SwiftPM now resolves the OpenIAP monorepo on first sync. Rollback is pinning the previous plugin version and re-running `cap sync ios`; journals, evidence, and transaction ids are unchanged. Details: `docs/specs/commerce/openiap-migration.md`. — Thanks @imjlk!

### Fixed

- [718801f9](https://github.com/imjlk/mpgd-kit/commit/718801f9b9544fc9be505dc5994cb81974bdea48) A restore read (`getAvailablePurchases({ restore: true })`, the reconciler's Restore Purchases) also lists a durable bound to another or no `appAccountToken`, the state of every earlier purchase after a reinstall or on a new iPhone or iPad; before, it was dropped as `account-mismatch` and Restore Purchases sent nothing. Consumables of another token, unmapped SKUs, and kind mismatches stay excluded; recovery reads and native events are unchanged. `finishTransaction` answers `{ finished: true }` without a native call for a listed, non-revoked durable StoreKit already finished (`unfinished: false`), whatever its token, so a purchase the backend shared to this guest no longer retries a finish the native token match refuses; an unfinished transaction of another token is still never finished. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.14.0, @mpgd/bridge@0.16.2, @mpgd/game-services@0.30.0, @mpgd/platform@0.30.0

## 0.3.10 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.13.0, @mpgd/bridge@0.16.1, @mpgd/game-services@0.29.0, @mpgd/platform@0.29.0

## 0.3.9 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.12.5, @mpgd/bridge@0.16.0, @mpgd/game-services@0.28.1, @mpgd/platform@0.28.0

## 0.3.8 — 2026-10-24

### Patch changes

- Updated dependencies: adapter-capacitor@0.12.4, game-services@0.28.0

## 0.3.7 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.12.3, @mpgd/bridge@0.15.0, @mpgd/game-services@0.27.2, @mpgd/platform@0.27.2

## 0.3.6 — 2026-10-21

### Patch changes

- [e1404d85](https://github.com/imjlk/mpgd-kit/commit/e1404d8538a84c4cdc42e5b90690876208bb30c4) Keep a finished App Store durable listed so a finish that raced the ledger grant can still be verified, and finish a transaction only when its app account token matches the session. `commerce.v2.finishTransaction` uses that same check. A forged ledger entry id paired with a token read from the plugin is still not a signed server finish capability. — Thanks @imjlk!
- Updated dependencies: @mpgd/adapter-capacitor@0.12.2, @mpgd/bridge@0.14.3, @mpgd/game-services@0.27.1, @mpgd/platform@0.27.1

## 0.3.5 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.12.1, @mpgd/bridge@0.14.2, @mpgd/game-services@0.27.0, @mpgd/platform@0.27.0

## 0.3.4 — 2026-10-20

### Patch changes

- Updated dependencies: @mpgd/adapter-capacitor@0.12.0, @mpgd/bridge@0.14.1, @mpgd/game-services@0.26.0, @mpgd/platform@0.26.0

## 0.3.3 — 2026-10-19

### Patch changes

- Updated dependencies: adapter-capacitor@0.11.1, bridge@0.14.0, game-services@0.25.1, platform@0.25.0

## 0.3.2 — 2026-10-19

### Patch changes

- Updated dependencies: adapter-capacitor@0.11.0, bridge@0.13.2, game-services@0.25.0, platform@0.24.0

## 0.3.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-capacitor@0.10.1, bridge@0.13.1, game-services@0.24.1, platform@0.23.1

## 0.3.0 — 2026-10-15

### Minor changes

- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: Commerce v2, PR C4: the v1 provider and recovery driver are removed.
  
  - Removed `createCapacitorStoreKitProvider` and its types
    (`StoreKitProviderOptions`, `StoreKitProductMapping`,
    `CapacitorStoreKitProvider`), the `recoverStoreKitPurchases` driver with
    `StoreKitRecoveryBackend`, `RecoveredStoreKitPurchase`,
    `StoreKitPurchaseVerification`, `StoreKitRecoverySnapshot`,
    `RecoverableStoreKitTransaction`, and `InvalidStoreKitTransaction`, and the
    provider's `getAppAccountToken`, `getRecoverableTransactions`, and
    `finishGrantedTransaction`. Register `createCapacitorStoreKitServiceProvider`
    (or use `createCapacitorStoreKitCommerceProvider`); the `@mpgd/game-services`
    reconciler lists unfinished transactions through `getAvailablePurchases` and
    finishes through `finishTransaction` after the ledger grant.
  - `createCapacitorStoreKitServiceProvider` declares no `features` (it was
    `['nativeIap']`); readiness is the gateway's `commerce` capability block, and
    the gateway exposes the provider as `gateway.commerce`.
  - Added `createStoreKitCommerceCapabilities(availability)`, a pure SDK-free
    function (`src/commerce-profile.ts` imports types only) that returns the
    `CommerceCapabilities` block the provider declares for an availability, plus
    `appStoreStoreId` and `storeKitCommerceAuthority`. The profile constants
    `storeKitStoreSdkCapabilities` and `appStoreSignedTransactionEvidenceSchema`
    moved into it and stay exported from the package. — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-capacitor@0.10.0, bridge@0.13.0, game-services@0.24.0, platform@0.23.0

## 0.2.3 — 2026-10-12

### Patch changes

- [5871a314](https://github.com/imjlk/mpgd-kit/commit/5871a31405de4caddd7fbb5d252b452310dd44df) Commerce v2, PR C3: a shell without the native plugin is a configuration
  problem, not an outage. Capacitor's `UNIMPLEMENTED` answer (the plugin's
  native code is not in the shell) now makes `getAvailability()` report
  `configuration-required` instead of `temporarily-unavailable`, so a generated
  game that registers the store provider before `mpgd target init capacitor
  --providers` installed the plugin runs and opens no purchase UI. — Thanks @imjlk!
- Updated dependencies: adapter-capacitor@0.9.3, game-services@0.23.0

## 0.2.2 — 2026-10-12

### Patch changes

- Updated dependencies: adapter-capacitor@0.9.2, bridge@0.12.3, game-services@0.22.0, platform@0.22.0

## 0.2.1 — 2026-10-12

### Patch changes

- Updated dependencies: adapter-capacitor@0.9.1, bridge@0.12.2, game-services@0.21.1, platform@0.21.0

## 0.2.0 — 2026-10-12

### Minor changes

- [da858335](https://github.com/imjlk/mpgd-kit/commit/da858335c28cd04512df73cf6484bd1d0d35b0b0) Commerce v2, PR B3: the StoreKit `StoreSdk` and commerce provider.
  
  `@mpgd/capacitor-storekit` adds `createCapacitorStoreKitStoreSdk({ products,
  getAppAccountToken, sdk?, isIos?, onDiagnostic? })`, a `StoreSdk` from
  `@mpgd/adapter-capacitor` (now a peer dependency) over the native StoreKit 2
  collector with the App Store profile (`store: 'app-store'`; consumable and
  durable, no subscription, no quantity, `pending`, `restore`,
  `finish: 'client'`): `fetchProducts` over `getProducts`, `requestPurchase`
  over `purchase` with the `app-account-token` binding as the `appAccountToken`
  (`purchased`, `launched` for a pending Ask to Buy, `cancelled`),
  `getAvailablePurchases` over `getTransactions` listing unfinished transactions
  once with `revokedAt` mapped to `state: 'revoked'` and a malformed
  transaction reported as a `purchaseError`, `finishTransaction` over the
  native finish, `restorePurchases` over `sync`, `transactionUpdated` as
  `purchaseUpdated`, and the v1 availability probe as `getAvailability`,
  probing the configured SKUs batch by batch. Every purchase carries the
  StoreKit-verified `signedTransaction` JWS as its `token`.
  `storeKitStoreSdkErrorCodeMap` and `capacitorStoreKitErrorCodeMap` map every
  `STOREKIT_*` plugin code onto the RFC "Errors" codes.
  
  The SDK checks the store product against the catalog's declared kind before
  any purchase sheet opens (`STOREKIT_CONFIGURATION_ERROR` on a kind mismatch,
  `STOREKIT_PRODUCT_UNKNOWN` / `STOREKIT_PRODUCT_UNAVAILABLE` for an unmapped or
  unsold SKU) and verifies the purchased transaction's type against it. It
  lists and emits only transactions of the configured catalog whose signed
  `appAccountToken` is the active player's token and whose type matches the
  catalog kind; excluded transactions are reported through `onDiagnostic`
  (`unmapped-sku`, `account-mismatch`, `kind-mismatch`) and never reach the
  reconciler, so a retired SKU or another player's unfinished purchase cannot
  block a valid sibling or be journaled for the wrong player. The native
  `transactionUpdated` listener is attached while either a `purchaseUpdated`
  or a `purchaseError` subscriber exists.
  
  `createCapacitorStoreKitCommerceProvider({ products, getAppAccountToken,
  bundleId?, sdk?, isIos?, mapError?, onDiagnostic? })` builds the
  `CommerceProvider` with `authority: { evidence: 'client-token',
  accountBinding: 'required' }` and `app-store.signed-transaction.v1` evidence
  carrying `{ signedTransaction, transactionId, originalTransactionId?,
  bundleId? }` (`appStoreSignedTransactionEvidenceSchema`);
  `createCapacitorStoreKitServiceProvider` wraps it for
  `createCapacitorPlatformGateway({ providers })`. The native `getTransactions`
  payload gains an optional `unfinished` flag (true for `Transaction.unfinished`
  entries, false for current non-consumable entitlements) so the v2 list holds
  unfinished transactions only. The v1 `createCapacitorStoreKitProvider` is
  unchanged; `recoverStoreKitPurchases`, `getRecoverableTransactions`, and
  `finishGrantedTransaction` are deprecated in favor of the commerce v2
  reconciler (RFC C1). — Thanks @imjlk!

### Patch changes

- Updated dependencies: adapter-capacitor@0.9.0, bridge@0.12.1, game-services@0.21.0, platform@0.20.0

## 0.1.10 — 2026-10-11

### Patch changes

- Updated dependencies: adapter-capacitor@0.8.0, bridge@0.12.0, game-services@0.20.0, platform@0.19.0

## 0.1.9 — 2026-10-11

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.5, game-services@0.19.1, platform@0.18.0

## 0.1.8 — 2026-10-10

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.4

## 0.1.7 — 2026-10-10

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.3

## 0.1.6 — 2026-10-09

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.2, game-services@0.19.0, platform@0.17.0

## 0.1.5 — 2026-10-09

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.1, game-services@0.18.1, platform@0.16.0

## 0.1.4 — 2026-10-09

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.0, bridge@0.11.0, game-services@0.18.0, platform@0.15.0

## 0.1.3 — 2026-10-04

### Patch changes

- Updated dependencies: adapter-capacitor@0.6.2, game-services@0.17.2

## 0.1.2 — 2026-10-04

### Patch changes

- [a5f74351](https://github.com/imjlk/mpgd-kit/commit/a5f74351f967fe68d887785403d6a86949dc08dc) Harden the Capacitor shell and StoreKit finish path. `mpgd target init capacitor` now opts a freshly generated Android project out of cloud backups and Android 12+ device-to-device transfers: it sets `android:allowBackup="false"`, `android:fullBackupContent="@xml/backup_rules"` and `android:dataExtractionRules="@xml/data_extraction_rules"` on the manifest and writes both rule resources, which exclude the `root`, `file`, `database`, `sharedpref` and `external` domains. Native target builds inject a restrictive Content-Security-Policy meta tag into the staged shell `index.html` unless the game page already declares an enforcing `Content-Security-Policy` meta tag (a report-only policy does not count). `finishGrantedTransaction` on the StoreKit provider only finishes a transaction with the ledger entry ID that `recoverStoreKitPurchases` recorded from a backend answer in the current session, consumes that pair before the native call so overlapping finishes share one native call, and restores it when the native finish fails. This binds finishing to the recovery flow and blocks arbitrary or accidental finish calls; it is not a trust boundary against code that controls the recovery backend object, where the server-side `recoverPurchase` verification remains the real control. — Thanks @imjlk!
- Updated dependencies: adapter-capacitor@0.6.1, game-services@0.17.1

## 0.1.1 — 2026-09-28

### Patch changes

- [ad66eaf0](https://github.com/imjlk/mpgd-kit/commit/ad66eaf0659b3fce6cacbcec609409479aea0985) Enable automated releases for the separately registered Play Billing and StoreKit Capacitor plugins. — Thanks @imjlk!
- Updated dependencies: adapter-capacitor@0.6.0, game-services@0.17.0, platform@0.14.0

