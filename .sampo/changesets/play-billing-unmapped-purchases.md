---
npm/@mpgd/capacitor-play-billing: patch
---

Unfinished Google Play purchases whose SKU is no longer in the client catalog, and purchases that name more than one product id, are listed and emitted with their token and product ids. The reconciler can submit a retired SKU when a logical id is still known. Otherwise it fails that purchase's catalog lookup visibly instead of dropping the token. The client still does not acknowledge or consume; the server finalizer does that only after a ledger grant, and it has no path that can acknowledge a token without a logical product id.
