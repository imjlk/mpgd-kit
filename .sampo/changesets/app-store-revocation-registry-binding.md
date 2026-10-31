---
npm/@mpgd/game-services: minor (Added)
---

App Store revocation registries can now be shared across Workers and checked against one conformance suite, so an `offline-only` App Store purchase verifier can run apart from the App Store Server Notifications route that records refunds.

- `createAppStoreRevocationLookupOverBinding(binding)` builds the `AppStoreRevocationLookup` for `signedTransactionEvidence.revocations` over a service binding (`AppStoreRevocationLookupBinding`, `findAppStoreRevocation(request)`). The reference game-services Worker serves that binding from D1 on its `GameServicesAppStoreRevocations` entrypoint. The lookup fails closed: if the binding throws, answers `unavailable` or something malformed, returns a record for another grant identity, or the verification aborts, it throws `AppStoreDependencyUnavailableError`, and the purchase stays `pending` (`APP_STORE_REVOCATION_LOOKUP_UNAVAILABLE`).
- `answerAppStoreRevocationLookup(lookup, request, signal?)` serves one lookup as data (`AppStoreRevocationLookupAnswer`: `found`, `absent`, or `unavailable`), because errors lose their class across a binding. `AppStoreRevocationLookupRequest` is the lookup input without its `AbortSignal`.
- `runAppStoreRevocationRegistryConformance({ registry, reopen?, runId?, signal? })` in `@mpgd/game-services/app-store-verifier-conformance` checks a registry against the `AppStoreRevocationRegistry` contract:
  - the latest `revokedAt` per grant identity wins, compared as instants;
  - a redelivery, or an older notification that arrives late, answers `alreadyRecorded: true` and changes nothing;
  - an unparseable `revokedAt` counts as the latest and is never replaced;
  - records read back field for field, through a fresh instance too when `reopen` is given.

  `createInMemoryAppStoreRevocationRegistry` passes it. `appStoreRevocationRegistryConformanceChecks` and `appStoreRevocationRegistryDurabilityCheck` name the rules.
