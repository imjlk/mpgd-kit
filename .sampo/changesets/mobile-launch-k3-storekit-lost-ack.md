---
npm/@mpgd/capacitor-storekit: patch (Fixed)
---

A consumable whose finish reached StoreKit but whose answer was lost (the app closed between the native finish and the journal write) no longer stays `finishing` forever. `finishTransaction` now answers `{ finished: true }` without a native call for a consumable that `getTransactions` no longer lists, since StoreKit keeps a transaction in `Transaction.unfinished` until `finish()`. A durable missing from the list (revoked or unverifiable) and an entry of that id in a malformed shape still answer `{ finished: false }`. Pair it with the `@mpgd/game-services` release of the same change, whose reconciler finishes such a consumable again if StoreKit lists it later.
