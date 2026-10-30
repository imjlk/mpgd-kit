---
npm/@mpgd/game-services: minor (Changed)
---

The App Store verifier's `offline-only` mode no longer grants a transaction the backend already knows was refunded or revoked. A client can keep a JWS signed before a refund, and a refund that reaches the backend before the first grant left no ledger grant to reverse, so a pre-refund JWS inside `maxSignedAgeMs` was granted with no reversal behind it.

- `handleAppStoreServerNotification` takes an optional `revocations` recorder (`AppStoreRevocationRecorder`). Every `REFUND` and `REVOKE` of the customer's own one-time purchase is recorded there before the ledger is read, whether or not a grant exists, keyed by the grant's verification id and kept once per key. A recorder outage (`AppStoreDependencyUnavailableError`) answers `retry` (`APP_STORE_REVOCATION_REGISTRY_UNAVAILABLE`) before the ledger is touched. `FAMILY_SHARED` revocations, `REFUND_REVERSED`, and other types record nothing.
- In `offline-only` mode, before a `verified` or `restorable` answer, the verifier looks the grant identity up in `signedTransactionEvidence.revocations` (`AppStoreRevocationLookup`) and refuses a recorded refund or revocation with `APP_STORE_TRANSACTION_REVOKED`, the refusal the commerce reconciler finishes a refunded consumable on. A lookup outage is `pending` (`APP_STORE_REVOCATION_LOOKUP_UNAVAILABLE`).
- New exports: `AppStoreRevocationRecord`, `AppStoreRevocationReason`, `AppStoreRevocationLookup`, `AppStoreRevocationRecorder`, `AppStoreRevocationRegistry`, and `createInMemoryAppStoreRevocationRegistry` (tests and single-process hosts only; a deployment needs a durable registry that both the notification handler and every purchase verifier instance read).

**Breaking for `offline-only` deployments:** `{ mode: 'offline-only', maxSignedAgeMs }` now also requires `revocations`, and construction throws without it. Pass a durable registry, and pass the same registry's recorder to `handleAppStoreServerNotification({ revocations })`. The `server-api` (default) and `ignore` modes are unchanged.
