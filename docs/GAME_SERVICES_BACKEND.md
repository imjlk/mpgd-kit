# Game Services Backend

The reusable monetization and social path is ledger-first:

1. A target adapter collects platform evidence.
2. `@mpgd/game-services-client` submits that evidence to backend APIs.
3. Backend game services decide whether a grant or score is accepted.
4. Game save state changes only after the backend response is accepted.

This keeps client callbacks from becoming the source of truth.

## Packages

- `@mpgd/game-services-contract`: oRPC v2 beta contract for the authoritative
  purchase, ad reward, leaderboard, and health procedures.
- `@mpgd/game-services-client`: reusable client orchestration for purchase, rewarded ad,
  and leaderboard score flows. It exports legacy-style JSON endpoint transport,
  fetch transport, and an oRPC client adapter.
- `@mpgd/backend-game-services`: authoritative backend implementation. It owns
  the async `GameServicesStore` interface, memory store, JSON endpoint handler,
  oRPC router, and fetch handler helpers.
- `apps/game-services-worker`: Cloudflare Worker starter. It exposes public
  `/game-services/*` JSON endpoints, `/rpc/*` oRPC procedures, `/health`, and
  `WorkerEntrypoint` methods for service binding RPC.
- `@mpgd/backend-purchase-verifier`: verifies product availability and records
  purchase grants in the entitlement ledger.
- `@mpgd/backend-ad-reward-ledger`: records rewarded ad grants from completed
  rewarded placements.
- `@mpgd/backend-leaderboard-ledger`: records idempotent leaderboard score
  submissions.
- `@mpgd/backend-entitlement-ledger`: shared grant transaction types and
  idempotency helpers used by stores.

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
} from '@mpgd/game-services-client';

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
} from '@mpgd/game-services-client';

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
  createInProcessGameServicesBackendTransport,
  createGameServicesBackendApiHandler,
} from '@mpgd/backend-game-services';
import { createGameServicesHttpBackendApi } from '@mpgd/game-services-client';

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
