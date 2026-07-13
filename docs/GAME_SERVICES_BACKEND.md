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
  rankings without adding a public client score-submit route.
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
  createGameServicesHttpBackendApi,
  createInProcessGameServicesBackendTransport,
} from '@mpgd/game-services';

const backend = createGameServicesHttpBackendApi({
  transport: createInProcessGameServicesBackendTransport(
    createGameServicesBackendApiHandler({
      catalog,
      placements,
      store,
    }),
  ),
});
```

## Ledger Idempotency Contract

`@mpgd/game-services` treats platform callbacks as evidence, not as the grant
authority. Stores backing `GameServicesStore` must preserve these idempotency
dimensions:

- Purchase and ad reward entitlement grants dedupe by `source`, `playerId`, and
  `idempotencyKey`. A purchase and rewarded-ad grant may use the same
  `idempotencyKey` for the same player without colliding because their `source`
  values differ.
- Duplicate entitlement grants return the original `ledgerEntryId` with
  `alreadyProcessed: true`. Platform transaction ids, impression ids, and other
  payload fields are evidence payload, not entitlement idempotency dimensions.
- Leaderboard records dedupe by `target`, `leaderboardId`, `playerId`, and
  `runId`. Retries with a different score, submission timestamp, or
  `platformSubmissionId` reuse the original `ledgerEntryId`.
- `ledgerEntryId` values are stable opaque strings. Do not parse them for game
  state decisions; persist and compare the idempotency dimensions instead.

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
D1 database, run `apps/game-services-worker/migrations/0001_game_services.sql`,
uncomment the D1 binding, and set `MPGD_STORE = "d1"`.

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
```

Use public HTTP/oRPC for external game clients and service binding RPC for
internal Cloudflare Worker-to-Worker calls.

## Target Notes

- Android purchase flow should follow Google Play Billing's server verification,
  grant, then acknowledge or consume sequence.
- iOS purchase flow should send StoreKit/App Store signed transaction evidence to
  the backend verifier.
- Apps in Toss IAP should support pending order recovery and complete product
  grant after partner backend grant succeeds.
- Rewarded ads should treat SDK reward callbacks as evidence. For AdMob-backed
  targets, server-side verification callbacks should be the backend grant signal.
- Apps in Toss rewarded ads must follow `loadFullScreenAd` then `showFullScreenAd`;
  rewards are tied to `userEarnedReward`, not `dismissed`.

## Production Gaps

This repository provides the reusable contract, client orchestration, backend
ledger boundary, memory/D1 store implementations, and a deployable Worker
starter. Game-specific production integrations still need these pieces:

- Google Play purchase token verification, acknowledgement, and consume flows.
- App Store Server API or signed StoreKit transaction verification.
- AdMob server-side verification callbacks for rewarded ads.
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
checks the service binding method surface through `createWorkerService()`.
