---
npm/@mpgd/capacitor-play-billing: minor (Added)
---

`createCapacitorPlayBillingCommerceProvider` and `createCapacitorPlayBillingServiceProvider` take an optional `purchaseGate` (the adapter's sales switch): asked before a new purchase opens the Play sheet and never during recovery, a refusal is a `failed` result with `ITEM_UNAVAILABLE` and `PURCHASES_PAUSED`. An `accountBinding` lookup that throws a `CommerceError` keeps its code instead of becoming `ACCOUNT_BINDING_REQUIRED`, and every binding failure is answered as a `failed` result whose store code survives the bridge. With an `@mpgd/adapter-capacitor` from before the gate, which would ignore it, the plugin detects the missing gate support (`purchasesPausedStoreCode` is not exported) and refuses every new purchase with `ITEM_UNAVAILABLE` and `PURCHASE_GATE_UNSUPPORTED` (exported as `purchaseGateUnsupportedStoreCode`) instead of selling; recovery is unaffected.
