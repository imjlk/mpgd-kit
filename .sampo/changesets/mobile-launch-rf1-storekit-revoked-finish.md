---
npm/@mpgd/capacitor-storekit: patch (Fixed)
---

A consumable the App Store refunded while it was still unfinished is no longer redelivered at every launch forever. The StoreKit SDK declares `acceptsRevokedFinish`, keeps such a transaction listed as `revoked`, and `finishTransaction` with `revoked: true` finishes it, granting nothing, only when the native list carries it as a revoked consumable of a SKU the catalog declares consumable, bound to the session app account token; the native plugin applies the same gate (`StoreKitTransactionPolicy.finishableRevoked`) over `Transaction.unfinished`. A transaction that is not revoked, a durable, another or no token, and a malformed entry stay refused, and an ordinary finish of a revoked transaction is still refused. Rebuild the iOS app (`cap sync ios`) to get the native gate: a native build from before it ignores the flag and leaves the transaction unfinished, as before.
