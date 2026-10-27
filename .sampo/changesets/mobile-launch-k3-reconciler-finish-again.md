---
npm/@mpgd/game-services: patch (Fixed)
---

The commerce reconciler marks a `client` finish of a record that was already `finishing` (an earlier attempt or session) with `retry: true`, so StoreKit can close a lost acknowledgement; the first finish after the grant never carries it. It also finishes a consumable again when a `client`-finish store reports it after its record is `finished`. A store lists a consumable only while it is unfinished, so this covers a transaction whose finish was reported done before StoreKit listed it (an entry the native read skipped as unverifiable). It uses the journaled ledger entry, at most once per session (a transport failure is retried on the next report), and never verifies the purchase again or rewrites the record. Durables and other finish owners are unchanged.
