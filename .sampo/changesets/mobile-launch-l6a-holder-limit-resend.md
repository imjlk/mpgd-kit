---
npm/@mpgd/game-services: patch (Fixed)
---

The commerce reconciler no longer resends a restore the backend answered `pending` with `PURCHASE_HOLDER_LIMIT_REACHED` on every start, resume, and store event. Only the player's next Restore Purchases (`restorePurchases()`) sends the saved request again, since a holder may have been freed by then (a deleted account, a revoked grant); nothing an automatic pass observes frees one. The record stays `pending` for the game to report. Other backend-pending answers, `PURCHASE_HOLDER_CONFLICT` included, keep their retries.
