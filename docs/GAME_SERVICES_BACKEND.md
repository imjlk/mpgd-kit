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
signed player, custom claim, ad unit, reward, and timestamp matches, and derives
the authority replay identity from AdMob's `transaction_id`. The deployment supplies raw callback
persistence and rotating keys; the kit does not embed credentials or a key
fetch endpoint. See [AdMob Server-Side Verification](ADMOB_SSV.md) and run
`pnpm smoke:admob-ssv-conformance` before enabling production grants.

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

## Production Gaps

This repository provides the reusable contract, client orchestration, backend
ledger boundary, memory/D1 store implementations, and a deployable Worker
starter. Game-specific production integrations still need these pieces:

- Google Play purchase token verification, acknowledgement, and consume flows.
- App Store Server API or signed StoreKit transaction verification.
- Deployment-owned AdMob callback persistence and public-key refresh wiring.
- Apps in Toss production IAP/ad verification and partner backend callbacks.
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
```

The first smoke runs Android, iOS, and Apps in Toss target simulations through
the typed backend transport. It asserts that purchase and reward grants appear in
the store, leaderboard submissions appear in the store, duplicate idempotency
keys dedupe, and cancelled purchase or skipped ad callbacks do not create grants.
The Worker smoke builds the Cloudflare Vite plugin output, calls
`/game-services/*` and `/rpc/*` against the Worker fetch handler in-process, and
checks the service binding method surface through `createWorkerService()`. It
also runs the provider conformance suite against a real Miniflare D1 database.
