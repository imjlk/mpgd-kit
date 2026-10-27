---
npm/@mpgd/capacitor-play-billing: minor (Added)
---

`createCapacitorPlayBillingCommerceProvider` and `createCapacitorPlayBillingServiceProvider` take an optional `purchaseGate` (the adapter's sales switch): asked before a new purchase opens the Play sheet and never during recovery, a refusal is a `failed` result with `ITEM_UNAVAILABLE` and `PURCHASES_PAUSED`. An `accountBinding` lookup that throws a `CommerceError` keeps its code instead of becoming `ACCOUNT_BINDING_REQUIRED`, and every binding failure is answered as a `failed` result whose store code survives the bridge.
