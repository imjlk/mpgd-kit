---
npm/@mpgd/game-services: minor (Added)
---

App Store revocation registries can now be shared across Workers and checked against one conformance suite, so an `offline-only` App Store purchase verifier can run apart from the App Store Server Notifications route that records refunds.

- `createAppStoreRevocationLookupOverBinding(binding)` builds the `AppStoreRevocationLookup` for `signedTransactionEvidence.revocations` over a service binding (`AppStoreRevocationLookupBinding`, `findAppStoreRevocation(request)`). The reference game-services Worker serves that binding from D1 on its `GameServicesAppStoreRevocations` entrypoint. The lookup fails closed: if the binding throws, answers `unavailable` or something malformed, returns a record for another grant identity or environment, or the verification aborts, it throws `AppStoreDependencyUnavailableError`, and the purchase stays `pending` (`APP_STORE_REVOCATION_LOOKUP_UNAVAILABLE`).
- `answerAppStoreRevocationLookup(lookup, request, signal?)` serves one lookup as data (`AppStoreRevocationLookupAnswer`: `found`, `absent`, or `unavailable`), because errors lose their class across a binding. `AppStoreRevocationLookupRequest` is the lookup input without its `AbortSignal`.
- `runAppStoreRevocationRegistryConformance({ registry, reopen?, runId?, signal? })` in `@mpgd/game-services/app-store-verifier-conformance` checks a registry against the `AppStoreRevocationRegistry` contract:
  - the latest `revokedAt` per environment and grant identity wins, compared as instants;
  - a Sandbox record never answers a Production lookup for the same verification id, and the reverse;
  - a redelivery, or an older notification that arrives late, answers `alreadyRecorded: true` and changes nothing;
  - an unparseable `revokedAt` counts as the latest and is never replaced;
  - records read back field for field, through a fresh instance too when `reopen` is given.

  `createInMemoryAppStoreRevocationRegistry` passes it. `appStoreRevocationRegistryConformanceChecks` and `appStoreRevocationRegistryDurabilityCheck` name the rules.

Revocation registries are now keyed by environment and verification id. `AppStoreRevocationLookup` and `AppStoreRevocationRecorder` document the environment as part of the key, and `createInMemoryAppStoreRevocationRegistry` keeps Production and Sandbox records apart. A production deployment that grants sandbox purchases (`sandboxPurchases: { mode: 'grant' }`) records both environments. Apple documents a transaction id as unique without scoping it to one environment, so the environment is part of the key. A custom registry should key the same way; the conformance suite checks it.
