---
npm/@mpgd/game-services: minor
---

Commerce v2, PR B3: `@mpgd/game-services/app-store-verifier` accepts App
Store signed-transaction evidence.

The verifier accepts request evidence with schema
`app-store.signed-transaction.v1` (`appStoreSignedTransactionEvidenceSchema`,
`createAppStoreSignedTransactionEvidence`; the envelope
`@mpgd/capacitor-storekit`'s commerce v2 provider sends). The client's
StoreKit-verified JWS is first verified offline through the configured
`signedTransactionVerifier` (Apple's `SignedDataVerifier` behind
`createAppleSignedTransactionVerifier`): a tampered JWS is rejected before
any network call, a decoded transaction id that differs from the request's
`platformTransactionId` with `APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH`, and a
non-string, empty, or oversized `signedTransaction` with
`APP_STORE_SIGNED_TRANSACTION_EVIDENCE_INVALID`. Because a JWS is a signed
snapshot that can predate a refund, the grant decision is then taken on the
transaction's current status, selected by the new `signedTransactionEvidence`
option: `{ mode: 'server-api' }` (default) fetches the transaction by id
through the App Store Server API and runs every check (bundle id, product id,
environment, app account token, type, quantity, revocation, upgrade, expiry,
clock) on that fresh payload; `{ mode: 'offline-only', maxSignedAgeMs }` is
the documented opt-in for deployments without Server API access and decides
on the client JWS alone within the `signedDate` freshness window
(`APP_STORE_SIGNED_TRANSACTION_STALE` otherwise); `{ mode: 'ignore' }` fetches
by id for every request. Requests without that evidence keep the Server API
`Get Transaction Info` lookup unchanged, so current clients are unaffected.
`app-store-verifier-conformance` adds
`createAppStoreSignedTransactionEvidenceFixture` for provider adapters.
