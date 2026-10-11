---
npm/@mpgd/capacitor-storekit: minor
---

Commerce v2, PR B3: the StoreKit `StoreSdk` and commerce provider.

`@mpgd/capacitor-storekit` adds `createCapacitorStoreKitStoreSdk({ productIds,
sdk?, isIos? })`, a `StoreSdk` from `@mpgd/adapter-capacitor` (now a peer
dependency) over the native StoreKit 2 collector with the App Store profile
(`store: 'app-store'`; consumable and durable, no subscription, no quantity,
`pending`, `restore`, `finish: 'client'`): `fetchProducts` over `getProducts`,
`requestPurchase` over `purchase` with the `app-account-token` binding as the
`appAccountToken` (`purchased`, `launched` for a pending Ask to Buy,
`cancelled`), `getAvailablePurchases` over `getTransactions` listing unfinished
transactions once with `revokedAt` mapped to `state: 'revoked'` and a
malformed transaction reported as a `purchaseError`, `finishTransaction` over
the native finish, `restorePurchases` over `sync`, `transactionUpdated` as
`purchaseUpdated`, and the v1 availability probe as `getAvailability`. Every
purchase carries the StoreKit-verified `signedTransaction` JWS as its `token`.
`storeKitStoreSdkErrorCodeMap` and `capacitorStoreKitErrorCodeMap` map every
`STOREKIT_*` plugin code onto the RFC "Errors" codes.
`createCapacitorStoreKitCommerceProvider({ products, getAppAccountToken,
bundleId?, sdk?, isIos?, mapError? })` builds the `CommerceProvider` with
`authority: { evidence: 'client-token', accountBinding: 'required' }` and
`app-store.signed-transaction.v1` evidence carrying `{ signedTransaction,
transactionId, originalTransactionId?, bundleId? }`
(`appStoreSignedTransactionEvidenceSchema`);
`createCapacitorStoreKitServiceProvider` wraps it for
`createCapacitorPlatformGateway({ providers })`. The native `getTransactions`
payload gains an optional `unfinished` flag (true for `Transaction.unfinished`
entries, false for current non-consumable entitlements) so the v2 list holds
unfinished transactions only. The v1 `createCapacitorStoreKitProvider` is
unchanged; `recoverStoreKitPurchases`, `getRecoverableTransactions`, and
`finishGrantedTransaction` are deprecated in favor of the commerce v2
reconciler (RFC C1).
