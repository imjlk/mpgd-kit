---
npm/@mpgd/target-config: patch (Fixed)
---

The commerce provider `withTargetAvailability` builds now keeps the source provider's `acceptsFinishRetry` and `acceptsRevokedFinish`. It forwarded `finishTransaction` unchanged but dropped both declarations, so a reconciler behind it never sent the retried-finish hint or the revoked finish of a refunded, still-unfinished StoreKit consumable.
