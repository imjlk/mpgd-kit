---
npm/@mpgd/capacitor-play-billing: patch (Changed)
---

Bump the pinned OpenIAP Google core to `io.github.hyochan.openiap:openiap-google:4.0.8` (from `4.0.6`). Upstream, `OpenIapStore.finishTransaction` now clears `currentPurchase` so a later collector does not see a finished purchase again; the plugin never finishes on the device (the backend consumes or acknowledges after its ledger grant) and does not read `currentPurchase`, so its behavior is unchanged. Play Billing stays at 9.1.0 and the other transitive dependencies are unchanged.
