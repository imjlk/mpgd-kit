# @mpgd/capacitor-storekit

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

