---
npm/@mpgd/capacitor-storekit: minor
---

BREAKING: Commerce v2, PR C4: the v1 provider and recovery driver are removed.

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
  moved into it and stay exported from the package.
