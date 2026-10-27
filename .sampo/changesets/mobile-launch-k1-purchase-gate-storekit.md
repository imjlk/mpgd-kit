---
npm/@mpgd/capacitor-storekit: minor (Added)
---

`createCapacitorStoreKitCommerceProvider` and `createCapacitorStoreKitServiceProvider` take an optional `purchaseGate`, separate from `getAppAccountToken`: it is asked only before a new purchase opens the StoreKit sheet, while recovery, restore, and finishing keep filtering by the app account token alone, so a game can pause new sales without blocking the recovery of paid transactions. A refusal is a `failed` result with `ITEM_UNAVAILABLE` and `PURCHASES_PAUSED`. A token lookup that throws a `CommerceError` keeps its code, and binding failures are answered as `failed` results whose store code survives the bridge.
