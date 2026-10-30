# Game Services Backend

The reusable monetization and social path is ledger-first:

1. A target adapter collects platform evidence.
2. `@mpgd/game-services` submits that evidence to backend APIs.
3. Backend game services decide whether a grant or score is accepted.
4. Game save state changes only after the backend response is accepted.

This keeps client callbacks from becoming the source of truth.

For deployment steps, D1 setup, public HTTP/oRPC smoke, and service binding
examples, see [Cloudflare Worker Deploy Runbook](CLOUDFLARE_WORKER_DEPLOY.md).
For content-scoped leaderboards written only after authoritative game completion,
see [Verified Leaderboard Service Boundary](VERIFIED_LEADERBOARD_SERVICE.md).
For real Google Play, App Store, AdMob SSV, Apps in Toss, and leaderboard
verifier follow-ups, see
[Production Integration Roadmap](PRODUCTION_INTEGRATION_ROADMAP.md).

## Packages

- `@mpgd/game-services`: reusable client orchestration, oRPC v2 beta contract,
  authoritative backend implementation, async `GameServicesStore` interface,
  memory store, JSON endpoint handler, oRPC router, fetch handler helpers, and
  typed request/response contracts. Its `verified-leaderboard` subpath also
  provides separate read and trusted-write ports for authoritative per-content
  rankings, while `verified-leaderboard-transport` adds an authenticated,
  cursor-paginated read-only fetch surface without a public score-submit route.
- `@mpgd/analytics`: optional typed event sink used by game-services client and
  server paths to record purchase, rewarded ad, and leaderboard outcomes.
- `@mpgd/catalog`: product catalog and ad placement schemas consumed by the
  game-services backend before any grant is accepted.
- `apps/game-services-worker`: Cloudflare Worker starter. It exposes public
  `/game-services/*` JSON endpoints, `/rpc/*` oRPC procedures, `/health`, and
  `WorkerEntrypoint` methods for service binding RPC.

The lower-level verifier and ledger modules remain private workspace packages.
They are implementation detail behind `@mpgd/game-services`, not packages a game
developer needs to install directly.

The in-repo demo uses an in-process backend handler with the memory
`GameServicesStore`. Production should replace the in-process transport with
`createGameServicesFetchBackendTransport()` or `createGameServicesOrpcClient()`
and serve the same contract from a backend.

## Backend Boundary

Client code should create a `GameServicesBackendApi` through one of these paths.
For direct JSON endpoints:

```ts
import {
  createGameServicesFetchBackendTransport,
  createGameServicesHttpBackendApi,
} from '@mpgd/game-services';

const backend = createGameServicesHttpBackendApi({
  transport: createGameServicesFetchBackendTransport({
    baseUrl: 'https://api.example.com',
  }),
});
```

For oRPC:

```ts
import {
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
} from '@mpgd/game-services';

const backend = createGameServicesOrpcBackendApi(
  createGameServicesOrpcClient({
    url: 'https://api.example.com/rpc',
  }),
);
```

Local demos and tests can use the same client-facing API with an in-process
handler:

```ts
import {
  createGameServicesBackendApiHandler,
  createDevelopmentGameServicesEvidenceVerifier,
  createGameServicesHttpBackendApi,
  createInProcessGameServicesBackendTransport,
} from '@mpgd/game-services';

const backend = createGameServicesHttpBackendApi({
  transport: createInProcessGameServicesBackendTransport(
    createGameServicesBackendApiHandler({
      catalog,
      placements,
      store,
      evidenceVerifier: createDevelopmentGameServicesEvidenceVerifier(),
    }),
  ),
});
```

The development verifier is intentionally insecure and belongs only in local
demos and tests. Production backends must install a provider verifier.

For App Store purchases, `@mpgd/game-services/app-store-verifier` provides a
fail-closed `GameServicesEvidenceVerifier` and a stream-bounded App Store Server
API client. The client calls Apple's fixed production or sandbox
[`Get Transaction Info`](https://developer.apple.com/documentation/appstoreserverapi/get-transaction-info)
endpoint using a freshly generated bearer token supplied at runtime according
to Apple's
[`Generating JSON Web Tokens for API requests`](https://developer.apple.com/documentation/appstoreserverapi/generating-json-web-tokens-for-api-requests)
contract. It never accepts App Store credentials, private keys, or signed
authorization tokens from a game client or checked-in configuration. Connect
`AppStoreSignedTransactionVerifier` to a verifier that validates Apple's JWS
certificate chain and signature before returning the decoded transaction
payload; `createAppleSignedTransactionVerifier` from
`@mpgd/game-services/app-store-server` (over the optional
`@apple/app-store-server-library` peer) is that production implementation. The
former `@mpgd/adapter-capacitor/app-store-server` re-export was removed in
commerce v2 PR C4; import it from `@mpgd/game-services/app-store-server`.
The bearer-token provider receives the request `AbortSignal`; it should throw
`AppStoreDependencyUnavailableError` only for a transient signing dependency
outage and let cancellation, invalid credentials, and programming errors
propagate.

Commerce v2 clients (`@mpgd/capacitor-storekit`'s
`createCapacitorStoreKitCommerceProvider`, RFC B3) submit the
StoreKit-verified JWS as request evidence with schema
`app-store.signed-transaction.v1` (`appStoreSignedTransactionEvidenceSchema`;
`createAppStoreSignedTransactionEvidence` builds the envelope). The verifier
first checks that JWS offline through the same `signedTransactionVerifier`:
a tampered JWS is rejected before any network call, a decoded transaction id
that differs from the request's `platformTransactionId` is rejected with
`APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH`, and a missing or oversized
`signedTransaction` with `APP_STORE_SIGNED_TRANSACTION_EVIDENCE_INVALID`.
A valid client JWS is a signed snapshot, not the current status: a player
can retain a JWS signed before a refund, and that JWS carries no
`revocationDate`. The grant decision is therefore taken on the transaction's
current status, selected by `signedTransactionEvidence`:

- `{ mode: 'server-api' }` (default): after the offline check, the
  transaction is fetched by id through `Get Transaction Info` and every
  check below runs on that fresh payload, so a refund after signing is
  rejected (`APP_STORE_TRANSACTION_REVOKED`) and a Server API outage stays
  `pending`, never a grant.
- `{ mode: 'offline-only', maxSignedAgeMs, revocations }`: for deployments
  without Server API access only. The client JWS decides; its `signedDate`
  must be within `maxSignedAgeMs` of the verifier clock
  (`APP_STORE_SIGNED_TRANSACTION_STALE` otherwise). A JWS signed before a
  refund still reads as purchased, and a refund that reaches the backend
  before the first grant leaves no ledger grant to reverse, so this mode
  requires `revocations`, an `AppStoreRevocationLookup` (construction throws
  without it). Before a grant (or a `restorable` answer) the verifier looks
  the grant identity up there and, when a refund or revocation is recorded,
  refuses a JWS signed at or before its `revokedAt` plus `clockSkewMs` (the
  skew widens the refusal) with `APP_STORE_TRANSACTION_REVOKED`, the reason
  the commerce reconciler finishes a refunded consumable on. A record whose
  `revokedAt` does not parse refuses every JWS. A JWS signed later carries
  its own `revocationDate` while the refund stands (refused by the payload
  checks); one without it shows that Apple reversed the refund, and passes,
  as a Server API verifier would grant it. A lookup outage
  (`AppStoreDependencyUnavailableError`) is `pending`
  (`APP_STORE_REVOCATION_LOOKUP_UNAVAILABLE`). The registry is filled by
  `handleAppStoreServerNotification({ revocations })` (below), so it must be
  a durable store both read: `createInMemoryAppStoreRevocationRegistry` is
  for tests and single-process hosts only. The remaining risk: a refund
  Apple has not notified yet is accepted until the window closes; its
  notification then reverses the grant.
- `{ mode: 'ignore' }`: the evidence is not read and the transaction is
  fetched by id for every request.

A request without that evidence, or with another schema, keeps the
`Get Transaction Info` lookup unchanged, so current clients are unaffected.
A `GAME_SERVICES_IOS_EVIDENCE_VERIFIER` service binding receives the request
with its `evidence`, so a deployment behind that binding must construct its
verifier with a `signedTransactionVerifier` able to verify client-supplied
JWS (`createAppleSignedTransactionVerifier` is) for the offline check.

The verifier matches the signed transaction to the configured bundle and
environment, the catalog's platform product and type, the submitted transaction
identifier, and a valid non-nil UUID `appAccountToken` resolved server-side for
the authenticated player. UUID text is compared canonically so letter case
doesn't change the account identity. The client `purchasedAt` value is only a
sanity-checked observation timestamp generated after the platform purchase
resolves;
Apple's signed `purchaseDate` remains authoritative and is retained in ledger
evidence together with the effective quantity. Because the shared grant contract
represents one catalog grant, any signed quantity must be `1`; omission keeps
StoreKit's default single-purchase semantics.
Revoked, upgraded, expired, mismatched, malformed, or invalidly signed
transactions are rejected before the entitlement ledger.
Malformed App Store Server API `200` responses and fresh transaction lookup
misses remain pending for retry, while malformed payloads returned as verified
by the signed-transaction adapter are rejected. Non-consumable replay identity
uses Apple's `originalTransactionId`; consumables continue to use each purchase's
current `transactionId` so distinct purchases remain grantable.
Provider outages, rate limits, account-binding outages, and authorization-provider
outages return a retryable pending decision and do not grant. Caller cancellation
continues to propagate instead of being converted into a retryable outage.
Provider ports should throw `AppStoreDependencyUnavailableError` only for
explicit transient dependency failures. Unexpected adapter exceptions and
invalid runtime values propagate to the outer verifier boundary as errors
instead of being silently converted into an infinite retry loop.
Use distinct deployments or runtime configuration for Apple's production and
sandbox environments (unless a production deployment opts into App Review
sandbox purchases, below); never select the authority from an untrusted
client payload.

#### App Review and TestFlight purchases on a production backend

App Review tests the production build with sandbox purchases, and TestFlight
uses the sandbox too, so a production verifier that refuses sandbox
transactions fails the reviewer's purchase (guideline 2.1). Apple's documented
order is production first, then sandbox: its
[`verifyReceipt`](https://developer.apple.com/documentation/appstorereceipts/verify-receipt)
best practice is to call the production URL first and verify in the sandbox
only on status `21007`, so one server works in testing, during App Review,
and live;
[TN3122](https://developer.apple.com/documentation/technotes/tn3122-receipt-validation-with-the-app-store-fails-with-a-non-zero-error-code)
repeats it; and the App Store Server API answers
[`TransactionIdNotFoundError`](https://developer.apple.com/documentation/appstoreserverapi/transactionidnotfounderror)
when a transaction id is looked up in the other environment. The kit applies
that order to the JWS-based verifier with an explicit option:

```ts
const verifier = createAppStoreGameServicesEvidenceVerifier({
  bundleId,
  environment: 'Production',
  serverApi, // createAppStoreServerApiClient: one client serves both hosts
  signedTransactionVerifier: createAppleSignedTransactionVerifier({
    rootCertificates, environment: 'Production', bundleId, appAppleId,
  }),
  resolveAppAccountToken,
  sandboxPurchases: {
    mode: 'grant',
    signedTransactionVerifier: createAppleSignedTransactionVerifier({
      rootCertificates, environment: 'Sandbox', bundleId,
    }),
  },
});
```

- The default is `sandboxPurchases: { mode: 'reject' }`: a production verifier
  answers `APP_STORE_ENVIRONMENT_MISMATCH` for a sandbox transaction, as before.
  A production iOS deployment that goes through App Review sets `mode: 'grant'`.
- With `mode: 'grant'`, a client JWS is verified by the production verifier
  first. Only when that verifier places it in the sandbox (Apple's adapter
  answers `APP_STORE_ENVIRONMENT_MISMATCH` after the signature check) is it
  verified again, in full, by the sandbox verifier, and its current status is
  read from the sandbox Server API. A request without a client JWS is looked up
  in production first and in the sandbox only after `APP_STORE_TRANSACTION_NOT_FOUND`.
  A client JWS the production verifier accepted is never looked up in the
  sandbox; a Server API answer from another environment than the client JWS is
  `APP_STORE_SIGNED_TRANSACTION_ENVIRONMENT_MISMATCH`.
- A sandbox grant keeps its own identity: its verification id names `Sandbox`,
  and its ledger payload carries `appStoreEnvironment: 'Sandbox'`. Exclude
  those grants from revenue and purchase analytics by that field (the
  `purchase_granted` analytics event carries the `ledgerEntryId` to join on).
  They are real grants: anyone on the team's sandbox or TestFlight accounts
  gets the items for free on the production ledger.
- `createAppStoreRecoveryBackend` re-verifies sandbox restores on such a
  deployment with `restoredNonConsumables.acceptsSandboxTransactions: true`.

Family Sharing: the verifier refuses a transaction whose `inAppOwnershipType`
is `FAMILY_SHARED` with `APP_STORE_FAMILY_SHARED_UNSUPPORTED` (and any other
non-`PURCHASED` value with `APP_STORE_OWNERSHIP_UNSUPPORTED`) instead of
silently failing the account-token check. A family member's transaction does
not carry that player's `appAccountToken`, and granting it would let one
purchase grant several players. Leave Family Sharing off for the game's
non-consumables in App Store Connect (it only applies to non-consumables and
auto-renewable subscriptions, and cannot be turned off once on).

This boundary rejects auto-renewable and non-renewing subscriptions. A single
transaction lookup doesn't model renewal, grace-period, upgrade, expiration,
refund-reversal, or server-notification-driven entitlement removal, while the
shared entitlement ledger currently records only durable grants. Add a separate
subscription lifecycle ledger and verify Apple's subscription status and Server
Notifications V2 before enabling catalog products of type `subscription`.
Provider adapters can use
`@mpgd/game-services/app-store-verifier-conformance` for deterministic decoded
JWS fixtures without copying credentials or live signed transactions.

## Client Purchase Path

The client has one purchase path since commerce v2 PR C4. A gateway with a
commerce provider (`gateway.commerce`, a `CommerceProvider`) buys through the
commerce reconciler: `createGameServicesClient` and
`createRecoverableMonetizationClient` open the store through
`provider.requestPurchase`, journal every lifecycle transition, send the
store evidence to `verifyPurchase`, and report a grant only from the backend's
answer. See [Recovering purchases and rewarded ads](MONETIZATION_RECOVERY.md)
for the journal and recovery rules.

- A gateway without a commerce provider sells nothing: `purchase()` answers
  `{ status: 'rejected', purchase: { status: 'failed', entitlementIds: [] } }`
  with the analytics reason `commerce_unavailable`, opens no store UI, and
  never reaches `verifyPurchase`. There is no client-side grant fallback.
- The v1 purchase path is gone: a platform `PurchaseResult` is not an input to
  the client any more, so `recoverPurchaseResult`, the target-name allow-list
  (`GameServicesLegacyStoreTarget`), and the adapter-settled shortcut
  (`findAdapterSettledGrant`, `isAuthoritativeMicrosoftStoreCompletion`) were
  removed. A provider that settles on its own still sends one verify request,
  and the ledger entry comes from the backend's answer.
- A leftover v1 `purchase` journal record is retired: it stays readable, and
  nothing reopens the store UI or grants from it. A record that was
  mid-verification (a completed platform result and no terminal result) has
  its saved verify request sent to this backend once more by the recoverable
  client under the same idempotency key, and the backend's answer closes it.
  The store also lists the purchase it covered again and the reconciler
  verifies it under a derived key; the platform-evidence unique index
  (`findEntitlementTransactionByPlatformEvidence` where the store offers it)
  keeps the repeated verification from granting twice.
- Entitlements are read from the ledger. The v1
  `gateway.commerce.getEntitlements()` has no replacement on the gateway: read
  `listActiveEntitlementTransactions(store, { playerId })` (reversed grants are
  subtracted) or `getPurchaseLedgerStatus` on the server and expose the result
  through the game's own authenticated endpoint.

## Ledger Idempotency Contract

`@mpgd/game-services` treats platform callbacks as evidence, not as the grant
authority. Stores backing `GameServicesStore` must preserve these idempotency
dimensions:

- Purchase and ad reward entitlement grants dedupe by `source`, `playerId`, and
  `idempotencyKey`. A purchase and rewarded-ad grant may use the same
  `idempotencyKey` for the same player without colliding because their `source`
  values differ.
- Duplicate entitlement grants return the original `ledgerEntryId` with
  `alreadyProcessed: true` only when the original logical product or placement
  and target also match. Reusing a key for another grant target fails with
  `IDEMPOTENCY_KEY_CONFLICT`. Platform transaction ids, impression ids, and
  other payload fields are evidence payload, not entitlement idempotency
  dimensions.
- `findEntitlementTransactionByIdempotency` is an optional indexed store
  optimization. Stores implementing the earlier contract remain compatible;
  the backend falls back to `listEntitlementTransactions()` when it is absent.
- `findEntitlementTransactionByEvidenceVerificationId` is also optional. The
  backend falls back to the ledger list and serializes same-evidence writes for
  each store instance. Persistent production stores must additionally enforce
  unique `(source, evidenceVerificationId)` values atomically and throw
  `EvidenceAlreadyProcessedError` to close cross-instance races; the included
  memory and D1 stores implement this invariant.
- `findEntitlementTransactionByPlatformEvidence` is an optional indexed lookup
  for verified purchase transaction ids and rewarded-ad impression ids. It
  preserves replay protection for historical ledger rows that predate authority
  verification ids; stores without it use the ledger-list fallback. The backend
  serializes both authority and platform evidence keys per store instance. The
  D1 migration backfills authority ids already present in payloads and adds
  unique source/target platform-evidence indexes for historical and new rows.
- Purchase verification and rewarded-ad claims run one at a time per
  `(source, playerId, idempotencyKey)` within one backend process, from the
  idempotency lookup through the grant or non-grant decision. This holds even
  when the host creates a store per request, as the Worker does. A same-key
  retry therefore returns the grant it waited for instead of a stale verifier
  decision, such as an already-redeemed token. Non-grant decisions are not
  written to the ledger, so no store constraint makes them atomic across
  processes. The backend rechecks the ledger after a non-grant verification to
  narrow that window; route a player's purchase and reward requests to one
  process when exact cross-process outcomes matter.
- Leaderboard records dedupe by `target`, `leaderboardId`, `playerId`, and
  `runId`. Retries with a different score, submission timestamp, or
  `platformSubmissionId` reuse the original `ledgerEntryId`.
- `ledgerEntryId` values are stable opaque strings. Do not parse them for game
  state decisions; persist and compare the idempotency dimensions instead.

## Production Evidence Verification

The backend requires a `GameServicesEvidenceVerifier` before purchase or
rewarded-ad evidence can write an entitlement. Without one, both paths fail
closed with `EVIDENCE_VERIFIER_UNAVAILABLE`. Provider adapters can carry
versioned fields in `request.evidence` while the shared contract stays
platform-neutral.

Local examples and smoke tests can opt into
`createDevelopmentGameServicesEvidenceVerifier()`. It accepts submitted
evidence without contacting a provider and must not be used for production
grants. The Worker starter enables it only when
`MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE = "true"` is explicitly set in a
local environment, and it refuses to construct the handler when that flag is
combined with `MPGD_STORE = "d1"`, so a leaked flag cannot back a persistent
deployment. `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true"`
is its notifications counterpart: unauthenticated `mpgd-dev` sessions for
the notification routes, refused with `MPGD_STORE = "d1"` the same way and
accepted only on a request to a local host (see
[Notifications v2](./CLOUDFLARE_WORKER_DEPLOY.md#notifications-v2)).
Checked-in deploy configuration remains fail-closed in both
memory and D1 modes. Production deployments can provide the legacy aggregate
`GAME_SERVICES_EVIDENCE_VERIFIER` service binding or separate
`GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER`,
`GAME_SERVICES_IOS_EVIDENCE_VERIFIER`, and
`GAME_SERVICES_AIT_EVIDENCE_VERIFIER`, and
`GAME_SERVICES_VERSE8_EVIDENCE_VERIFIER` bindings. Verse8 deployments can
instead configure the built-in `@mpgd/adapter-verse8/server` verifier by
setting the Worker's `VERSE8_ADS_VERIFIER_AUTHORIZATION` secret to the complete
server Authorization header issued for the consume-once `/ads/verify`
endpoint. `VERSE8_ADS_VERIFIER_BASE_URL` is optional and defaults to the
production Verse8 verifier. This authenticated game-server endpoint is distinct
from the public `GET /ads/status` polling endpoint used by the Verse8 browser
parent; the status endpoint does not consume evidence for a ledger grant.

Verse8 VXShop purchases never grant through `verifyPurchase` evidence. The
browser can only open the shop and report a pending state. The reserved Agent8
`$onItemPurchased` system event is the purchase authority and must apply the
game-owned catalog grant through a consume-once server path; with a ledger
configured it also writes the server-push ledger grant that the commerce v2
`verse8.agent8-event.v1` lookup entry reads (below). See
[Verse8 VXShop and Agent8 Commerce](VERSE8_COMMERCE.md) for the supported
boundary.

### Commerce evidence registry

Commerce v2 (RFC "Evidence registry") routes purchase evidence by
`evidence.schema` instead of by target. Compose a registry from the reference
entries and pass it to the backend:

```ts
import {
  createAppStoreCommerceEvidenceEntry,
  createCommerceEvidenceRegistry,
  createDevvitOrderLookupCommerceEvidenceEntry,
  createGooglePlayCommerceEvidenceEntry,
  createVerse8Agent8EventLookupCommerceEvidenceEntry,
} from '@mpgd/game-services/commerce-evidence-registry';

const registry = createCommerceEvidenceRegistry([
  createGooglePlayCommerceEvidenceEntry({ verifier: googlePlay, finalizer: googlePlay }),
  createAppStoreCommerceEvidenceEntry({ verifier: appStoreVerifier }),
  createDevvitOrderLookupCommerceEvidenceEntry({ ledger: store }),
  createVerse8Agent8EventLookupCommerceEvidenceEntry({ ledger: store }),
]);

const backend = createGameServicesBackend({
  catalog,
  placements,
  store,
  commerceEvidenceRegistry: registry,
  evidenceVerifier: adEvidenceVerifier, // rewarded ads only
});
```

Each entry names its `schema`, its `store` (an open `StoreId`), a
`verifier`, an optional `finalizer`, and the `finish` owner; `finish: 'server'`
without a finalizer, a schema claimed by two entries, a store with two finish
owners, or two entries of one store that accept a missing envelope fail
registry construction, so a missing Play finalizer is a startup error rather
than a grant that is never acknowledged. A request whose schema no entry
claims is rejected with `EVIDENCE_SCHEMA_UNSUPPORTED`; a schema registered for
another store with `EVIDENCE_SCHEMA_STORE_MISMATCH`; a request naming a ledger
target the entry does not declare in `targets` with
`EVIDENCE_SCHEMA_TARGET_MISMATCH`, all before any verifier runs. The optional
`unregistered` fallback keeps a deployment's aggregate v1 verifier for stores
without an entry (a store with an entry never reaches it) and declares the
stores it serves (`stores`), which the capabilities endpoint publishes without
schemas; a request for a store the registry does not serve, or a target that
is neither a ledger target nor a served store, is a 400 as an unknown v1
target was. A request without an envelope reaches only an entry that declares
`acceptsMissingEvidence` (the App Store entry does, for its Server API
lookup), and a schema no entry claims reaches only the store's entry that
declares `acceptsUnclaimedSchemas` (a verifier binding with its own list).
Without a registry the backend keeps the v1 behaviour: one `evidenceVerifier`
and one `purchaseGrantFinalizer` for every purchase; passing a
`purchaseGrantFinalizer` next to a registry throws.

`VerifyPurchaseRequest.store` names the store a purchase was made in; `target`
stays the ledger target. A v1 request without `store` maps `android` to
`google-play`, `ios` to `app-store`, `ait` to `apps-in-toss`, `reddit` to
`devvit`, and every other target to itself (`resolveLegacyCommerceStoreId`).
The ledger payload records `store` and `evidenceSchema` so an evidence-less
retry finalizes through the entry that verified the grant.

The server-push stores register lookup verifiers (`devvit.order.v1`,
`verse8.agent8-event.v1`): the client envelope only names the purchase, and
the verifier answers `settled` (the backend answers `verified` with the
existing ledger entry and `alreadyProcessed: true`) once the host's
fulfillment path wrote the grant for the same store and transaction id, `pending` (`LEDGER_GRANT_PENDING`) before
that, and `rejected` for a transaction, product, or player mismatch. The
fulfillment path writes that grant with `createPlatformOrderLedgerGrant`
(Devvit, key `reddit:<orderId>`) or `createServerPushLedgerGrant` (the Verse8
Agent8 service does so when given a `ledger`), or verifies its own record
through the `devvit.payment-order.v1` entry
(`createDevvitPaymentOrderCommerceEvidenceEntry`, bound through a game-owned
`DevvitPaymentOrderAuthority` port). A verifier that answers
`{ status: 'settled', ledgerEntryId }` is checked against the requesting
player, product, and target before the entry is answered; nothing is written.

With a registry the backend publishes `getCommerceCapabilities()`
(`POST /game-services/purchases/capabilities`, oRPC `commerce.getCapabilities`):
one row per store with its schemas, finish owner, and purchase kinds. The
commerce reconciler compares it with its provider at start and sets the
provider's availability to `configuration-required` (and refuses
`requestPurchase` with `CONFIGURATION_REQUIRED`) for a store the backend does
not accept or a finish owner that disagrees.

### Revocation entries

The ledger is append-only and gains `revoke` entries that reference an earlier
grant (`GameServicesStore.recordEntitlementRevocation`,
`findEntitlementRevocations`, and the batched `getEntitlementTransactions`;
the memory and D1 stores implement all three, a grant is reversed once, a
notification key reused for another grant is `RevocationKeyConflictError`,
and a reused authority identity is `EvidenceAlreadyProcessedError`). The kit
handles App Store Server Notifications V2 refunds and Play voided purchases
(see [Store refunds and server-side finalization](#store-refunds-and-server-side-finalization));
other store notification handlers are game-owned: an Apps in Toss refunded
order or a Devvit refund order calls `revokeEntitlementGrant` from
`@mpgd/game-services` with the notification's own key, so a
redelivered notification answers the first entry with `alreadyProcessed`
(`key_conflict` and `evidence_already_processed` are the misuse answers).
`revokePlatformOrder` does that for a `normalizeDevvitRefundOrder` result; a
refund that arrives before its fulfillment answers `grant_not_found` and
must be retried, or the fulfillment path must consult the refund feed before
granting. `getPurchaseLedgerStatus({ ledgerEntryIds, playerId })` (`POST
/game-services/purchases/ledger-status`, oRPC `commerce.getPurchaseLedgerStatus`)
answers one status per requested id in request order: `active`, `reversed`
with the reversing entry, or `unknown` (an unknown id, or another player's
entry when `playerId` is named); the reconciler reads it in chunks of at most
100 ids scoped to its player, and the Worker's ingress auth requires the body
`playerId` to match the principal like every grant route.
`listActiveEntitlementTransactions` subtracts reversed grants for entitlement
reads. The D1 migration `0006_entitlement_revocations.sql` keeps the grant
row referenced (`ON DELETE RESTRICT`); an account deletion rewrites a purchase
grant and the revocations that reverse it together (see
[Account deletion](#account-deletion)). The subscription `period`
entry (`EntitlementLedgerPeriod`) is a validated shape only; nothing writes it
until a subscription verifier exists.

### Restore sharing

A guest player lives in the device's secure store, so a reinstall on Android,
a new iOS device, a logout, or a second device on the same store account is a
new guest while the store keeps returning the purchase's non-consumables with
the buying guest's binding (Google Play `obfuscatedAccountId`, StoreKit
`appAccountToken`). **Restore sharing** grants the restoring player its own
entitlement linked to the purchase; earlier holders keep theirs
([RFC](specs/commerce/commerce-v2-rfc.md#restore-sharing); the cases per
platform are in
[CLOUDFLARE_WORKER_DEPLOY.md](CLOUDFLARE_WORKER_DEPLOY.md#reinstalls-and-new-devices-restore-sharing)).

- `createGameServicesBackend({ restoreSharing })` sets the policy:
  `{ mode: 'share', maxHolders?: 5 }` (1 to 100) or `{ mode: 'refuse' }`,
  the library default, which answers it as
  [another account's purchase](#another-accounts-purchase). The
  reference Worker shares unless `GAME_SERVICES_RESTORE_SHARING = "refuse"`;
  `GAME_SERVICES_RESTORE_MAX_HOLDERS` sets the limit (an invalid value turns
  sharing off).
- The client asks for it: `VerifyPurchaseRequest.intent: 'restore'`. The
  commerce reconciler sends it for every purchase it discovered from the store
  (not one this install's journal started); a game-started checkout sends no
  intent and keeps the binding check. The intent is a request for the
  policy, never proof. Restore Purchases (`restorePurchases()`) is what
  finds those purchases after a reinstall: it reads the store with
  `getAvailablePurchases({ restore: true })`, which on Google Play adds the
  owned non-consumables the backend already acknowledged and on StoreKit the
  entitlements bound to the earlier guest's token
  ([RFC](specs/commerce/commerce-v2-rfc.md#restore-sharing)). Startup
  recovery does not, so the player's restore action is what shares them.
- The verifier proves it: the Play boundary and the App Store verifier answer
  `{ status: 'restorable', reason }` (an `EvidenceVerificationDecision`) for a
  restore of a non-consumable whose every check passed except the binding
  (`GOOGLE_PLAY_ACCOUNT_MISMATCH` / `GOOGLE_PLAY_PROFILE_MISMATCH`, including
  a purchase made outside the app with no ids, or
  `APP_STORE_ACCOUNT_TOKEN_MISMATCH` with the client's verified JWS present).
  A custom verifier can answer it too. Anything else bound to another account
  is [another account's purchase](#another-accounts-purchase); a purchase
  bound to no account stays `rejected`.
- The backend shares it with ordinary ledger grants, on any store: the
  purchase's holders are its first grant (the evidence id the verifier names)
  and the shares, `listPurchaseHolders`. A share is written at the next
  slot, evidence id `createPurchaseHolderEvidenceVerificationId(purchaseId,
  slot)`, under the request's own key (a player that already holds the
  purchase gets its grant back instead of a second one); its payload
  names the purchase (`holderOfEvidenceVerificationId`, which finalizers such
  as the Play acknowledge are keyed by, `readPurchaseVerificationId`) and
  never another holder's ledger id (it embeds that player's id, which must
  not outlive that player's deletion), and the store transaction id stays on
  the first grant. Two writers that read the same holders take the same
  slot, so one loses on the unique evidence id and reads again: the limit
  holds under concurrency. Shares are listed with
  `GameServicesStore.findEntitlementTransactionsByEvidencePrefix` (one range
  read on the D1 evidence index; the memory store implements it too), which
  also finds slots past a gap the retention purge leaves; a store without it
  reads slot by slot. A refund's fan-out reads the holders again after each
  pass until none is left active, so a share written while it ran is
  revoked too. A purchase no grant holds yet is granted to the
  restoring player as its first grant (`restoredAcrossAccounts: true`). The
  answer is `verified` with `restoredAcrossPlayers: true`, on retries too.
- The answers that are not a share: a consumable or a game-started checkout
  is [another account's purchase](#another-accounts-purchase); a purchase a store event ended
  (refund, chargeback, voided purchase on any holder) `LEDGER_GRANT_REVERSED`,
  also for a share that lands while that refund fans out, or after every
  other holder was revoked (it is revoked right after its write); a purchase `maxHolders` players hold `pending`
  with `PURCHASE_HOLDER_LIMIT_REACHED` (nobody is evicted); three lost races
  in a row `pending` with `PURCHASE_HOLDER_CONFLICT`. A player who already
  holds it gets its grant back (`alreadyProcessed: true`); a resend under the
  key of a reversed grant answers `LEDGER_GRANT_REVERSED`.
- Refunds reach every holder: `revokeEntitlementGrant` with a store reason
  (`refund`, `chargeback`, `voided`) on any holder's grant also revokes the
  other holders' grants, so the Play voided-purchase sweep and the App Store
  refund notification revoke them all; a replay finishes a fan-out an earlier
  attempt left part-way. An `admin` revocation stays on the grant it names
  and frees that holder's place; a purchase whose every holder is revoked is
  never shared again.
- Deleted accounts ([account deletion](#account-deletion)): a deleted
  player's retained record (`deleted:<id>`, `isRetainedPlayerId`) is never
  revived, the deletion tombstone refuses a grant to the deleted id, and the
  record does not count toward the limit; a new guest's share links to the
  purchase and counts. A share is an ordinary purchase grant, so the erasure
  keeps it detached like any other when its holder deletes its account.

Subscriptions are never shared (no subscription verifier yet), and the legacy
`createAppStoreRecoveryBackend` keeps refusing.

### Another account's purchase

A verify can carry one player's session and another player's store purchase:
a client that could not read its store account binding, an older client, a
game's own wrapper, or a race at a player change. The purchase is valid, it
is only not this player's, and its own account can still recover it
([RFC](specs/commerce/commerce-v2-rfc.md#another-account)).

- The Google Play boundary and the App Store verifier answer
  `{ status: 'rejected', reason, anotherAccount: true }` when every other check
  passed and the binding names another account (`GOOGLE_PLAY_ACCOUNT_MISMATCH`,
  `GOOGLE_PLAY_PROFILE_MISMATCH`, `APP_STORE_ACCOUNT_TOKEN_MISMATCH`). A
  purchase bound to no account is refused as before, with its own reason:
  `GOOGLE_PLAY_ACCOUNT_ID_MISSING`, `GOOGLE_PLAY_PROFILE_ID_MISSING`,
  `APP_STORE_ACCOUNT_TOKEN_MISSING`, or, on a backend that binds nobody
  (`allowUnboundAuthenticatedPlayer`), `GOOGLE_PLAY_ACCOUNT_BINDING_UNEXPECTED`.
  A restored non-consumable is still `restorable`, bound to no account
  included (with the `*_MISSING` reason; the share policy still covers it).
  When no share covers it, a mismatch reason gets this answer and a
  `*_MISSING` reason stays `rejected`.
- `createGameServicesBackend` grants and records nothing for it (no ledger
  entry, no owner claim, nothing for a deletion tombstone to refuse) and throws
  `GameServicesPurchaseBoundToAnotherAccountError` (`code`
  `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT`, `reason`, `status` 409). The HTTP
  handler answers it as 409 `{ "error": "PURCHASE_BOUND_TO_ANOTHER_ACCOUNT",
  "reason": "GOOGLE_PLAY_ACCOUNT_MISMATCH" }`, the oRPC router as that error
  code with `data.reason` (409 through `createGameServicesRpcFetchHandler`;
  oRPC 2.0.0-beta.46 errors carry no status of their own, so a host that
  mounts `createGameServicesRouter` in its own `RPCHandler` passes
  `errorStatusMap: gameServicesRpcErrorStatusMap`, or answers 500 with the
  same code), and the Worker's service-binding method throws it
  (Workers RPC keeps `code` and `reason` from compatibility date 2026-04-21 on
  both Workers, and the message, which starts with the code, before it).
  Analytics tracks `purchase_rejected` with `boundToAnotherAccount: <reason>`
  (never a pending count); a failed analytics report never replaces the
  answer.
- It is an error rather than a receipt so released clients keep the record
  open: every `@mpgd/game-services` client before this one ends a non-pending
  receipt as `rejected` for good, and journals a `pending` one as an open
  attempt that refuses new purchases of the product. On a transport error
  they keep the record in `verifying` and resend it on the next reconcile. The
  current reconciler recognizes the answer (`readPurchaseBoundToAnotherAccount`)
  and parks the record instead, reporting an `another-account` event rather
  than a `failure`; it also parks a `rejected` receipt whose
  reason is one of the three mismatches, so a backend or game server from
  before this answer gets the same client behaviour.

**A game server that wraps the verifiers** answers it the same way instead of
mapping it to `rejected`:

- Calling `backend.purchases.verifyPurchase` (the Google Play path most games
  use): catch the error and answer 409 with
  `createPurchaseBoundToAnotherAccountBody(error.reason)`, or rethrow it into a
  transport that answers any error as retryable. Do not catch it into a
  `{ verified: false, disposition: 'rejected' }` body. Run any owner claim only
  on a `verified` decision, as before.
- Calling a verifier directly (an App Store wrapper that decides before it
  creates the backend): on `decision.status === 'rejected' &&
  decision.anotherAccount === true`, answer that 409 instead of a `rejected`
  receipt, and write nothing.
- A game client with its own transport keeps the 409 answer an error (retry
  later), never a rejected receipt. With the kit's transports nothing changes:
  `createGameServicesHttpBackendApi` and the oRPC client raise it, and the
  reconciler parks the record.

If any target-specific binding is configured, the Worker enters strict
target-specific mode for purchase routing. Each purchase request is sent only
to the binding matching its target. A missing match fails closed with
`EVIDENCE_VERIFIER_UNAVAILABLE`; it never falls back to another target or the
aggregate binding. Configure every target served by a deployment before
enabling target-specific mode. Deployments with no target-specific bindings
keep the aggregate purchase binding behavior for backwards compatibility.

Advertising proof dispatch uses
`createAdRewardEvidenceVerifierRegistry()` from
`@mpgd/game-services/ad-reward-verifier-registry`. Every server registration
declares a `providerId`, unique provider-owned evidence `schema`, permitted
`bindings` (`target` and optional `deploymentTarget`), and `verify(input)`.
The selected verifier must authenticate proof and bind it to the player,
placement, invocation, and provider. Pending proof cannot write a grant, and
the ledger rejects reusing one authoritative impression under another key.
Existing authoritative verification IDs stay unchanged during migration.
Versioned clients also record the optional `providerId` in the claim and
journal. The registry checks that identity against the schema owner, and
records its trusted selected identity as `adProviderId` in ledger payloads.
Recovery cannot replace a recorded provider while a claim is pending.

The Worker assembles built-in AdMob, Apps in Toss, and Verse8 schemas from
configured native/target bindings. Unknown schemas or target/deployment
combinations reject with `AD_REWARD_VERIFIER_UNREGISTERED` before dispatch.
Custom advertising integrations must explicitly register their schema.
the native AdMob SSV registration also explicitly permits a missing client
envelope, so signed, stored SSV proof can settle an existing claim without
an SDK reward callback. This opt-in `acceptsMissingEvidence` proof-lookup
path still authenticates the original player, placement, and invocation;
it cannot accept an unknown supplied schema. Only one such default is
permitted per target/deployment binding.
Target-specific and aggregate bindings no longer imply arbitrary ad schema
permission. Purchase routing is unchanged.

For another provider on any existing build target, configure the JSON var
`MPGD_AD_REWARD_VERIFIERS` with descriptors such as
`[{ "providerId": "game-provider", "schema": "game-provider.reward.v1",
"bindings": [{ "target": "browser", "deploymentTarget": "browser-stage" }] }]`
and bind a private `GAME_SERVICES_AD_REWARD_EVIDENCE_VERIFIER` service.
Its `verifyAdReward(input)` receives the trusted selected `providerId` alongside
the clone-safe evidence verification input and must verify provider proof.
Set `MPGD_DEPLOYMENT_TARGET_BINDINGS` to `{ "browser": "browser-stage" }`
for a custom deployment key; existing named deployment vars take precedence.
Game-owned placement configuration must use that same deployment key.
Duplicate or conflicting registrations fail during handler construction.
This server configuration is independent of the client's
`rewardEvidenceRegistry`; adding a client decoder confers no server authority.

Verifier calls receive an `AbortSignal` and default to a 10-second server-side
timeout. Configure `evidenceVerificationTimeoutMs` when constructing the
backend if a provider needs a different bounded deadline. Timeouts fail closed
with `EVIDENCE_VERIFIER_TIMEOUT` and never reach the entitlement ledger.
The Worker service-binding wrappers keep `AbortSignal` local because it is not
an RPC-cloneable value; they forward the numeric `timeoutMs` so each bound
verifier can apply the same provider-side deadline.

Android and iOS backends can use
`createAdMobSsvEvidenceVerifier()` from
`@mpgd/game-services/admob-ssv`. It verifies the ordered callback query using
Google's percent-decoded verification bytes and rotating EC keys, requires
signed values for the player, custom claim, ad unit, reward, and timestamp, and derives
the authority replay identity from AdMob's `transaction_id`. The deployment supplies raw callback
persistence and rotating keys; the kit does not embed credentials or a key
fetch endpoint. See [AdMob Server-Side Verification](ADMOB_SSV.md) and run
`pnpm smoke:admob-ssv-conformance` before enabling production grants.

Post-ledger purchase finalization uses a separate 15-second deadline because
provider acknowledgement or consumption can have a different latency profile
than evidence verification. Configure `purchaseGrantFinalizationTimeoutMs`
independently when constructing the backend. Timeouts preserve the durable
grant, return `PURCHASE_FINALIZER_TIMEOUT`, abort the provider signal, and can be
retried idempotently. Finalization status, action, completion state, and reason
are included in purchase analytics for operational diagnosis.

## Cloudflare Worker Starter

`apps/game-services-worker` is a Cloudflare Vite plugin Worker starter. Vite
runs the Worker inside `workerd` for local development and production builds,
while `wrangler.toml` remains the source of truth for bindings, compatibility
flags, and deploy config:

```sh
pnpm --dir apps/game-services-worker dev
pnpm --dir apps/game-services-worker build
pnpm --dir apps/game-services-worker preview
pnpm --dir apps/game-services-worker deploy
```

The Worker entry file is intentionally thin: `src/index.ts` extends
`WorkerEntrypoint`, and reusable HTTP/oRPC/service logic lives in
`src/handler.ts` so local smoke tests can run without importing the
`cloudflare:workers` runtime module in Node.

The starter's public HTTP/oRPC ingress permits cross-origin calls and does not
apply request rate limits. By default it also does not authenticate callers.
Do not expose its grant routes as the sole production trust boundary. Put
game-owned authenticated ingress and abuse controls in front of them, and
derive or bind the player identity on the server instead of trusting a
client-supplied player ID. Internal service bindings remain the preferred
production integration boundary.

The unverified leaderboard record route (`POST /game-services/leaderboard/record`
and oRPC `leaderboard.recordScore`) is not mounted on the public ingress by
default: public requests receive `404 UNKNOWN_ENDPOINT`, while the
`recordLeaderboardScore()` service binding RPC is unchanged. Set
`MPGD_ALLOW_PUBLIC_LEADERBOARD_RECORD = "true"` only when game-owned
authenticated ingress sits in front of the Worker.

Bind the optional `GAME_SERVICES_INGRESS_AUTH` service to authenticate the
public purchases, ad-rewards, and leaderboard routes. Its
`authenticateGameServicesRequest({ authorization })` RPC receives the complete
`Authorization` header value and returns the authenticated `{ playerId }`, or
`undefined` / `null` when the token does not resolve. When the binding is
configured, a public grant request without a resolvable token receives
`401 UNAUTHORIZED`, a body `playerId` that differs from the authenticated player
receives `403 PLAYER_ID_MISMATCH`, and a binding failure (a thrown error, or any
result other than `{ playerId: string }` with a non-empty ID) receives
`500 AUTHENTICATION_FAILED`. Without the binding, the public grant routes remain
unauthenticated.

Both gates match the request path after percent-decoding each segment and
dropping empty segments, because oRPC's `RPCHandler` resolves procedures the
same way: `/rpc/%63ommerce/verifyPurchase` and `/rpc/commerce/verifyPurchase/`
are gated exactly like `/rpc/commerce/verifyPurchase`. A path segment that
cannot be percent-decoded receives `404 UNKNOWN_ENDPOINT` from the Worker
without reaching the HTTP or oRPC handlers.

The default `wrangler.toml` uses `MPGD_STORE = "memory"` so local smoke tests
work without provisioning cloud resources. For production persistence, create a
D1 database, apply every migration in `apps/game-services-worker/migrations/`
in filename order, uncomment the D1 binding, and set `MPGD_STORE = "d1"`.
The `0002_verified_leaderboards.sql` migration adds durable definition,
processed-attempt decision, and retained-entry tables. Apply
`0003_verified_leaderboard_metrics.sql` afterward to persist optional immutable
numeric attempt metrics on processed decisions and ranked entries. Apply
`0004_entitlement_evidence.sql` next to persist provider verification identities
and enforce source-scoped evidence replay protection, and
`0006_entitlement_revocations.sql` for the commerce v2 `revoke` entries behind
the ledger status read (it only adds a table and indexes). Entitlement grant
writes read the inserted row back on the same `first-primary` D1 session, so a
replica cannot miss the row and fail the request after the unique indexes have
already recorded the grant.

<!-- @link ../apps/game-services-worker/src/d1Store.ts#D1GameServicesStore.recordEntitlementGrant Insert and read-back share a first-primary session. -->

Durable leaderboard providers should also run
`@mpgd/game-services/verified-leaderboard-durability-conformance`. Its fault
fixtures cover an interrupted retained write followed by replacement,
concurrent retry, and snapshot recovery without requiring D1, Redis, or Agent8
to share a persistence implementation.

Configure the private `VERIFIED_LEADERBOARD_AUTH` service binding to mount the
public read-only verified leaderboard snapshot route. Its RPC method validates
the Authorization header and returns the authenticated participant ID. Without
that binding, the Worker does not mount the snapshot handler. Trusted writes
remain available only through the game-services service binding.

The Worker class extends `WorkerEntrypoint`, so another Worker can bind it as an
internal service and call methods without a public URL:

```toml
[[services]]
binding = "GAME_SERVICES"
service = "mpgd-game-services"
```

```ts
const purchase = await env.GAME_SERVICES.verifyPurchase(input);
const reward = await env.GAME_SERVICES.claimAdReward(input);
const score = await env.GAME_SERVICES.recordLeaderboardScore(input);
const verified = await env.GAME_SERVICES.recordVerifiedAttempt(verifiedCommand);
const snapshot = await env.GAME_SERVICES.getSnapshot(snapshotRequest);
```

`getPurchaseLedgerStatus(input)` and `getCommerceCapabilities()` are also
service binding methods; the latter answers `undefined` on a Worker without
commerce registry entries.

The Worker composes its commerce evidence registry from bindings: the
`google-play` entry from `GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER` or the
in-Worker Play boundary (`GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME` with the
`GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH` service that mints Android Publisher
access tokens from the game-owned service account, plus
`GAME_SERVICES_GOOGLE_PLAY_ACCOUNT_BINDING` or the explicit
`GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER = "true"` opt-in; the Worker
refuses to start if that flag is set without `GAME_SERVICES_INGRESS_AUTH`),
finalized by
that boundary or by a `GAME_SERVICES_ANDROID_PURCHASE_FINALIZER` service,
or, when the binding acknowledges purchases itself,
`GAME_SERVICES_ANDROID_VERIFIER_FINALIZES = "true"` (the entry is published
with the client finish owner, so a commerce v2 Play provider is told
`configuration-required`); an Android verifier with none of these closes the
purchase routes (`verifyPurchase` and the capabilities read answer the
configuration error, logged once at startup) while ads and leaderboards keep
serving; `app-store` from `GAME_SERVICES_IOS_EVIDENCE_VERIFIER`;
`apps-in-toss` from `GAME_SERVICES_AIT_EVIDENCE_VERIFIER`; `microsoft-store`
from the verifier and finalizer pair; and the `devvit.order.v1` and
`verse8.agent8-event.v1` lookups from `MPGD_COMMERCE_LOOKUP_STORES` (for
example `["devvit", "verse8"]`), reading the Worker's own ledger; with
`GAME_SERVICES_DEVVIT_PAYMENT_ORDER_AUTHORITY` bound (a private service over
the Devvit `payments` order read) the `devvit.payment-order.v1` entry serves
the fulfillment handler's `createPlatformOrderVerifyRequest`, and without it
such a request is refused with `DEVVIT_PAYMENT_ORDER_AUTHORITY_REQUIRED` and
the fulfillment path writes the ledger directly with
`createPlatformOrderLedgerGrant`. Binding entries keep their v1 contract: a
request without an envelope and a schema no entry claims still reach the
binding of their store. Stores without an entry keep the aggregate
`GAME_SERVICES_EVIDENCE_VERIFIER` (or the local development verifier) as the
v1 fallback for every ledger target it served before, and it is published
for `app-store`, `apps-in-toss`, and `google-play` with the client finish
owner (the aggregate cannot finish Android purchases; bind a Play finalizer
to publish `google-play` as server-finished; `oneplay` is served but not
published, since the Worker binds no OnePlay finalizer); an undeclared
`store` label on a target whose v1 store has an entry (`{ target: 'reddit',
store: 'verse8' }`) is a 400 rather than a way around that entry; in strict
target-specific mode a store without its binding keeps answering
`EVIDENCE_VERIFIER_UNAVAILABLE` and is not published. A Worker without any
entry runs without a registry and publishes no capabilities. The store,
registry (with its Play boundary), backend, and handlers are built once per
`env` object and reused across requests.

Use public HTTP/oRPC for external game clients and service binding RPC for
internal Cloudflare Worker-to-Worker calls. `recordVerifiedAttempt()` is a
trusted internal command and is not exposed by the Worker's public fetch routes.
Authenticated clients can use `createVerifiedLeaderboardSnapshotFetchClient()`
for read-only pages; the server, not the client, chooses `participantEntry` scope.

## Target Notes

### Google Play one-time products

`@mpgd/game-services/google-play-purchase` provides a backend-only boundary for
Google Play one-time products. The game-owned backend supplies a
`GooglePlayProductPurchaseClient` implementation using its own OAuth/service
account environment. `@mpgd/game-services/google-play-publisher-client` now
provides that transport: pass a server-side `getAccessToken(signal)` callback
that returns a token scoped to `https://www.googleapis.com/auth/androidpublisher`.
The callback must refresh tokens when needed; do not put credentials or access
tokens in the game client, generated artifacts, or this repository. The
transport calls the official ProductPurchaseV2 get endpoint and the legacy
product acknowledge/consume endpoints used for post-ledger finalization. It
does not grant anything on its own, and an HTTP success is not evidence of a
working Play Console account until tested with that game's configuration.

The Android callback sends a `google-play.product-purchase.v2` evidence envelope
whose payload contains only the purchase token. Configure the package name on
the trusted server and provide `resolveObfuscatedAccountId` to bind the Google
response to the authenticated mpgd player. If a game accepts promotion
redemptions or other purchases made outside the app, where Google does not
return an account identifier, it must explicitly set
`allowUnboundAuthenticatedPlayer: true` and bind `playerId` to the logged-in
account before calling this boundary. The Worker sets that opt-in only from
`GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER = "true"`, and refuses to start
unless `GAME_SERVICES_INGRESS_AUTH` is also bound. Without that binding the
public verify route would grant an unbound Play token to whatever `playerId`
the body names. A configured resolver that unexpectedly
returns no identifier fails closed unless that opt-in is present. Unbound mode
also rejects responses carrying either `obfuscatedExternalAccountId` or
`obfuscatedExternalProfileId`; a purchase associated with another app account
or profile must never be attributed to the current player implicitly. Games
that set BillingClient's profile identifier must also provide
`resolveObfuscatedProfileId`; profile-bearing provider responses fail closed
when no expected profile is available, and both identifiers are matched when
the response carries both.

<!-- @link ../apps/game-services-worker/src/handler.ts#assertGooglePlayUnboundPlayerRequiresIngressAuth Refuses to start when the unbound Play flag is set without ingress auth. -->

Generated games bind purchases with the reference module
`src/platform/commerceAccountBinding.ts` (commerce v2 PR C3): Play's
obfuscated account id is the lowercase hex SHA-256 of
`mpgd-commerce-account:<playerId>`, and StoreKit's `appAccountToken` is the
first 16 bytes of the same digest laid out as a version 5 UUID (version
nibble `5`, variant bits `10`). A backend serving those games derives the
same values in `resolveObfuscatedAccountId` and `resolveAppAccountToken`
from the authenticated player id; the reference guest identity Worker
(`apps/game-identity-worker`) does, through its `GooglePlayAccountBinding`
and `AppStoreAccountBinding` entrypoints
([Guest Identity Worker](./CLOUDFLARE_WORKER_DEPLOY.md#guest-identity-worker)).
The player is the server session's (`setStarterCommerceServerPlayer`, which
the generated game's `guestIdentity.ts` sets when `VITE_MPGD_IDENTITY_URL`
is configured, a server-issued guest included); without one, only an
authenticated, non-local platform session binds. A game with its own account
scheme replaces the module and both resolvers together. A new guest (after
an Android reinstall, on a new device, or after a logout) does not match the
binding of its earlier purchases; a restored non-consumable is then granted
to it as well under the backend's [restore sharing](#restore-sharing) policy
([reinstalls and new devices](./CLOUDFLARE_WORKER_DEPLOY.md#reinstalls-and-new-devices-restore-sharing)).

The boundary checks the ProductPurchaseV2 purchase state, line-item product id,
single quantity, remaining refundable quantity, optional order id, provider
completion timestamp, and configured obfuscated account id before returning
verified evidence. Rental purchase options fail closed because the catalog grant
contract does not carry rental expiry semantics. `refundableQuantity` must equal the purchased quantity;
missing, malformed, fully refunded, and partially refunded values do not grant.
Google may omit `orderId`, so a missing provider order is accepted while a
present order must match the request. The optional Capacitor Play Billing
provider uses `createGooglePlayTokenPurchaseKey(purchaseToken)` from
`@mpgd/platform/commerce` when the device has not yet received an order ID
(the former `createGooglePlayTokenTransactionId` alias was removed in commerce
v2 PR C4). The server recomputes that digest with the same
helper from the evidence token before allowing token-only order matching; an
unrelated client-supplied ID still fails when Google reports an order. The
client-reported `purchasedAt` is not
compared with provider time; the authoritative time is persisted as
`googlePlayPurchaseCompletionTime`. The ledger stores only a SHA-256 token
identity in its evidence fields, never the raw purchase token. Callers must
also keep the raw token out of `idempotencyKey` and `platformTransactionId`,
because those client-supplied request fields are persisted as ledger metadata.

Compose both halves of the boundary with the authoritative backend:

```ts
const googlePlay = createGooglePlayProductPurchaseBoundary({
  client: createGooglePlayPublisherClient({
    getAccessToken: gameOwnedPublisherAccessToken,
  }),
  packageName: gameOwnedPackageName,
  resolveObfuscatedAccountId: resolvePlayerAccountHash,
  resolveObfuscatedProfileId: resolvePlayerProfileHash,
});

const backend = createGameServicesBackend({
  catalog,
  placements,
  store,
  evidenceVerifier: {
    verifyPurchase: (input) => googlePlay.verifyPurchase(input),
    verifyAdReward: (input) => adEvidenceVerifier.verifyAdReward(input),
  },
  purchaseGrantFinalizer: googlePlay,
});
```

The backend records the idempotent ledger grant before calling the finalizer.
Consumables use `purchases.products:consume`; non-consumables use
`purchases.products:acknowledge`. A provider error leaves the grant durable and
returns `finalization.status = "pending"`; retrying the same request reuses that
grant and retries only the incomplete platform action. A completed provider
state is treated as an idempotent success. Subscription products fail closed
and require a separate subscriptions verifier. Because the durable grant is
already committed, `verified` remains true when finalization is pending. A
production backend must inspect that status and enqueue the same idempotency
key and evidence for server-side retry; it must not depend on the game client
starting another billing flow. The boundary releases its same-process
finalization lease when the backend aborts a timed-out provider call, so a
provider client that fails to settle after cancellation cannot permanently
block later retry workers.

Protocol references:

- [ProductPurchaseV2 resource](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2)
- [One-time purchase processing](https://developer.android.com/google/play/billing/integrate#process)
- [Acknowledge endpoint](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/acknowledge)
- [Consume endpoint](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/consume)

- Android purchase flow should follow Google Play Billing's server verification,
  grant, then acknowledge or consume sequence.
- iOS purchase flow should send StoreKit/App Store signed transaction evidence to
  the backend verifier.
- Apps in Toss IAP should support pending order recovery and complete product
  grant after partner backend grant succeeds.
- Rewarded ads should treat SDK reward callbacks as evidence. For AdMob-backed
  targets, server-side verification callbacks should be the backend grant signal.
- Verse8 rewarded callbacks provide correlation only. The server verifier must
  consume the matching request, placement, and user before the catalog-backed
  ledger grants; client or verifier reward amounts never select the grant.
- Apps in Toss rewarded ads must follow `loadFullScreenAd` then `showFullScreenAd`;
  rewards are tied to `userEarnedReward`, not `dismissed`.
- `@mpgd/game-services/apps-in-toss-evidence-verification` provides versioned
  callback envelopes and server authority ports. Purchase authorities must bind
  mTLS order-status results to a server-authenticated game player. They may use
  a Toss Login user key, or a server-verified platform-anonymous key together
  with a global consume-once order-id reservation. Reward authorities must
  independently verify a consume-once event. Missing or mismatched authorities
  fail closed. See
  [Apps in Toss Production Evidence](APPS_IN_TOSS_PRODUCTION_EVIDENCE.md).

### Store refunds and server-side finalization

A refund, a chargeback, or a store revoking a purchase reaches the ledger as a
`revoke` entry, and a Play purchase whose client went away before the
acknowledge or consume is finished by the server. Each handler finds the grant
by the verification id the purchase verifier recorded, never by a client
value, and keys its revocation so a redelivered or re-read notification
answers the first entry.

**App Store Server Notifications V2**
(`@mpgd/game-services/app-store-server-notifications`). Apple posts
`{ "signedPayload": "<JWS>" }` to the URLs set in App Store Connect
([Enabling App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications/enabling-app-store-server-notifications)).
`handleAppStoreServerNotification({ store, verifier, body, environment, bundleId, signal })`
verifies the payload through an `AppStoreServerNotificationVerifier`;
`createAppleServerNotificationVerifier` in `@mpgd/game-services/app-store-server`
is the implementation over Apple's library and the same root certificates as
the purchase verifier, one per environment.

- With the optional `revocations` (an `AppStoreRevocationRecorder`), every
  `REFUND` and `REVOKE` of the customer's own one-time purchase is recorded
  there before the ledger is read, granted or not, keyed by the grant's
  verification id (`createAppStoreVerificationId`: original transaction id
  for non-consumables, transaction id for consumables). The registry keeps
  the latest revocation per key: a purchase refunded, reversed, and revoked
  again refuses every JWS signed before the last revocation, and a
  redelivery or a late older notification changes nothing. An offline-only purchase verifier reads the same registry, so a
  pre-refund JWS is refused even when the refund arrived before any grant.
  A recorder outage (`AppStoreDependencyUnavailableError`) is `retry` (503,
  `APP_STORE_REVOCATION_REGISTRY_UNAVAILABLE`) before the ledger is touched;
  any other recorder error is thrown. A `FAMILY_SHARED` revocation is never
  recorded. A record's `revokedAt` is Apple's `revocationDate`, else the
  notification's `signedDate`, so a redelivery records the same time. A record may be dropped once `revokedAt` is older
  than the verifier's `maxSignedAgeMs` plus `clockSkewMs`, since every JWS
  it refuses (signed at or before that time) is then stale.
- `REFUND_REVERSED` records nothing and leaves the record in place: the
  record refuses only a JWS signed before the refund, so after a refund
  reversed before any grant the client's fresh JWS (no `revocationDate`)
  is granted by the offline-only verifier, as the Server API mode grants
  it. A grant the ledger already reversed stays reversed (below).
- `REFUND` reverses the grant with reason `refund`, keyed
  `app-store:notification:<notificationUUID>`. Non-consumables are found by
  their original transaction id, consumables by their own. `REVOKE` is
  mapped to `voided` the same way, but Apple sends it when access through
  Family Sharing or an organization ends, and such a transaction is ignored
  by the next rule; the purchaser's own refund arrives as `REFUND`.
- A transaction that is not the customer's own purchase (`FAMILY_SHARED`) is
  ignored: it shares the purchaser's original transaction id, and the
  purchaser keeps the grant.
- `REFUND_REVERSED` for a grant this ledger revoked is answered
  `refund_reversed` (200): the player paid again, but nothing is re-granted.
  The reversal is kept as a ledger note (`EntitlementLedgerNote`, kind
  `refund_reversed`, `noteId` `app-store:notification:<notificationUUID>`,
  once per notification) through the store's optional `recordEntitlementNote`;
  the memory and D1 stores implement it (D1: `entitlement_notes` in
  `0009_store_server.sql`). The outcome names the player, the grant, and the
  reversed `revoke` entry, and the Worker logs it at warn. A store without
  notes still answers 200 with `recorded: false`; the host's log is then the
  only record. A `REFUND_REVERSED` for a grant that is not revoked yet is
  `retry` (503, `APP_STORE_NOTIFICATION_GRANT_NOT_REVOKED`), so a refund
  still being redelivered is applied first; one for a grant revoked for
  another reason than an App Store refund is `ignored`
  (`APP_STORE_NOTIFICATION_REVOCATION_NOT_REFUND`).
- A `REFUND` or `REVOKE` for a transaction this ledger holds no grant for is
  `retry` (503) while Apple revoked it less than `unmatchedRefundRetryMs`
  ago (1 hour by default), then `ignored`. A purchase request that verified
  the transaction just before the refund may still be writing its grant;
  Apple's redelivery (an hour later in production) then finds and revokes
  it, and a refund for a grant that never appears is acknowledged at that
  redelivery. A purchase request that starts after the refund is refused by
  the default Server API purchase mode, which reads the revocation, or by the
  offline-only mode from the `revocations` record. (A
  pending-revocation record applied by the grant path would close the race
  without a redelivery, but needs a write on every purchase; the bounded
  retry needs none.)
- Every other type (`TEST`, `CONSUMPTION_REQUEST`, `REFUND_DECLINED`,
  subscription and summary notifications) is `ignored`.
- Answers: `revoked`, `ignored`, and `conflict` (a ledger key or identity
  conflict to alert on) are 200; `rejected` (not signed by Apple for this app
  and environment, malformed) is 400; `retry` (Apple's certificate checks are
  unavailable) is 503; a thrown store error must be a 5xx. Apple retries a
  non-200 answer five times, 1, 12, 24, 48, and 72 hours apart, in production
  only; the sandbox sends once
  ([Responding to App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications/responding-to-app-store-server-notifications)).
- Set both URLs: the sandbox one revokes App Review, TestFlight, and sandbox
  grants of a deployment with `sandboxPurchases: { mode: 'grant' }`.

The package's vitest suite verifies real signatures from a throwaway test CA
whose chain carries Apple's marker extensions; production verification
additionally runs Apple's online certificate checks, which no test here makes.

#### Re-granting after a refund reversal

The ledger is append-only and a grant is reversed once, so a reversed refund
is never undone in place: the game decides and writes a new grant. A
support tool (game-owned, behind the game's own authentication) reads the
notes, `store.findEntitlementNotes({ ledgerEntryIds })`, or the Worker's warn
log, checks the player and product, and records an `admin` grant keyed by
the note so a second click does nothing:

```ts
const grant = await store.getEntitlementTransaction(note.ledgerEntryId);
if (grant === undefined || grant.playerId !== note.playerId) {
  throw new Error('The reversed grant is not on this ledger.');
}
await store.recordEntitlementGrant({
  source: 'admin',
  playerId: note.playerId,
  grantId: grant.grantId,
  idempotencyKey: `regrant:${note.noteId}`,
  grantedAt: new Date().toISOString(),
  ...(grant.grant === undefined ? {} : { grant: grant.grant }),
  payload: {
    regrantOf: note.ledgerEntryId,
    reversedRevocation: note.revocationLedgerEntryId ?? '',
    reason: 'app-store-refund-reversed',
  },
});
```

Entitlement reads (`listActiveEntitlementTransactions`) then count the new
grant; the reversed one stays reversed, so both entries keep the history.
The `admin` grant carries no App Store evidence, so a later refund of the
same transaction finds only the original, already reversed grant: revoke
the re-grant by hand if Apple refunds the purchase again.

**Google Play voided purchases** (`@mpgd/game-services/google-play-store-server`).
`sweepGooglePlayVoidedPurchases` reads
[`purchases.voidedpurchases.list`](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases/list)
(in-app products, `type=0`) for a window, page by page, and
`revokeGooglePlayVoidedPurchase` reverses each grant, found by the purchase
token's verification id (`createGooglePlayProductVerificationId`) and keyed by
it: reason `chargeback` for `voidedReason` 7, `voided` otherwise (including 8,
Play's refund of a purchase left unacknowledged). Google keeps voids for 30
days and filters on when it recorded the void, not on `voidedTimeMillis`
([Voided Purchases API](https://developers.google.com/android-publisher/voided-purchases));
the sweep clamps its start to that window measured from now and reports
`clamped` when older voids are gone. A sweep that stops on its page cap or the
caller's budget is `complete: false`; repeating the same window does not
finish it, so callers sweep in shorter windows. The API allows 6,000 queries a
day and 30 in any 30 seconds per package, and needs the service account to
see financial data (Google's page calls the permission "View financial
reports"; check the name in your Play Console).

Real-time developer notifications are not implemented. An RTDN
`voidedPurchaseNotification` carries the purchase token and order id
([RTDN reference](https://developer.android.com/google/play/billing/rtdn-reference#voided-purchase)),
so a Pub/Sub push endpoint that verifies the push's OIDC token could pass it to
`revokeGooglePlayVoidedPurchase` for a faster revocation. The sweep stays
required next to it, because a push can be missed, and it is the minimal
reliable design the Worker ships.

**Server-side acknowledge and consume.** Play refunds a purchase that is not
acknowledged within three days of becoming `PURCHASED`; consuming a consumable
counts as the acknowledgement
([Process purchases](https://developer.android.com/google/play/billing/integrate#process)).
The ledger keeps only the purchase token's digest, so a server retry needs the
token: `retryGooglePlayPurchaseFinalization({ finalizer, store, ledgerEntryId,
purchaseToken, signal, timeoutMs })` rebuilds the finalization input from the
ledger grant, checks the token against the grant's verification id, and runs
the same Play boundary (which re-reads the provider state first); a reversed
grant is never finalized. The Worker keeps the token in D1 until the
acknowledge or consume completes and retries it from its cron; see the
[Worker runbook](CLOUDFLARE_WORKER_DEPLOY.md#store-refunds-and-play-finalization).

## Account deletion

Google Play requires an app that lets players create an account to let them
delete the account and its data in the app and through a web link, and to
say what is kept, why, and the retention period
([Play account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)).
App Store Review Guideline 5.1.1(v) requires deletion to start in the app,
and Apple's
[account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
says automatically created ("guest") accounts are included, that deactivation
is not enough, and that the app says what is kept. The kit's server-issued
guest player is such an account.

### The route

`POST /game-services/account/delete` deletes the signed-in player's account.
The player comes from the request's session, never from the body:

- `GAME_SERVICES_INGRESS_AUTH` (`authenticateGameServicesRequest`), else the
  notifications session binding (`GAME_SERVICES_NOTIFICATIONS_AUTH`), else,
  on a local development host with
  `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS`, a development
  session. No session binding at all answers `503 ACCOUNT_DELETION_NOT_CONFIGURED`.
- A body that names another `playerId` answers `403 PLAYER_ID_MISMATCH`;
  no session `401` (also a development session off a local host); a session
  binding that throws or answers a malformed session `500 AUTHENTICATION_FAILED`; a
  body over 4 KiB or not a JSON object `400`.
- `GAME_SERVICES_ACCOUNT_DELETION` must be bound to the identity Worker's
  `AccountDeletion` entrypoint: `deletePlayer({ playerId })` deletes the
  guest with every session family and token (idempotent), so the player's
  tokens are refused at once on both auth entrypoints and on refresh
  ([guest identity Worker](./CLOUDFLARE_WORKER_DEPLOY.md#guest-identity-worker)). Without it the route answers `503`
  outside local development, rather than erase data while the sessions
  stay alive.
- A session's access token alone cannot delete the account. The request
  carries a deletion confirmation in `X-MPGD-Account-Deletion-Confirmation`
  (`accountDeletionConfirmationHeader`): a short-lived, single-use value the
  identity Worker issues to the holder of the session's refresh token after
  the player's second tap (`POST /identity/v1/account-deletion-confirmation`;
  the guest session's `requestAccountDeletionConfirmation`, which the
  starter calls). Before erasing anything the route has the same
  binding check and consume it
  (`verifyAccountDeletionConfirmation({ playerId, confirmation })` answers
  `{ confirmed }`); a missing, expired, reused, or other player's
  confirmation answers `403 ACCOUNT_DELETION_CONFIRMATION_REQUIRED` and
  deletes nothing. A retry needs a new confirmation. The identity Worker
  uses a confirmation up only when it matches the player, so another
  player's attempt cannot burn it. Development sessions skip the check; the
  operator entrypoint below does not use it. Deploy the identity Worker that
  implements this method before this route: until then every deletion fails
  with a retryable `500`.
- Success is `200 { status: 'deleted', deletionId, completedAt,
  retainedPurchaseRecords }`; a failure before the identity is deleted is
  `500 { error: 'ACCOUNT_DELETION_FAILED', retryable: true }`, and every
  step is idempotent, so the client retries.

Support tooling (a web request handled by an operator) calls
`deletePlayerAccount({ playerId })` on the Worker's separate
`GameServicesAccountDeletion` entrypoint; Workers bound to the default
entrypoint cannot delete players. The client is
`createAccountDeletionClient` (`@mpgd/game-services/account-deletion`), also
on `createGameServicesRuntime(...).accountDeletion`.

### Order of work

`createAccountDeletionService` (D1: migration `0010_account_deletion.sql`):

1. Record a pending erasure (it holds the player id), phase `erasing`.
2. Have the identity service delete the player (every session stops
   authenticating, so nothing new is written); then mark the pending
   erasure `identity-deleted`.
3. Erase every store, each on its own with three attempts (D1: one batch,
   a transaction).
4. Write the audit entry (`account_deletion_audit`: deletion id, times,
   counts, no player id).
5. At its first run at least 15 minutes later the Worker's cron erases
   once more and clears the pending erasure (`finishPendingAccountErasures`,
   `finalErasureDelayMs`); until then the pending erasure keeps the player
   id, so without the cron every deletion leaves it behind:
   a request that authenticated before the identity was deleted (a verify
   waiting on its store, a notifications cron run that loaded the player)
   may write after step 3, and this final pass removes it.

The first eraser writes a **deletion tombstone**
(`account_deletion_tombstones`), and every player-keyed write checks it and
refuses (`AccountDeletedWriteError`, before anything is written): ledger
grants (and so a new purchase's Play finalization row), leaderboard scores,
verified leaderboard attempts, notification rows (consent, endpoints,
registrations, notices, sends, history, reminders), and AdMob SSV callbacks
(acknowledged to Google, not kept). So nothing new lands under the deleted
id once the erasure started; only an operation already past its check can
still write, within its own run, and the final pass removes that. Clearing
the pending erasure after the final pass is safe for that reason: late
writes are refused, not cleaned up later. The tombstone is an
HMAC-SHA-256 of the player id under the deployment secret
`GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY` (a D1 deployment deletes no
accounts without it: `503`), never the id; it expires after 30 days
(`accountDeletionTombstoneTtlMs`, far past an access token's 15 minutes, a
request's or cron run's longest run, and AdMob SSV retries), and the cron
purges it then. It is pseudonymous (without the key it names no one, and a
guessable player id cannot be checked against it), time-bound, and exists
only to enforce the deletion, which is why keeping it is compatible with
erasing the account. A memory deployment keeps its tombstones in the
isolate.

A failure in steps 1 and 2 answers the retryable error and has erased
nothing, so a misconfigured identity binding never leaves a live account
stripped (the identity call is tried three times; it is idempotent). After
step 2 the player can no longer authenticate, so a store that still fails
is reported in the audit entry (`complete: false`) and the final pass
retries it, completing the audit entry. An
`erasing` entry (the identity call failed or the request died first) is
never erased by the cron, since its player most likely still exists, and
is discarded after an hour. The identity Worker's `authenticateGameServicesRequest`
and `authenticateNotificationSession` must refuse a deleted player's access
tokens at once, not when they expire.

### What is deleted and what is kept

| Data | Action |
| --- | --- |
| Purchase grants (`source: 'purchase'`), the revocations reversing them, their notes | **Kept 5 years**, detached: new random ledger ids and idempotency keys, player id replaced by `deleted:<deletionId>`, `playerId` payload key removed. The store transaction stays (store, product, platform transaction and order ids, token digest, the store's account binding), so a dispute can be answered from the player's store receipt, and the same store purchase can never be granted again. |
| An owed Play acknowledge or consume (`google_play_pending_finalizations`) | Kept under the detached grant until the cron completes it within Play's three-day window; the row (with the raw token) is then deleted as usual. |
| Rewarded-ad and admin grants, their revocations and notes, AdMob SSV callbacks | Deleted: no payment is involved. |
| Leaderboard scores, verified leaderboard attempts and entries (participant id = player id) | Deleted. |
| Notification endpoints, consent records, notices given, platform registrations, reminders, sends, delivery history | Deleted. |
| The guest record and every session (identity Worker) | Deleted by `deletePlayer`. |

Every kept ledger row carries its retention expiry (`retained_until`, five
years from its own time). A kept grant carries its group's latest: a
revocation or note about it, written with the erasure or later (a refund the
store reports after the deletion, filed under `deleted:<deletionId>`),
extends it, which the migration's triggers do on insert. The cron purges a
group (the grant, its revocation, its notes) once the grant's expiry passed
and no member is still within its own, and a note kept under a deleted
player about another player's grant at its own expiry
(`purgeExpiredRetainedPurchaseRecords`). A revocation kept under a deleted
player for another player's grant decides that player's entitlement, so it
stays with that grant: it is purged with it (if that grant is ever a kept
one), not on the deleted player's schedule. The cron is required: without a
`[triggers] crons` entry (Workers Paid) pending erasures never finish and
kept records are never purged.

Retention decision and sources. The texts were read on 2026-10-25 through a
mirror of the current law.go.kr versions (law.go.kr renders articles in the
browser); verify them on law.go.kr:
[전자상거래법](https://www.law.go.kr/법령/전자상거래등에서의소비자보호에관한법률),
[its enforcement decree](https://www.law.go.kr/법령/전자상거래등에서의소비자보호에관한법률시행령),
[개인정보 보호법](https://www.law.go.kr/법령/개인정보보호법).

- Act on Consumer Protection in Electronic Commerce, art. 6 (거래기록의 보존):
  a business keeps transaction records, and may keep them and the
  identifying information they need even after a consumer withdraws
  consent to the use of personal information. Enforcement Decree art. 6(1)
  sets the periods: contracts and withdrawals of offers 5 years, **payment
  and supply of goods 5 years**, consumer complaints and disputes 3 years,
  advertising 6 months (decree as in force from 2026-07-21).
- Personal Information Protection Act art. 21: personal information is
  destroyed without delay once its purpose is achieved, unless another law
  requires keeping it, and what is kept for that reason is stored
  separately (in force from 2026-09-11). The detached rows are that
  separate storage.
- Notification consent records are deleted, not kept: their purpose (deciding
  whether this player may receive advertising messages) ends with the account,
  the notifications RFC's own compaction keeps only what its rules read, and
  the advertising rules as the RFC implements them (Network Act art. 50,
  decree art. 62-3) require notices, not a retention period for consent
  records; this was not checked further against the statute. A game that
  wants proof for complaints about earlier sends decides that with counsel.

This is the kit's default, not legal advice: whether and how the Act applies
to a game's developer is a question for the game and its counsel, and kept
records are detached, not anonymous (the store's order id still identifies
the purchase). Whether a game's developer is the merchant of record is part
of that question: on Google Play and the App Store the store processes the payment,
and the kit keeps the supply record (what was granted, when, for which store
transaction). Games that sell outside a store add their own payment records.

### What the player should know

- Purchases are not refunded by deleting the account; refunds go through the
  store. A non-consumable stays owned by the store account: when the player
  plays again as a new guest, Restore purchases grants it under
  [restore sharing](#restore-sharing) as a fresh grant linked to the
  purchase (the retained record keeps its `deleted:<id>` player and is never
  revived for the deleted id, which the tombstone also refuses). The
  retained record does not count toward the holder limit; the new grant
  does. Consumables are not restored.
- A purchase still pending at the store (Play `PENDING`, Ask to Buy) when the
  account is deleted cannot be granted to anyone afterwards. Google refunds a
  Play purchase that is not acknowledged within three days on its own. An
  App Store purchase is **not** refunded automatically: the player asks
  Apple for the refund (reportaproblem.apple.com), since only Apple refunds
  App Store purchases. The starter warns before deleting while a purchase
  is still being processed.

### Residual gaps

- An operation that passed its tombstone check before the erasure started
  and is still running after the final pass (longer than 15 minutes) could
  leave a row; Workers requests and cron runs end well before that. A
  deletion whose `identity-deleted` mark could not be written (three
  attempts) gets no final pass; it is logged under its deletion id
  ("final pass skipped"), and the tombstone still refuses later writes.
- The five-year period is the package constant `retainedPurchaseRecordYears`;
  a game that needs another period changes it in its fork, with the
  starter's copy and legal pages.
- An identity call that committed but whose answer was lost leaves an
  `erasing` pending entry, which the cron discards rather than erases.
  Closing it needs the identity service to answer whether a player exists.
- Two deletions of the same player at once may both rewrite the same rows;
  the evidence keys make the second batch fail (a retryable `500`), and its
  retry finds nothing left.
- A revocation kept under `deleted:` for another player's grant (only a
  game-owned writer files those) stays with that grant, as above.
- The five years are also in migration 0010's triggers; a fork that changes
  `retainedPurchaseRecordYears` changes them too.

## Production Gaps

This repository provides the reusable contract, client orchestration, backend
ledger boundary, memory/D1 store implementations, and a deployable Worker
starter. Game-specific production integrations still need these pieces:

- A game-owned authenticated Google Play API client and production package,
  product, and obfuscated account identifiers for the shared one-time product
  verifier boundary.
- App Store Server API or signed StoreKit transaction verification (a
  game-owned verifier Worker with Apple's library and root certificates),
  including the App Store Server Notifications verifier binding the Worker's
  notification route calls.
- Play Console and App Store Connect configuration for the refund paths:
  notification URLs, the service account's financial and order permissions,
  and the cron trigger (see the Worker runbook).
- Deployment-owned AdMob callback persistence and public-key refresh wiring.
- Game-specific Apps in Toss mTLS transport, optional Toss Login binding or a
  verified anonymous-player/order association, and independently verified
  rewarded-ad authority implementations behind the included public ports.
- Real product, ad placement, leaderboard, app, and bundle identifiers.
- Cloudflare D1 provisioning plus `MPGD_STORE = "d1"` for persistent Worker
  deployments.
- The identity service: deploy the reference guest identity Worker
  (`apps/game-identity-worker`) and bind it, or bind the game's own service to
  the same entrypoints. Account linking and account deletion are not in it
  yet.

The sample catalog, sample ad placements, in-process backend, and Worker memory
store are intentionally starter defaults. They are safe for local smoke tests,
but should not be treated as production entitlement verification.

## Smoke

```sh
pnpm smoke:game-services
pnpm smoke:game-services:worker
pnpm smoke:google-play-purchase
pnpm smoke:apps-in-toss-production-evidence
```

The first smoke runs Android, iOS, and Apps in Toss target simulations through
the typed backend transport. It asserts that purchase and reward grants appear in
the store, leaderboard submissions appear in the store, duplicate idempotency
keys dedupe, and cancelled purchase or skipped ad callbacks do not create grants.
The Worker smoke builds the Cloudflare Vite plugin output, calls
`/game-services/*` and `/rpc/*` against the Worker fetch handler in-process, and
checks the service binding method surface through `createWorkerService()`. It
also runs the provider conformance suite against a real Miniflare D1 database.
