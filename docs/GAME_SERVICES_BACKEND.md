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
payload; the official App Store Server Library is the recommended production
implementation.
The bearer-token provider receives the request `AbortSignal`; it should throw
`AppStoreDependencyUnavailableError` only for a transient signing dependency
outage and let cancellation, invalid credentials, and programming errors
propagate.

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
sandbox environments; never select the authority from an untrusted client
payload.

This boundary rejects auto-renewable and non-renewing subscriptions. A single
transaction lookup doesn't model renewal, grace-period, upgrade, expiration,
refund-reversal, or server-notification-driven entitlement removal, while the
shared entitlement ledger currently records only durable grants. Add a separate
subscription lifecycle ledger and verify Apple's subscription status and Server
Notifications V2 before enabling catalog products of type `subscription`.
Provider adapters can use
`@mpgd/game-services/app-store-verifier-conformance` for deterministic decoded
JWS fixtures without copying credentials or live signed transactions.

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
local environment. Checked-in deploy configuration remains fail-closed in both
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

Verse8 VXShop purchases do not use `verifyPurchase` or a Worker evidence
binding. The browser can only open the shop and report a pending state. The
reserved Agent8 `$onItemPurchased` system event is the purchase authority and
must apply the game-owned catalog grant through a consume-once server path. See
[Verse8 VXShop and Agent8 Commerce](VERSE8_COMMERCE.md) for the supported
boundary.

If any target-specific binding is configured, the Worker enters strict
target-specific mode. Each purchase or rewarded-ad request is sent only to the
binding matching its target. A missing match fails closed with
`EVIDENCE_VERIFIER_UNAVAILABLE`; it never falls back to another target or the
aggregate binding. Configure every target served by a deployment before
enabling target-specific mode. Deployments with no target-specific bindings
keep the aggregate binding behavior for backwards compatibility.

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

The default `wrangler.toml` uses `MPGD_STORE = "memory"` so local smoke tests
work without provisioning cloud resources. For production persistence, create a
D1 database, apply every migration in `apps/game-services-worker/migrations/`
in filename order, uncomment the D1 binding, and set `MPGD_STORE = "d1"`.
The `0002_verified_leaderboards.sql` migration adds durable definition,
processed-attempt decision, and retained-entry tables. Apply
`0003_verified_leaderboard_metrics.sql` afterward to persist optional immutable
numeric attempt metrics on processed decisions and ranked entries. Apply
`0004_entitlement_evidence.sql` next to persist provider verification identities
and enforce source-scoped evidence replay protection.

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
account environment; credentials, access tokens, and API endpoints do not
belong in the game client, generated artifacts, or this repository.

The Android callback sends a `google-play.product-purchase.v2` evidence envelope
whose payload contains only the purchase token. Configure the package name on
the trusted server and provide `resolveObfuscatedAccountId` to bind the Google
response to the authenticated mpgd player. If a game accepts promotion
redemptions or other purchases made outside the app, where Google does not
return an account identifier, it must explicitly set
`allowUnboundAuthenticatedPlayer: true` and bind `playerId` to the logged-in
account before calling this boundary. A configured resolver that unexpectedly
returns no identifier fails closed unless that opt-in is present. Unbound mode
also rejects responses carrying either `obfuscatedExternalAccountId` or
`obfuscatedExternalProfileId`; a purchase associated with another app account
or profile must never be attributed to the current player implicitly. Games
that set BillingClient's profile identifier must also provide
`resolveObfuscatedProfileId`; profile-bearing provider responses fail closed
when no expected profile is available, and both identifiers are matched when
the response carries both.

The boundary checks the ProductPurchaseV2 purchase state, line-item product id,
single quantity, remaining refundable quantity, optional order id, provider
completion timestamp, and configured obfuscated account id before returning
verified evidence. Rental purchase options fail closed because the catalog grant
contract does not carry rental expiry semantics. `refundableQuantity` must equal the purchased quantity;
missing, malformed, fully refunded, and partially refunded values do not grant.
Google may omit `orderId`, so a missing provider order is accepted while a
present order must match the request. The client-reported `purchasedAt` is not
compared with provider time; the authoritative time is persisted as
`googlePlayPurchaseCompletionTime`. The ledger stores only a SHA-256 token
identity in its evidence fields, never the raw purchase token. Callers must
also keep the raw token out of `idempotencyKey` and `platformTransactionId`,
because those client-supplied request fields are persisted as ledger metadata.

Compose both halves of the boundary with the authoritative backend:

```ts
const googlePlay = createGooglePlayProductPurchaseBoundary({
  client: gameOwnedGooglePlayClient,
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
  mTLS order-status results to authenticated Toss-login players; reward
  authorities must independently verify a consume-once event. Missing or
  mismatched authorities fail closed. See
  [Apps in Toss Production Evidence](APPS_IN_TOSS_PRODUCTION_EVIDENCE.md).

## Production Gaps

This repository provides the reusable contract, client orchestration, backend
ledger boundary, memory/D1 store implementations, and a deployable Worker
starter. Game-specific production integrations still need these pieces:

- A game-owned authenticated Google Play API client and production package,
  product, and obfuscated account identifiers for the shared one-time product
  verifier boundary.
- App Store Server API or signed StoreKit transaction verification.
- Deployment-owned AdMob callback persistence and public-key refresh wiring.
- Game-specific Apps in Toss mTLS/login transport and independently verified
  rewarded-ad authority implementations behind the included public ports.
- Real product, ad placement, leaderboard, app, and bundle identifiers.
- Cloudflare D1 provisioning plus `MPGD_STORE = "d1"` for persistent Worker
  deployments.

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
