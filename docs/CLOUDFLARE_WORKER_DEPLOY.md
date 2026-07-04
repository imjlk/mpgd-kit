# Cloudflare Worker Deploy Runbook

`apps/game-services-worker` is the deployable backend starter for mpgd game
services. It uses the Cloudflare Vite plugin, keeps `wrangler.toml` as the
binding/deploy source of truth, and exposes three surfaces:

- public JSON endpoints under `/game-services/*`
- oRPC v2 beta procedures under `/rpc/*`
- `WorkerEntrypoint` methods for service binding RPC

The default config uses `MPGD_STORE = "memory"` so local checks run without
cloud resources. Production-like deploys should switch to D1.

## Local Dev

```sh
pnpm --dir apps/game-services-worker dev
```

Smoke the Worker implementation without a Cloudflare account:

```sh
pnpm smoke:game-services:worker
```

Build the Worker:

```sh
pnpm --dir apps/game-services-worker build
```

## Public HTTP and oRPC Smoke

Start local dev, then in another shell:

```sh
curl http://localhost:5173/health
```

JSON endpoint smoke:

```sh
curl -X POST http://localhost:5173/game-services/purchases/verify \
  -H 'content-type: application/json' \
  -d '{
    "target": "android",
    "playerId": "local-player",
    "productId": "COINS_100",
    "platformTransactionId": "local-txn-1",
    "idempotencyKey": "local-purchase-1",
    "purchasedAt": "2026-07-04T00:00:00.000Z"
  }'
```

The oRPC surface is available under `/rpc/*`. Game clients can use
`createGameServicesOrpcClient({ url: "https://example.com/rpc" })`, while the
legacy-style JSON transport can use `createGameServicesFetchBackendTransport()`.

## Enable D1 Persistence

Create the database:

```sh
pnpm --dir apps/game-services-worker exec wrangler d1 create mpgd-game-services
```

Copy the generated `database_id` into `apps/game-services-worker/wrangler.toml`
and uncomment the D1 binding:

```toml
[vars]
MPGD_STORE = "d1"

[[d1_databases]]
binding = "DB"
database_name = "mpgd-game-services"
database_id = "<generated-database-id>"
```

Apply migrations locally:

```sh
pnpm --dir apps/game-services-worker exec wrangler d1 migrations apply mpgd-game-services --local
```

Apply migrations remotely:

```sh
pnpm --dir apps/game-services-worker exec wrangler d1 migrations apply mpgd-game-services --remote
```

Then rebuild and deploy:

```sh
pnpm --dir apps/game-services-worker build
pnpm --dir apps/game-services-worker deploy
```

## Service Binding RPC

The Worker class extends `WorkerEntrypoint`, so another Worker can call game
services internally without going through a public HTTP URL.

Consumer Worker binding:

```toml
[[services]]
binding = "GAME_SERVICES"
service = "mpgd-game-services"
```

Consumer Worker usage:

```ts
const purchase = await env.GAME_SERVICES.verifyPurchase({
  target: 'android',
  playerId: 'player-1',
  productId: 'COINS_100',
  platformTransactionId: 'txn-1',
  idempotencyKey: 'purchase-1',
  purchasedAt: new Date().toISOString(),
});
```

The current service binding methods are:

- `verifyPurchase(input)`
- `claimAdReward(input)`
- `recordLeaderboardScore(input)`

## Production Notes

- Keep secrets out of `wrangler.toml`; use Cloudflare secret management for real
  API credentials.
- `MPGD_STORE = "memory"` is sample-only. Use D1 for persistence.
- The Worker verifies sample product/ad evidence today. Real Google Play,
  App Store, AdMob SSV, and Apps in Toss verification adapters are described in
  [Production Integration Roadmap](PRODUCTION_INTEGRATION_ROADMAP.md).
- Prefer service binding RPC for Worker-to-Worker calls and public HTTP/oRPC for
  external game clients.

## References

- Cloudflare Workers Vite plugin: <https://developers.cloudflare.com/workers/vite-plugin/>
- Cloudflare D1 getting started: <https://developers.cloudflare.com/d1/get-started/>
- Cloudflare D1 Wrangler commands: <https://developers.cloudflare.com/d1/wrangler-commands/>
- Worker service binding RPC: <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/>
