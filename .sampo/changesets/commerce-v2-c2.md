---
npm/@mpgd/game-services: minor
---

Commerce v2, PR C2: the server side of the protocol. Open store ids, the
evidence registry, the provider capabilities endpoint, revocation entries,
and the lookup verifiers for the server-push stores.

- Open store ids (RFC "Open store ids"): `VerifyPurchaseRequest.store?:
  StoreId` names the store a purchase was made in; `target` stays the ledger
  (deployment) target. `GameServicesStoreTarget` is now `StoreId` and the
  request validator accepts any bounded kebab-case identifier for `target`
  and `store` (`assertCommerceStoreId`); the closed v1 list lives on as the
  deprecated `GameServicesLegacyStoreTarget` until C4. A request without
  `store` keeps its v1 meaning through `resolveLegacyCommerceStoreId`:
  `android` is `google-play`, `ios` is `app-store`, `ait` is `apps-in-toss`,
  `reddit` is `devvit`, and every other target is its own store id. Every
  grant payload now records `store` and `evidenceSchema`.
- Evidence registry (`@mpgd/game-services/commerce-evidence-registry`):
  `createCommerceEvidenceRegistry(entries, { unregistered? })` routes verify
  requests by `evidence.schema` to the entry that claims it, answers
  `EVIDENCE_SCHEMA_UNSUPPORTED` for an unknown schema and
  `EVIDENCE_SCHEMA_STORE_MISMATCH` for a schema registered to another store
  before any verifier runs, fails construction when a `finish: 'server'` entry
  has no finalizer, when two entries claim one schema, when one store declares
  two finish owners, or when two entries of a store accept a missing envelope,
  and finalizes grants through the owning entry (the schema and store the
  grant recorded first, then the request schema, then the store's single
  finalizing entry; a grant recorded under another store than its schema
  stays `pending` with `PURCHASE_FINALIZER_STORE_MISMATCH`). Entries may
  declare `targets` (the ledger targets their requests name;
  `EVIDENCE_SCHEMA_TARGET_MISMATCH` otherwise; the reference entries pin
  theirs) and `acceptsUnclaimedSchemas` (one per store: a verifier binding
  that keeps its own schema list). The optional `unregistered` fallback keeps
  a deployment's aggregate v1 verifier for stores without an entry (never for
  a store that has one) and declares the stores it serves (`stores`, published
  by the capabilities endpoint without schemas; absent, it serves any store
  without entries and publishes nothing for them). `registry.stores` and
  `registry.servesUndeclaredStores` expose that, and the backend answers a
  400 for a store it does not serve or a target that is neither a ledger
  target nor a served store, as an unknown v1 target was a 400. Reference
  entries:
  `createGooglePlayCommerceEvidenceEntry` (`google-play.product-purchase.v2`,
  `finish: 'server'`), `createAppStoreCommerceEvidenceEntry`
  (`app-store.signed-transaction.v1`, `finish: 'client'`, accepts a missing
  envelope for the Server API lookup), `createMicrosoftStoreCommerceEvidenceEntry`
  (`mpgd.microsoft-store.digital-goods.v1`, `finish: 'server'`),
  `createAppsInTossCommerceEvidenceEntry` (`apps-in-toss.iap.callback.v1`,
  `finish: 'host'`), `createDevvitPaymentOrderCommerceEvidenceEntry`
  (`devvit.payment-order.v1`, the fulfillment handler's own record, bound
  through a `DevvitPaymentOrderAuthority` port), and the server-push lookups
  `createDevvitOrderLookupCommerceEvidenceEntry` (`devvit.order.v1`) and
  `createVerse8Agent8EventLookupCommerceEvidenceEntry`
  (`verse8.agent8-event.v1`) over `createCommerceLedgerLookupVerifier`, which
  never grants from the client envelope: it answers the grant the host's
  fulfillment path wrote for the same store and transaction id when it belongs
  to the requesting player and product and is not reversed (`settled`),
  `pending` (`LEDGER_GRANT_PENDING`) before that write, and `rejected` for a
  transaction, product, or player mismatch. `createServerPushLedgerGrant`
  builds the grant those lookups read (`quantity` scales a currency or
  resource grant and is recorded in the payload); `createGameServicesBackend`
  takes `commerceEvidenceRegistry` and, without one, keeps the v1 single
  verifier and finalizer unchanged; passing `purchaseGrantFinalizer` next to a
  registry throws (pass it as `unregistered.finalizer`).
- `EvidenceVerificationDecision` gains the `settled` member
  (`{ status: 'settled', ledgerEntryId, ledgerTarget? }`): the backend
  answers `verified` with that entry and `alreadyProcessed: true` after
  checking it belongs to the requesting player, product, and ledger target
  (`LEDGER_GRANT_IDENTITY_MISMATCH` otherwise) and writes nothing; a
  rewarded-ad verifier answering it is a verifier error. An exhaustive switch
  over the decision must handle it. A same-key retry of a grant a `revoke`
  entry reversed answers `rejected` with `LEDGER_GRANT_REVERSED`, as the
  lookup path does, and a grant written without a deployment target (a host
  fulfillment path) meets a request bound to one.
- Provider capabilities endpoint (RFC "Provider capabilities endpoint"):
  `PurchaseVerificationApi.getCommerceCapabilities?()` answers
  `CommerceServiceCapabilities` derived from the registry (one row per store
  with its schemas, finish owner, and purchase kinds); the reference backend
  offers it only with a registry, through `POST
  /game-services/purchases/capabilities` and oRPC `commerce.getCapabilities`
  (`NOT_FOUND` otherwise). `compareCommerceServiceCapabilities` is the client
  comparison, and the reconciler applies it at start and on explicit passes:
  a store the backend does not accept, a finish owner that disagrees, or
  another protocol major sets the provider's availability to
  `configuration-required` (`CommerceReconciler.getCapabilities()`,
  `serviceAlignment`), reports a `capabilities` failure, and
  `requestPurchase` refuses with `CONFIGURATION_REQUIRED` before any store UI
  opens; a purchase before `start()` attempts the comparison first, the read
  is bounded by `serviceCapabilitiesTimeoutMs` (default ten seconds) and a
  timed-out read keeps the last comparison, and a backend that answers 404 /
  `NOT_FOUND` is remembered as `unpublished` rather than read again. The
  reconciler's verify requests now carry `store`, and its revocation pass
  reads ledger status in chunks of at most 100 ids scoped to its player.
- Revocation and expiry entries (RFC "Revocation and expiry entries"):
  `GameServicesStore` gains the optional `recordEntitlementRevocation`,
  `findEntitlementRevocations`, and the batched `getEntitlementTransactions`
  (the in-memory store implements all three; a grant is reversed once, a
  replayed notification key answers the first entry, a key reused for another
  grant throws `RevocationKeyConflictError`, a reused authority identity
  throws `EvidenceAlreadyProcessedError`, and an unknown grant is refused, as
  the D1 store does),
  `EntitlementLedgerRevocation` / `EntitlementRevocationTransaction` with
  `reason: refund | chargeback | voided | admin`, and the subscription
  `EntitlementLedgerPeriod` shape (validator only; no writer yet).
  `@mpgd/game-services/commerce-ledger` adds `revokeEntitlementGrant` (the
  notification handlers' write path, answering `key_conflict` and
  `evidence_already_processed` next to `grant_not_found` and
  `grant_mismatch`), `readPurchaseLedgerStatuses` (one status per requested
  id in request order, batched reads in chunks of `ledgerReadChunkSize`, and
  scoped to `PurchaseLedgerStatusRequest.playerId` when named: another
  player's entry answers `unknown`), `listActiveEntitlementTransactions`
  (entitlement reads subtract reversed grants), and `isEntitlementGrantReversed`.
  `PurchaseVerificationApi.getPurchaseLedgerStatus` is served by the reference
  backend over `POST /game-services/purchases/ledger-status` and oRPC
  `commerce.getPurchaseLedgerStatus` (bounded by
  `maxPurchaseLedgerStatusEntries`), so the C1 reconciler's revocation pass is
  live. A refund that arrives before its fulfillment answers
  `grant_not_found` and leaves no tombstone: the handler must retry it, or
  the fulfillment path must check the refund feed before granting. `@mpgd/game-services/platform-order` adds
  `createPlatformOrderLedgerGrant`, `createPlatformOrderVerifyRequest`, and
  `revokePlatformOrder` (a `normalizeDevvitRefundOrder` result writes the
  `revoke` entry for the order's grant under `reddit:<orderId>:refund`).
- `gameServicesBackendEndpoints` gains `getPurchaseLedgerStatus` and
  `getCommerceCapabilities`; the HTTP and oRPC backend adapters implement
  both reads.

Tests: `commerce-registry-routing.test.ts`, `commerce-registry-server.test.ts`,
and `commerce-ledger-revocation.test.ts`, plus the reconciler alignment case.
