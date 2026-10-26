---
npm/@mpgd/capacitor-storekit: patch (Fixed)
---

A restore read (`getAvailablePurchases({ restore: true })`, the reconciler's Restore Purchases) also lists a durable bound to another or no `appAccountToken`, the state of every earlier purchase after a reinstall or on a new iPhone or iPad; before, it was dropped as `account-mismatch` and Restore Purchases sent nothing. Consumables of another token, unmapped SKUs, and kind mismatches stay excluded; recovery reads and native events are unchanged. `finishTransaction` answers `{ finished: true }` without a native call for a listed, non-revoked durable StoreKit already finished (`unfinished: false`), whatever its token, so a purchase the backend shared to this guest no longer retries a finish the native token match refuses; an unfinished transaction of another token is still never finished.
