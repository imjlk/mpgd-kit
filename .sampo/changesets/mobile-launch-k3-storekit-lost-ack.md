---
npm/@mpgd/capacitor-storekit: patch (Fixed)
---

A consumable whose finish reached StoreKit but whose answer was lost (the app closed between the native finish and the journal write) no longer stays `finishing` forever. On a retried finish (`retry: true`, which the `@mpgd/game-services` reconciler sets for a record that was already `finishing`), `finishTransaction` answers `{ finished: true }` without a native call for a consumable that `getTransactions` no longer lists, since StoreKit keeps a transaction in `Transaction.unfinished` until `finish()`. A first finish keeps the earlier answer (`{ finished: false }` for a missing transaction, since right after a purchase the list may not carry it yet), as does a caller that never sets `retry`. A durable missing from the list (revoked or unverifiable) and an entry of that id in a malformed shape still answer `{ finished: false }`.
