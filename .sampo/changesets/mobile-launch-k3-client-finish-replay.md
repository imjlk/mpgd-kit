---
npm/@mpgd/game-services: patch (Fixed)
---

The reference backend answers a verify for a consumable of a `client`-finish registry entry (the App Store) that this player already holds under another idempotency key with that recorded grant (`verified`, `alreadyProcessed: true`, the same ledger entry) instead of `EVIDENCE_ALREADY_PROCESSED`. That is the client asking under the derived key once its journal dropped the finished record while StoreKit still lists the transaction; the client can now finish it instead of StoreKit re-delivering it on every launch. Nothing new is granted. Another player, a durable, a reversed grant, and a backend without a registry keep the refusal.
