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
- `recordVerifiedAttempt(input)` for trusted attempt coordinators
- `getSnapshot(input)` for verified leaderboard reads
- `deliverNotification(input)` and `endNotificationSession(input)` for
  notifications v2 (see [Notifications v2](#notifications-v2))

The verified-attempt writer is intentionally available only through the
private service binding. It is not routed through the public JSON or oRPC
surfaces.

## Authenticated Snapshot Reads

Bind a private identity Worker that implements
`authenticateVerifiedLeaderboardSnapshot({ authorization })` and returns the
verified `{ participantId }` or `undefined`:

```toml
[[services]]
binding = "VERIFIED_LEADERBOARD_AUTH"
service = "game-identity"
```

The binding enables the read-only route while keeping participant scope out of
client-controlled query parameters:

```sh
curl 'https://example.com/game-services/verified-leaderboard/snapshot?leaderboardId=daily%3A2030-01-02&limit=25' \
  -H 'authorization: Bearer <session-token>'
```

Continue with the opaque `nextCursor` returned by the prior response. Cursors
are keyset positions bound to the board definition, not credentials or stable
snapshot locks. The Worker returns private, non-cacheable responses and never
mounts a public verified-attempt write route.

## Notifications v2

The Worker serves the notifications v2 backend
([RFC](specs/notifications/notifications-v2-rfc.md#server)) once it has a
topic catalog. It needs D1 for anything but local development: apply
`0007_notifications.sql` and `0008_notification_scheduler.sql` with the
other migrations, and apply 0008 before deploying a Worker version that
has the scheduler: without its table the reminder routes, advertising and
night consent writes under the Korean rules, and the cron's reminder and
notice step fail (the cron logs the missing table and still sends due
rows). The memory store keeps
consent records and endpoints in one isolate only, and the Worker refuses
it next to a queue, whose consumer runs in another isolate. The catalog,
the deployment, and the providers are checked on first use; a broken one
fails the notifications routes with 500 and is logged once.

```toml
[vars]
# The game's notification topic catalog and deployment settings, as JSON vars.
MPGD_NOTIFICATIONS_CATALOG = { version = "2026-10-19", defaultLocale = "ko", topics = [] }
MPGD_NOTIFICATIONS_DEPLOYMENT = { advertisingRules = "kr", advertisingSender = { contact = "02-000-0000" } }

# Authenticated game-services sessions for the client routes.
[[services]]
binding = "GAME_SERVICES_NOTIFICATIONS_AUTH"
service = "game-identity"
entrypoint = "NotificationSessions"

# Fan-out through a queue (optional; without it a send fans out inline).
[[queues.producers]]
binding = "NOTIFICATIONS_QUEUE"
queue = "mpgd-notifications"

[[queues.consumers]]
queue = "mpgd-notifications"
max_retries = 5
dead_letter_queue = "mpgd-notifications-dead"

# Purges and the scheduler: due reminders and notice checks, then due sends (25 of each per
# run unless MPGD_NOTIFICATIONS_DUE_BATCH says otherwise; each item costs several D1 queries
# and subrequests, so the default suits the paid plan, and the free plan's limits need a
# smaller batch). A reminder fires no earlier than its time: the first run at or after it takes
# it unless more due items are ahead of it than one batch holds, and the gate may still defer
# it (quiet hours, the night window, provider limits).
[triggers]
crons = ["*/5 * * * *"]
```

FCM sends for `android` and `ios` once the service-account key is a secret:

```sh
pnpm --dir apps/game-services-worker exec wrangler secret put FCM_SERVICE_ACCOUNT
```

- **Sessions.** `authenticateNotificationSession({ authorization })` returns
  `{ playerId, sessionId, installationId, expiresAt? }`. The installation is
  the session's, never a request field, and the identity service vouches
  for it (it issued the id, or bound it to the session); a client-chosen id
  could take over another installation's endpoint. `sessionId` stays the same across
  refreshes. Call `endNotificationSession({ sessionId })` on the service
  binding at logout or revocation. `expiresAt` is when the whole session
  (its refresh family) ends, not when one access token expires: the
  session's devices are unbound from then. Return the family's current end
  on every call; when it is later than the stored one, the session's
  endpoints move to it, so an extended session keeps its devices (until the
  cron purges an endpoint whose end passed; then the client registers
  again). Omit `expiresAt` only for a session that never ends on its own:
  it clears the end of each of the session's endpoints that has one, and no
  later extension restores it (a new registration writes its own). An
  extension does not count as a registration, so an endpoint not
  registered for 60 days still goes stale.
- **Client routes** under `/game-services/notifications`: `GET /providers`
  (public), and with a session `GET`/`POST /consent`, `POST /endpoints`
  (`{ registration, target }`; `target` is `android` or `ios`, whose catalog
  mapping applies), `POST /endpoints/unregister`, `GET /notices`, and
  `POST /notices/shown`, `POST /reminders` (`{ reminder: { key, topic,
  fireAt, templateData?, link? } }`, answers `{ status }`: `scheduled`,
  `replaced`, or the set-time refusal `permission-required`,
  `request-missing`, `preference-off`, `advertising-consent-missing`), and
  `POST /reminders/cancel` (`{ key }`, answers `{ cancelled }`). The
  session routes need the
  `GAME_SERVICES_NOTIFICATIONS_AUTH` binding: without it they answer 404,
  only `GET /providers` is served, and the Worker logs one warning naming
  the missing binding the first time a session route is asked for (a
  send-only Worker, which serves only `deliverNotification`, can ignore
  it). The
  identity Worker's side (the `NotificationSessions` entrypoint) is a
  follow-up and is not in this repository yet.
- **Sends** are never a client route: a game server calls
  `deliverNotification(input)` on the service binding. It answers
  `{ ok: true, value }` with the send's outcome, or `{ ok: false, error: {
  code, message, retryable } }`, because an error's fields do not cross the
  RPC boundary. Any Worker bound to this one can send to any player, as
  with the other service-binding methods.
- **Scheduler.** Each cron run fires the due server reminders as sends
  through the policy gate, pushes the consent notices nobody recorded by
  seven days before they are due (Korean rules, through the catalog's
  notice topic, through providers that send free-form content of the
  notice's own text, which FCM does and Apps in Toss and Devvit do not:
  their templates or mapped texts cannot state the record), and then sends the due rows (deferred sends, expired
  leases, and the scheduler's new sends), oldest first and at no more than
  each provider's rate. With the queue bound, the cron only takes those
  rows for the queue, and the consumer sends them; without it, the cron
  sends them itself. A refused notice push is tried again after an hour,
  doubling to a day, or as soon as the player registers a device again.
- **Queue.** A job that cannot run as asked is logged and acknowledged; any
  other failure is retried with a growing delay (10 s, doubling, at most
  5 min). While the notifications configuration is broken (a catalog or
  secret that does not validate), every job is retried the same way, for
  the consumer's `max_retries` (about five minutes with the settings
  above), and then goes to the dead-letter queue. A Worker without
  `MPGD_NOTIFICATIONS_CATALOG` has notifications off and acknowledges its
  jobs. Either way the rows stay due, and the cron replays them once the
  configuration is fixed.
- **Platform-user providers** resolve recipients through an optional
  `GAME_SERVICES_NOTIFICATIONS_IDENTITY` binding
  (`resolveNotificationRecipient({ provider, playerId })`).
- **Apps in Toss** functional messages serve the `ait` target when the
  partner API's client certificate is bound as `AIT_PARTNER_MTLS` (a
  `[[mtls_certificates]]` binding) and `MPGD_AIT_NOTIFICATIONS` names the
  recipient key: `{ recipientKey = "toss-user" }` (a Toss login user key)
  or `"anonymous"`, with optional `baseUrl`, `timeoutMs`,
  `agreementErrorCodes`, `agreementFailReasons`, and
  `recipientErrorCodes`. It needs the identity binding above, which answers
  the player's key for provider `apps-in-toss`: a key from an authenticated
  Toss login or the protected key mapping, never one a client sent (see
  [Apps in Toss production evidence](APPS_IN_TOSS_PRODUCTION_EVIDENCE.md#functional-messages)).
  A Worker with only one of the two, without the identity binding, or with
  an unknown or invalid setting is misconfigured (500 on the routes, logged
  once with the setting's name), and so are its FCM sends. Each catalog
  topic maps `targets.ait` to `{ templateSetCode, agreement }`.
  - Name the partner API's codes for a recipient who has not agreed
    (`agreementErrorCodes`, `agreementFailReasons`) once you observe them.
    Without them such an answer is a `recipient` refusal, no denial is
    recorded, and every later send to that player calls the partner API
    again, against its limit of 10 calls per minute per user.

## Production Notes

- Keep secrets out of `wrangler.toml`; use Cloudflare secret management for real
  API credentials.
- `MPGD_STORE = "memory"` is sample-only. Use D1 for persistence.
- Apply `0001_game_services.sql`, `0002_verified_leaderboards.sql`, and
  `0003_verified_leaderboard_metrics.sql`, then
  `0004_entitlement_evidence.sql` in order before switching an existing
  deployment to D1.
- The Worker verifies sample product/ad evidence by default. Real Google Play,
  App Store, and Apps in Toss verification adapters are described in
  [Production Integration Roadmap](PRODUCTION_INTEGRATION_ROADMAP.md). AdMob
  backends can inject the reusable [SSV verifier](ADMOB_SSV.md) after providing
  durable raw-callback persistence and rotating public keys.
- Prefer service binding RPC for Worker-to-Worker calls and public HTTP/oRPC for
  external game clients.

## References

- Cloudflare Workers Vite plugin: <https://developers.cloudflare.com/workers/vite-plugin/>
- Cloudflare D1 getting started: <https://developers.cloudflare.com/d1/get-started/>
- Cloudflare D1 Wrangler commands: <https://developers.cloudflare.com/d1/wrangler-commands/>
- Worker service binding RPC: <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/>
