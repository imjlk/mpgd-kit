---
npm/@mpgd/capacitor-storekit: patch
npm/@mpgd/cli: patch
---

Harden the Capacitor shell and StoreKit finish path. `mpgd target init capacitor` now sets `android:allowBackup="false"` on a freshly generated Android project, and native target builds inject a restrictive Content-Security-Policy meta tag into the staged shell `index.html` unless the game page declares its own. `finishGrantedTransaction` on the StoreKit provider only finishes a transaction with the ledger entry ID that `recoverStoreKitPurchases` recorded from a verified backend answer in the current session.
