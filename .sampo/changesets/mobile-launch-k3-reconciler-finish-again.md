---
npm/@mpgd/game-services: patch (Fixed)
---

The commerce reconciler finishes a consumable again when a `client`-finish store (StoreKit) reports it after its record is `finished`. A store lists a consumable only while it is unfinished, so this covers a transaction whose finish was reported done before StoreKit listed it (an entry the native read skipped as unverifiable, or a list read too early). It uses the journaled ledger entry, at most once per session, and never verifies the purchase again or rewrites the record. Durables and other finish owners are unchanged.
