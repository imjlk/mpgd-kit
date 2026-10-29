---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/adapter-capacitor: minor (Added)
---

`FinishTransactionInput` (and the `commerce.v2.finishTransaction` bridge payload) takes an optional `revoked`: finish a transaction the store revoked (refunded) while it was still unfinished, without any grant, once the backend has answered for it. `ledgerEntryId` then names that answer (the reversed grant's entry, or the refused idempotency key). `CommerceProvider.acceptsRevokedFinish` gates it the way `acceptsFinishRetry` gates `retry`. `createStoreCommerceProvider` declares it, forwards the flag, and keeps the SDK's revoked purchases in `getAvailablePurchases` (state `revoked`) only for a `StoreSdk` that declares `acceptsRevokedFinish`; a `revoked` finish sent to any other SDK answers `{ finished: false }` without calling it. A bridge host on an earlier `@mpgd/platform` rejects the unknown field, so update the host and the webview together.
