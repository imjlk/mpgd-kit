---
npm/@mpgd/game-services: minor
---

Commerce v2, PR B3: `@mpgd/game-services/app-store-verifier` verifies App
Store signed-transaction evidence offline.

The verifier accepts request evidence with schema
`app-store.signed-transaction.v1` (`appStoreSignedTransactionEvidenceSchema`,
the envelope `@mpgd/capacitor-storekit`'s commerce v2 provider sends): the
`signedTransaction` payload is verified through the configured
`signedTransactionVerifier` (Apple's `SignedDataVerifier` behind
`createAppleSignedTransactionVerifier`) and then checked exactly like a
Server API transaction (bundle id, product id, environment, app account token,
type, quantity, revocation, upgrade, expiry, and clock), with no App Store
Server API call. A decoded transaction id that differs from the request's
`platformTransactionId` is rejected with
`APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH`, and a non-string or empty
`signedTransaction` with `APP_STORE_SIGNED_TRANSACTION_EVIDENCE_INVALID`.
Requests without that evidence keep the Server API `Get Transaction Info`
lookup unchanged, so current clients are unaffected.
