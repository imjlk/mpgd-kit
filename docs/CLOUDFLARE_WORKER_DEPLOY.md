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

## Guest Identity Worker

`apps/game-identity-worker` is the reference identity service for mobile
games: server-issued guest sessions now, account linking later. The
game-services Worker reaches it through service bindings; the game reaches it
over HTTP with `createGuestSessionHttpBackend` (the generated game's
`src/platform/guestIdentity.ts`, configured with `VITE_MPGD_IDENTITY_URL`).

**Sessions.** `POST /identity/v1/guest` (`{ installationId }`) issues a new
player and session family; `POST /identity/v1/refresh` (`{ refreshToken }`)
rotates the refresh token inside the same family; `POST /identity/v1/revoke`
ends the family (and answers `200` for a token it does not know, as
[RFC 7009 section 2.2](https://www.rfc-editor.org/rfc/rfc7009#section-2.2)
asks); `POST /identity/v1/bind-account` answers `501
ACCOUNT_BINDING_UNSUPPORTED`, the seam for Sign in with Apple or Google later.
Token answers carry `Cache-Control: no-store`
([RFC 6749 section 5.1](https://www.rfc-editor.org/rfc/rfc6749#section-5.1)).
The token model follows
[RFC 9700 section 4.14.2](https://www.rfc-editor.org/rfc/rfc9700#section-4.14.2)
for a public client:

- Access tokens are opaque and short-lived (15 minutes,
  `IDENTITY_ACCESS_TOKEN_TTL_SECONDS`). Refresh tokens rotate on every
  refresh; the family id (`sessionFamilyId`, also the session id the
  notifications Worker sees) never changes.
- Presenting a refresh token the family has already replaced revokes the
  whole family and ends its notification session: one of two parties holds a
  stolen copy, and the server cannot tell which.
- One exception keeps mobile guests from being lost: the token replaced by
  the latest rotation may be presented again while its successor has never
  been used, up to `IDENTITY_REFRESH_RETRY_GRACE_SECONDS` (default 7 days, or
  half the inactivity window if that is shorter; `0` is strict rotation; an
  explicit value must stay below the inactivity window, or every route
  answers `503` and the log names the setting). A phone that lost the
  rotation's answer, or that the OS suspended mid-request, keeps the old token
  and presents it at its next launch; strict detection would end that guest for
  good. A retry is answered with the **same** successor: each rotation derives
  the new refresh token from the old one and a nonce stored with the family
  (never sent), so a lost answer, a retried request, an abandoned request that
  finishes late, or two refreshes racing all end up holding one token, and no
  answer invalidates another. The cost: a stolen copy of the replaced token
  can obtain that same successor inside the window. If the device refreshes
  next, the stolen token then reads as a replay and ends the family; if the
  thief refreshes first and both keep refreshing within the window of each
  other's rotation, each is answered as a retry and neither is detected.
  Stealing a refresh token needs the device's Keychain or Keystore item
  (device-only, not backed up), so the default favours keeping guests; set
  the grace shorter, or `0`, when detection matters more than a lost answer.
- A family ends after `IDENTITY_REFRESH_IDLE_DAYS` (180) without a refresh
  ("Refresh tokens SHOULD expire if the client has been inactive for some
  time"); each refresh extends it. A guest who stays away longer comes back as
  a new guest, without the old player's purchases, until account linking
  exists.
- Only SHA-256 hashes of tokens are stored. Every table carries `player_id`,
  so deleting a player (L3b) is one key across all of them.
- New guests are limited to `IDENTITY_MAX_GUESTS_PER_INSTALLATION_PER_DAY` (5)
  per installation in D1. The installation id is client-chosen, so that limit
  only stops a misbehaving client: bind the optional
  `IDENTITY_ISSUE_RATE_LIMITER`
  ([Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
  keyed by `CF-Connecting-IP`; its counts are per Cloudflare location and
  approximate) in production.

**Deploy.**

```sh
pnpm --dir apps/game-identity-worker exec wrangler d1 create game-identity
# In apps/game-identity-worker/wrangler.toml: uncomment [[d1_databases]] and put
# the database_id there (keep binding = "DB"), set MPGD_STORE = "d1", uncomment
# [[ratelimits]] (Wrangler 4.36+; a namespace_id unique in the account; period
# 10 or 60), and uncomment [triggers] for the hourly purge.
pnpm --dir apps/game-identity-worker exec wrangler d1 migrations apply game-identity --remote
pnpm --dir apps/game-identity-worker run deploy
```

`MPGD_STORE = "memory"` serves only local development hosts (loopback,
`*.localhost`, `10.0.2.2`): sessions would vanish with each isolate. A native
shell build only reaches `https:` origins (its content security policy is
`connect-src 'self' https: wss:`), so point a device or emulator at the Worker
through an https tunnel, not `http://10.0.2.2`. The hourly
cron purges ended families (after 7 days) and expired tokens in bounded
500-row statements, up to 50 rounds a run (a backlog continues on the next
run); without it they accumulate. A guest's issuance limit is checked in the
same D1 transaction as its writes, so concurrent requests cannot exceed it.

**Bind the game-services Worker to it.** The entrypoint names are the ones
its `wrangler.toml` examples use:

```toml
[[services]]
binding = "GAME_SERVICES_INGRESS_AUTH"
service = "game-identity"
entrypoint = "GameServicesIngressAuth"

[[services]]
binding = "GAME_SERVICES_NOTIFICATIONS_AUTH"
service = "game-identity"
entrypoint = "NotificationSessions"

[[services]]
binding = "GAME_SERVICES_GOOGLE_PLAY_ACCOUNT_BINDING"
service = "game-identity"
entrypoint = "GooglePlayAccountBinding"
```

`GameServicesIngressAuth` answers `{ playerId }` for a live access token,
`NotificationSessions` answers `{ playerId, sessionId, installationId,
expiresAt }` (the family's end), and `GooglePlayAccountBinding` answers the
player's `obfuscatedAccountId` (`null` for a player it did not issue). The
game-owned iOS verifier Worker binds `AppStoreAccountBinding` and calls its
`resolveAppAccountToken({ playerId })` from the App Store verifier's
`resolveAppAccountToken` (a `null` answer is an unknown player: throw, so the
purchase is refused). Both values are the same digests the generated game
derives on the device (`src/platform/commerceAccountBinding.ts`). In the iOS
verifier Worker:

```toml
[[services]]
binding = "GAME_IDENTITY_APP_STORE"   # any name the verifier reads
service = "game-identity"
entrypoint = "AppStoreAccountBinding"
```

```ts
// AppStoreDependencyUnavailableError from @mpgd/game-services/app-store-verifier
resolveAppAccountToken: async ({ playerId }) => {
  let token: string | null;
  try {
    token = await env.GAME_IDENTITY_APP_STORE.resolveAppAccountToken({ playerId });
  } catch {
    // An identity Worker outage leaves the purchase pending (retried), not refused.
    throw new AppStoreDependencyUnavailableError('The identity Worker is unavailable.');
  }
  if (token === null) {
    throw new Error('Unknown player.');
  }
  return token;
},
```

The identity Worker binds back to end a revoked family's notification
session at once:

```toml
# apps/game-identity-worker/wrangler.toml
[[services]]
binding = "GAME_SERVICES"
service = "mpgd-game-services"
```

The two Workers bind each other, so deploy the identity Worker first without
`GAME_SERVICES`, then the game-services Worker with its identity bindings, then
the identity Worker again with `GAME_SERVICES`. Without it, a revoked family's
devices are unbound when its `expiresAt` passes. Each service-binding call
counts toward a request's limit of 32 Worker invocations
([service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)):
the ingress authentication is one, and a purchase adds its account binding
and verifier calls.

Not served by the reference Worker: `GAME_SERVICES_NOTIFICATIONS_IDENTITY`
(`resolveNotificationRecipient` maps a player to an Apps in Toss user key, and
a guest has none), `VERIFIED_LEADERBOARD_AUTH`, and account linking. Account
deletion is the next step (L3b).

### Reinstalls and new devices: durable purchases (launch blocker, open: L3c)

A guest is its refresh token in the device's secure store. When that store
is gone, the next launch is a **new guest**, and every store purchase the old
guest made still names the old one: Google Play returns it with the old
`obfuscatedAccountId`, StoreKit with the old `appAccountToken`. A restored
non-consumable (the template catalog's `REMOVE_ADS`) is then refused, so the
player who paid cannot get it back:

| Case | Secure store after it | Restore of a non-consumable |
|---|---|---|
| Android: uninstall and reinstall, "Clear storage", or a new device | Gone. The Keystore key and the encrypted file in `getNoBackupFilesDir()` are app-specific storage, which Android removes on uninstall ([app-specific storage](https://developer.android.com/training/data-storage/app-specific)), and that directory is always excluded from Auto Backup, so no restore brings it back ([Auto Backup](https://developer.android.com/identity/data/autobackup)) | Refused: `GOOGLE_PLAY_ACCOUNT_MISMATCH` |
| iOS: delete and reinstall on the same device | Usually kept. Keychain items have historically survived app deletion, but Apple does not document it, and its developer technical support calls it an implementation detail apps should not depend on ([Apple Developer Forums](https://developer.apple.com/forums/thread/36442)). The accessibility class does not change this | Works while the item survives (same guest) |
| iOS: new device (a backup of another device, Quick Start), or an erased device | Gone. The kit stores the token with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, not synchronizable (`SecureCredentialStorage.swift`), and "Items with this attribute do not migrate to a new device" ([Apple](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly)) | Refused: `APP_STORE_ACCOUNT_TOKEN_MISMATCH` |
| Any platform: logout, or 180 days without a refresh | The old family is ended | Refused, as above |

Consumables are not affected once granted (there is nothing to restore), and
grants already on the ledger stay with the old player id. No server path
moves them today: the Play and App Store verifiers refuse a purchase whose
account binding names another player (the codes above), App Store recovery
refuses a restore whose ledger grant belongs to another player
(`APP_STORE_RECOVERY_IDENTITY_MISMATCH`), and a settled lookup refuses one
(`LEDGER_GRANT_IDENTITY_MISMATCH`).

This blocks a launch that sells non-consumables. The follow-up L3c will move
a verified non-consumable entitlement to the current guest on restore; until
it lands, do not sell non-consumables, or say plainly in the store copy that
a reinstall on Android, a new device, or a logout loses them.

## Authenticated Snapshot Reads

Bind a private identity Worker that implements
`authenticateVerifiedLeaderboardSnapshot({ authorization })` and returns the
verified `{ participantId }` or `undefined`:

```toml
[[services]]
binding = "VERIFIED_LEADERBOARD_AUTH"
service = "game-leaderboard-auth"
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
has the scheduler. Without its table the reminder routes fail, and so does
the cron's reminder and notice step (the cron logs the missing table and
still sends due rows). Under the Korean rules, with a notice topic and a
provider that can carry notices (for example FCM), advertising and night consent writes
are still recorded, but their notice pushes are not scheduled (the failure
is logged), and records written before 0008 get a notice check only at the
player's next advertising or night record. The memory store keeps consent records and endpoints in one
isolate only, and the Worker refuses it next to a queue, whose consumer
runs in another isolate. The catalog,
the deployment, and the providers are checked on first use; a broken one
fails the notifications routes with 500 and `{ "error":
"NOTIFICATIONS_CONFIGURATION_REQUIRED" }`, which the notifications client
does not retry, and is logged once.

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

# Purges and the scheduler. On the Workers Paid plan, every minute is the
# recommended period (the purges run each time too). Do not enable this cron
# on the Workers Free plan: a cron invocation there has 10 ms of CPU and 50
# external subrequests, which this run cannot stay inside.
# Each run goes on in rounds until nothing is due, the wall budget is used, or
# another round would cross MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET (1,000 by
# default, under the paid cap of 10,000 as of 2026-02-11). The count is for
# that scheduled invocation only. The wall budget
# (MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS, 20 by default) must be shorter than
# the cron period; a value that is not shorter skips the scheduler. Each purge deletes
# at most 100 rows per statement, and at most 20 statements per table, so a
# backlog continues on the next run.
# MPGD_NOTIFICATIONS_DUE_BATCH sets each batch (25 by default, at most 100, and
# no larger than one round of the subrequest budget). A reminder fires no
# earlier than its time: the first run at or after it takes it unless the run's budget runs out
# first (a failed item waits a minute), and its send then waits for the provider's rate, the
# queue's consumer when one is bound, and the gate (quiet hours, the night window, limits).
[triggers]
crons = ["* * * * *"]
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
  `replaced`, a set-time refusal (`permission-required`,
  `request-missing`, `preference-off`, `advertising-consent-missing`),
  `capacity-exceeded` past 64 pending reminders, or `unavailable` when no
  device or account of the player maps the topic; a `fireAt` more than 90
  days ahead or a link the provider cannot take is a 400), and
  `POST /reminders/cancel` (`{ key }`, answers `{ cancelled }`). The
  session routes need the
  `GAME_SERVICES_NOTIFICATIONS_AUTH` binding (or, locally, the development
  sessions flag below): without it they answer 404,
  only `GET /providers` is served, and the Worker logs one warning naming
  the missing binding the first time a session route is asked for (a
  send-only Worker, which serves only `deliverNotification`, can ignore
  it). The
  identity Worker's side (the `NotificationSessions` entrypoint) is the
  reference guest identity Worker ([Guest Identity Worker](#guest-identity-worker));
  a game with its own identity service implements
  `authenticateNotificationSession` and calls `endNotificationSession` as
  **Sessions** above describes.
- **Local development sessions.** Without an identity service, a local
  Worker can take `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS =
  "true"` (a var, for example in `apps/game-services-worker/.dev.vars`,
  which is not committed). With it and no `GAME_SERVICES_NOTIFICATIONS_AUTH`
  binding, the session routes accept
  `Authorization: Bearer mpgd-dev.<playerId>.<sessionId>.<installationId>`
  (each id 1 to 64 letters, digits, `_`, or `-`; no `expiresAt`), and the
  Worker logs once that sessions are not authenticated. Anyone can write
  that header, so it is local-only by construction: the Worker refuses to
  build its fetch handler and its service (the first request or RPC fails)
  when the flag is set with `MPGD_STORE = "d1"`; its notifications are then
  misconfigured on every entry point (`deliverNotification` and
  `endNotificationSession` answer `NOTIFICATIONS_CONFIGURATION_REQUIRED`,
  the queue retries, the cron skips, and the reason is logged once). It
  ignores the flag, saying so once, when the
  binding is bound. On the memory store it still applies only to requests
  whose host is a local development host: `localhost`, `127.0.0.1`, `[::1]`,
  a `*.localhost` name, or `10.0.2.2` (the host machine as the Android
  emulator reaches it). A request to any other host, such as a deployed
  `workers.dev` name or a LAN address, answers 401 like any header the
  Worker does not recognize, and the Worker logs once why. The check reads
  the request's host, so it guards against a deployed Worker, not against
  your network: keep the local Worker listening on loopback (the dev
  server's default), since a client that reaches an exposed dev server can
  send `Host: localhost`. The service
  binding (`deliverNotification`, `endNotificationSession`), the queue, and
  the cron take no session, so a development session never reaches them.
  The game side is `createDevelopmentServerSession` in
  `@mpgd/game-services`, which refuses a production mode, and the starter
  uses it on the Vite dev server only (`VITE_MPGD_DEV_NOTIFICATION_SESSION`).
  The [live test runbook](NOTIFICATIONS_LIVE_TEST.md) runs this local
  Worker (`pnpm --dir apps/game-services-worker dev` with a linked
  `.dev.vars`) to send real pushes to an emulator.
  A client picks its own installation and session ids here, which the
  [Endpoint registry](specs/notifications/notifications-v2-rfc.md#endpoint-registry)
  forbids for any real deployment.
- **The client.** `createGameServicesNotificationsClient` in
  `@mpgd/game-services/notifications/client` calls these routes for the
  notifications runtime (`@mpgd/platform/notifications-runtime`). It takes
  the commerce client's `baseUrl`, `fetch`, and header resolver, the
  catalog `target` for device registrations, and the game's identity: the
  signed-in `{ playerId, sessionId }`, where `sessionId` is the one
  `authenticateNotificationSession` returns for that session's header, and
  a sign-in subscription. No request names a player or an installation.
  A 401 reaches the runtime as a retryable
  `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, and a 404 on a session route as
  `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
- **Sends** are never a client route: a game server calls
  `deliverNotification(input)` on the service binding. It answers
  `{ ok: true, value }` with the send's outcome, or `{ ok: false, error: {
  code, message, retryable } }`, because an error's fields do not cross the
  RPC boundary. Any Worker bound to this one can send to any player, as
  with the other service-binding methods.
- **Scheduler.** Each cron run fires the due server reminders as sends
  through the policy gate, pushes the consent notices nobody recorded by
  seven days before they are due (Korean rules, through the catalog's
  notice topic and only providers that send the notice's own text as
  free-form content: FCM does, while Apps in Toss and Devvit send templates
  or mapped texts that cannot state the record), and then sends the due
  rows (deferred sends, expired leases, and the scheduler's new sends),
  oldest first and at no more than each provider's rate. With the queue bound, the cron only takes those
  rows for the queue, and the consumer sends them; without it, the cron
  sends them itself. A refused notice push is tried again after an hour,
  doubling to a day, or as soon as the player registers a device again.
- **Reminder limits.** A player keeps at most 64 pending server reminders,
  and a `fireAt` at most 90 days ahead; a reminder set for a past time is
  due at once but queues behind those already due. A reminder the gate
  refuses when it comes due, such as after the player's registering session
  ended, is spent.
- **Throughput.** A run is bounded by its wall-time budget and by a
  subrequest budget, and it stops before another round would cross that
  budget. The count is the scheduled invocation's own D1 calls, queue
  sends, identity lookups, and provider fetches (each FCM token grant and
  `messages:send`, including a bare 401 retry), not a fixed charge per send,
  and a fetch, queue, or RPC event on the same isolate is not part of it.
  Check Cloudflare's current figures; as of 2026-02-11 the free plan
  allows 10 ms of CPU and 50 external subrequests per invocation (1,000
  subrequests to Cloudflare services such as D1), and the paid plan allows
  30 seconds of CPU for a cron whose interval is under an hour and 10,000
  subrequests per invocation (previously 1,000). Do not enable the one-minute
  cron on the free plan: 10 ms of CPU cannot run this scheduler. On the paid
  plan the default subrequest budget is 1,000
  (`MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET`), which fits either the current or
  the previous paid cap, and the default batch of 25 is one round inside
  that budget. A round is not started unless the allowance left after the
  purge can cover an estimate of sixteen operations per item (store calls
  plus the most fetches one FCM send can make); the calls themselves are
  counted as they happen. A wall budget that is not shorter than the cron
  period is rejected (the scheduler is skipped and the rejection is logged),
  so a one-minute cron cannot be given a 60-second budget. Keep the budget
  shorter than the cron period, or runs overlap; the scheduler's
  compare-and-set writes keep overlapping runs correct, but they compete
  for the same items. With the queue bound, the cron only writes the sends
  and takes their rows, and each consumer invocation makes its own provider
  calls under its own limits, so large waves need the queue.

<!-- @link ../apps/game-services-worker/src/notificationsHandler.ts#runScheduledNotifications Stops the cron before the subrequest budget and rejects a wall budget that is not shorter than the cron period. -->
<!-- @evidence docs/specs/notifications/notifications-v2-rfc.md#scheduler The service run is still bounded by its own wall-time budget; the Worker adds the platform limits. -->
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
  or `"anonymous"`, with optional `baseUrl` (only
  `https://apps-in-toss-api.toss.im`; the repo documents no sandbox API
  host), `timeoutMs`,
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
    Documented codes win over that list: 4095 stays a rate limit, and
    5004, 4034, and 4010 stay configuration failures, so a rate limit is
    not stored as an agreement denial.
    Without them such an answer is a `recipient` refusal, no denial is
    recorded, and every later send to that player calls the partner API
    again, against its limit of 10 calls per minute per user.

<!-- @link ../packages/game-services/src/notifications/ait-functional-delivery.ts#createAitFunctionalMessageDeliveryProvider Allowlisted baseUrl, and documented error codes before deployment lists. -->
<!-- @evidence docs/specs/notifications/notifications-v2-rfc.md#remote-delivery Partner error-code order and the production API host. -->
<!-- @link ../apps/game-services-worker/src/notificationsD1.ts#createD1NotificationStore Purge deletes in bounded LIMIT batches. -->

## Store refunds and Play finalization

The Worker revokes refunded App Store and Google Play purchases and finishes
Play purchases whose client went away. Each piece is off until it is
configured; see
[Store refunds and server-side finalization](GAME_SERVICES_BACKEND.md#store-refunds-and-server-side-finalization)
for the ledger rules.

### App Store Server Notifications V2

The Worker mounts `POST /app-store/notifications/v2` (production) and
`POST /app-store/notifications/v2/sandbox` when the verifier binding is set.
Apple's library does not run in this Worker: bind the game-owned iOS verifier
Worker (the one that already verifies purchases with Apple's root
certificates) and set the bundle id:

```toml
[vars]
GAME_SERVICES_APP_STORE_BUNDLE_ID = "com.example.game"

[[services]]
binding = "GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER"
service = "game-evidence-verifier-ios"
entrypoint = "AppStoreNotificationVerifier"
```

The binding implements
`verifyAppStoreServerNotification({ signedPayload, environment, bundleId, timeoutMs })`
and answers the verifier result, or `{ status: 'unavailable' }` for a
transient certificate-check outage (errors lose their class across a binding):

```ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import { AppStoreDependencyUnavailableError } from '@mpgd/game-services/app-store-verifier';
import { createAppleServerNotificationVerifier } from '@mpgd/game-services/app-store-server';

export class AppStoreNotificationVerifier extends WorkerEntrypoint<Env> {
  async verifyAppStoreServerNotification(input: {
    signedPayload: string;
    environment: 'Production' | 'Sandbox';
    bundleId: string;
    timeoutMs: number;
  }) {
    const verifier = createAppleServerNotificationVerifier({
      rootCertificates: appleRootCertificates(this.env), // Apple's root CA files, DER
      environment: input.environment,
      bundleId: input.bundleId,
      ...(input.environment === 'Production' ? { appAppleId: Number(this.env.APP_APPLE_ID) } : {}),
    });
    try {
      return await verifier.verifyAndDecodeNotification({
        ...input,
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch (error) {
      if (error instanceof AppStoreDependencyUnavailableError) {
        return { status: 'unavailable' as const };
      }
      throw error;
    }
  }
}
```

In App Store Connect, open the app, then App Information, App Store Server
Notifications, and set Version 2 with:

- Production Server URL: `https://<worker-host>/app-store/notifications/v2`
- Sandbox Server URL: `https://<worker-host>/app-store/notifications/v2/sandbox`

Apple allows the same URL for both
([Enabling App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications/enabling-app-store-server-notifications));
the kit uses two so each environment is verified on its own. Check the route
with the App Store Server API's
[Request a Test Notification](https://developer.apple.com/documentation/appstoreserverapi/request-a-test-notification):
a `TEST` notification answers 200 `ignored`. Allow Apple's notification subnet (`17.0.0.0/8`) if the host
filters by IP.

A `REFUND_REVERSED` for a grant an App Store refund revoked is answered 200
and logged at warn (`App Store refund reversed: player … grant …`) with a
ledger note in `entitlement_notes`; nothing is re-granted. One for a grant not
revoked yet is answered 503 so Apple redelivers it after the refund (the log
line names its notification id); one for a grant revoked for another reason
is answered 200 and ignored. Route that warning to support;
[Re-granting after a refund reversal](GAME_SERVICES_BACKEND.md#re-granting-after-a-refund-reversal)
shows the re-grant.

For App Review, the iOS verifier Worker also constructs its purchase verifier
with `sandboxPurchases: { mode: 'grant', ... }`; see
[App Review and TestFlight purchases](GAME_SERVICES_BACKEND.md#app-review-and-testflight-purchases-on-a-production-backend).

### Google Play: voided purchases and owed acknowledges

Both run from the cron with the in-Worker Play boundary
(`GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME` with
`GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH`) and a D1 store. Apply
`0009_store_server.sql` (additive: the owed-finalization table and the sweep
cursors). Both act on grants the in-Worker Play boundary verified (their
verification id is the purchase token's digest): a grant verified by
`GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER` keeps the binding's own id, so the
sweep does not find it and its token is never kept for a retry. A deployment
that finalizes through `GAME_SERVICES_ANDROID_PURCHASE_FINALIZER` or its
verifier binding gets neither; that finalizer owns its retries and refunds.

- **Owed acknowledges and consumes.** With D1, the in-Worker Play finalizer
  keeps each purchase token in `google_play_pending_finalizations` before it
  calls Play and drops it when the acknowledge or consume completes. The cron
  retries what is still owed 1, 5, and 15 minutes, 1 and 3 hours, then every
  6 hours after the last attempt, and stops at Play's three-day window: Google
  then refunds the purchase and the sweep revokes the grant. The table holds
  raw purchase tokens; the ledger does not.
- **Voided purchases.** The cron reads the Voided Purchases API every
  `MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES` (60 by default, `0` turns it off)
  and revokes each voided grant. It reads its window in week-long slices and
  moves its cursor past each finished one, so the first run's 30-day window,
  or a backlog after an outage, is worked through over later runs (at most 20
  API pages a run; Google allows 30 queries in 30 seconds). A slice whose
  voids do not fit in one run is halved, down to a minute; voids older than
  Google's 30 days are logged as gone.
- **Play Console.** The service account the publisher-auth service signs for
  needs, under Users and permissions, the app's "View financial reports"
  permission for the Voided Purchases API and "Manage orders and
  subscriptions" for acknowledge and consume (Play Console's names; check them
  in your console, they change). Real-time developer notifications (a Pub/Sub
  topic under Monetization setup) are optional and not consumed by the Worker
  yet; the sweep is what keeps the ledger correct.

The cron shares the notifications trigger:

```toml
[triggers]
# Workers Paid only. A free-plan cron has 10 ms of CPU and 50 external subrequests.
crons = ["* * * * *"]

[vars]
# Optional tuning of the store server run (defaults shown).
# MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES = "60"
# MPGD_STORE_SERVER_SUBREQUEST_BUDGET = "300"
# MPGD_STORE_SERVER_CRON_BUDGET_SECONDS = "15"
```

Each scheduled run retries up to 20 owed finalizations within half of
`MPGD_STORE_SERVER_SUBREQUEST_BUDGET` and half of the wall budget (the other
halves are kept for the sweep),
then sweeps when the interval has passed or a previous run stopped behind,
and stops at the budget (D1 calls, token-service calls, and Play requests,
counted by estimate) or the wall budget, which is kept below the cron period.
The sweep cursor only moves forward. The 15-minute overlap that catches
late-recorded voids is re-read in ordinary slices before the cursor; a run
that cannot finish it keeps its place (`google-play-voided:reread`) and the
next run resumes there, so a dense overlap is split across runs. It is counted apart from
the notifications run (`MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET`, 1,000 by
default); together (1,300 by default) they stay under the Workers Paid cap of
10,000 subrequests per invocation in effect since 2026-02-11, not under the
earlier cap of 1,000. A void whose revocation keeps failing on a store error
holds the sweep for 30 runs, then is skipped with a log line naming its
order id, to be revoked by hand.

## Production Notes

- Keep secrets out of `wrangler.toml`; use Cloudflare secret management for real
  API credentials.
- `MPGD_STORE = "memory"` is sample-only. Use D1 for persistence.
- Apply `0001_game_services.sql`, `0002_verified_leaderboards.sql`, and
  `0003_verified_leaderboard_metrics.sql`, then
  `0004_entitlement_evidence.sql` in order before switching an existing
  deployment to D1.
- Apply `0009_store_server.sql` (the owed Play finalizations and the sweep
  cursors) before deploying a Worker version that has them: without the
  table, the purchase path's outbox write fails (logged, the purchase is
  unaffected) and that purchase gets no server-side acknowledge retry.
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
