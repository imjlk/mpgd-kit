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
ACCOUNT_BINDING_UNSUPPORTED`, the seam for Sign in with Apple or Google later;
`POST /identity/v1/account-deletion-confirmation` (`{ refreshToken }`)
answers `{ confirmation, expiresAt }` for account deletion (below).
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
  so deleting a player is one key across all of them.
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

Migrations: `0001_guest_identity.sql` (players, families, tokens) and
`0002_account_deletion.sql` (deletion confirmations); `migrations apply`
applies both.

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

[[services]]
binding = "GAME_SERVICES_ACCOUNT_DELETION"
service = "game-identity"
entrypoint = "AccountDeletion"
```

`GameServicesIngressAuth` answers `{ playerId }` for a live access token,
`NotificationSessions` answers `{ playerId, sessionId, installationId,
expiresAt }` (the family's end), and `GooglePlayAccountBinding` answers the
player's `obfuscatedAccountId` (`null` for a player it did not issue).
`AccountDeletion` serves the game-services deletion route
([account deletion](GAME_SERVICES_BACKEND.md#account-deletion)):
`verifyAccountDeletionConfirmation({ playerId, confirmation })` answers
`{ confirmed }` and uses a confirmed one up, and `deletePlayer({ playerId })`
deletes the player with every family and token in one transaction
(idempotent; an unknown player is not an error), so its access token fails
both auth entrypoints and its refresh tokens are unknown to `refresh`, the
retry grace included, at once. A confirmation is issued only to the
current refresh token (or, inside the retry grace, the replaced one while its
successor is unused), lives 5 minutes, is single use, is bound to the
player, and replaces the family's earlier one; a token the route refuses is
`401 GUEST_SESSION_REJECTED`, without revoking anything (replays are the
refresh route's to detect). `IDENTITY_ISSUE_RATE_LIMITER` limits the
confirmation route per address too. Deleting a player removes its families,
so they no longer count toward the per-installation guest limit; the address
limiter is the control that matters there. The game-owned iOS verifier Worker binds `AppStoreAccountBinding` and calls its
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
a guest has none), `VERIFIED_LEADERBOARD_AUTH`, and account linking.

### Reinstalls and new devices: restore sharing

A guest is its refresh token in the device's secure store. When that store
is gone, or on a second device, the game runs as a **new guest**, and every
store purchase still names the guest that made it: Google Play returns it with
that guest's `obfuscatedAccountId`, StoreKit with its `appAccountToken`.

| Case | Secure store after it | Restore of a non-consumable (`GAME_SERVICES_RESTORE_SHARING` default) |
|---|---|---|
| Android: uninstall and reinstall, "Clear storage", or a new device | Gone. The Keystore key and the encrypted file in `getNoBackupFilesDir()` are app-specific storage, which Android removes on uninstall ([app-specific storage](https://developer.android.com/training/data-storage/app-specific)), and that directory is always excluded from Auto Backup, so no restore brings it back ([Auto Backup](https://developer.android.com/identity/data/autobackup)) | Granted to the new guest too (Play still returns the old `obfuscatedAccountId`) |
| iOS: delete and reinstall on the same device | Usually kept. Keychain items have historically survived app deletion, but Apple does not document it, and its developer technical support calls it an implementation detail apps should not depend on ([Apple Developer Forums](https://developer.apple.com/forums/thread/36442)). The accessibility class does not change this | Works while the item survives (same guest) |
| iOS: new device (a backup of another device, Quick Start), or an erased device set up as new | Gone (a device restored from its own backup may get it back). The kit stores the token with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, not synchronizable (`SecureCredentialStorage.swift`), and "Items with this attribute do not migrate to a new device" ([Apple](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly)) | Granted to the new guest too (StoreKit still returns the old `appAccountToken`) |
| Any platform: logout, or `IDENTITY_REFRESH_IDLE_DAYS` (180 by default) without a refresh | The old family is ended | Granted, as above |
| Any platform: a second device on the same Apple ID or Google account | Its own guest | Granted on each device, up to the holder limit |

The reference Worker grants a restored non-consumable (the template
catalog's `REMOVE_ADS`) to the restoring guest as well: **restore sharing**
([GAME_SERVICES_BACKEND.md](GAME_SERVICES_BACKEND.md#restore-sharing),
[RFC](specs/commerce/commerce-v2-rfc.md#restore-sharing)). Apple's App
Review Guideline 3.1.1 asks for "a restore mechanism for any restorable
in-app purchases"
([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase)),
StoreKit hands a reinstall or a new device "all transactions ... upon initial
launch" ([`AppStore.sync()`](https://developer.apple.com/documentation/storekit/appstore/sync())),
and Google's billing guide expects a player who buys on one device to see the
item after they "switch devices"
([Integrate the Google Play Billing Library](https://developer.android.com/google/play/billing/integrate)).

- **What is shared.** A purchase the client sends with `intent: 'restore'`
  (the reconciler does for every purchase the store reported without this
  install starting it; after a reinstall the store reports the earlier
  guest's non-consumables only to the player's Restore Purchases action,
  which reads acknowledged Play purchases and StoreKit entitlements of
  another token too) of a **non-consumable**, which the store verified
  exactly as a new purchase (purchased, not refunded or revoked, right product
  and app) except that its account binding names another guest or none. The
  restoring guest gets its own grant, linked to the purchase; earlier holders
  keep theirs. On the App Store the client's StoreKit-verified JWS is
  required: a transaction id alone never shares a purchase.
- **Holder limit.** At most `GAME_SERVICES_RESTORE_MAX_HOLDERS` guests (5 by
  default, 1 to 100) hold one purchase at the same time, the buyer included.
  A restore past it answers `pending` with `PURCHASE_HOLDER_LIMIT_REACHED`
  (retryable; the starter says the purchase is already in use on the maximum
  number of devices) and evicts nobody. The client asks again only when the
  player taps Restore Purchases, not on every launch. The limit holds when restores race:
  every share takes the next slot of the purchase, so two writers that
  read the same holders collide and one reads again. It replaces a time-based
  rate limit: holders are never taken away, so a token passed around reaches
  at most the limit's number of guests in total, and the ledger keeps every
  share (player ids and the store's verification id, no other personal data).
- **Refunds and revocations.** A store refund, chargeback, or voided purchase
  revokes every holder's grant (the Play voided-purchase sweep, Play
  real-time developer notifications, and the App Store refund notification
  included), and a refunded purchase is never
  shared again. An operator's `admin` revocation stays on the grant it names.
- **What is not shared.** Consumables (there is nothing to restore once
  granted) and subscriptions (no subscription verifier yet). A checkout this
  client started (`intent` absent or `purchase`) keeps the binding check. The
  legacy App Store recovery backend (`createAppStoreRecoveryBackend`) keeps
  refusing (`APP_STORE_RECOVERY_IDENTITY_MISMATCH`).
- **Deleted accounts.** A deleted player's retained purchase record
  (`deleted:<id>`, kept for the retention period) is never revived for that
  id, and the deletion tombstone refuses any grant to it; it does not count
  toward the limit. A guest who restores the purchase gets a fresh grant
  linked to the purchase, which counts.
- **Abandoned guests count.** A guest that will never come back (an
  uninstalled app, a logout) keeps its place until account linking or an
  operator frees it with an `admin` revocation; a player who reinstalls more
  often than the limit reaches it.

Set `GAME_SERVICES_RESTORE_SHARING = "refuse"` to keep refusing restores
across guests (409 `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT` with reason
`GOOGLE_PLAY_ACCOUNT_MISMATCH` or `APP_STORE_ACCOUNT_TOKEN_MISMATCH`; see
[another account's purchase](./GAME_SERVICES_BACKEND.md#another-accounts-purchase));
then do not sell non-consumables, or say
in the store copy that a reinstall on Android, a new device, or a logout loses
them. No migration is needed: shares are ordinary grants.

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

### App Store revocation registry (offline-only purchases)

The iOS verifier Worker verifies purchases in `server-api` mode by default,
which reads every transaction's current status from the App Store Server API.
A deployment without Server API access can use
`signedTransactionEvidence: { mode: 'offline-only', maxSignedAgeMs, revocations }`
instead
([offline-only mode](GAME_SERVICES_BACKEND.md#backend-boundary)).
That mode needs a registry of the refunds and revocations App Store Server
Notifications reported. The registry must be shared by every isolate and
must survive restarts. Otherwise a client can present a JWS signed before its
refund and be granted again. This Worker keeps that registry in D1, next to
the notifications route that fills it. The iOS verifier Worker reads it
through a service binding back to this Worker. It does not get its own D1
binding.

Requirements:

- The App Store Server Notifications V2 route above, with both URLs set in
  App Store Connect. A refund Apple never notifies is never recorded.
- `MPGD_STORE = "d1"` and migration `0011_app_store_revocations.sql`
  applied (additive: one table, no player id).
- `GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY = "true"` on this Worker.
  The route then records every verified `REFUND` and `REVOKE` of the
  customer's own one-time purchase before it reads the ledger, whether or
  not a grant exists. For each environment and grant verification id it
  keeps the latest revocation, so a redelivery or an older notification
  that arrives late changes nothing. A production deployment that grants
  sandbox purchases records Production and Sandbox refunds separately, and a
  lookup only ever answers from its own environment. Apply 0011 before you set the flag. Until the table
  exists, every refund is answered 503 and Apple redelivers it.
- The iOS verifier Worker bound to this Worker's
  `GameServicesAppStoreRevocations` entrypoint. That entrypoint is
  read-only and exposes nothing else. It rejects calls unless the flag, the
  D1 store, and the notifications route are all configured, and it rejects
  a lookup for a bundle other than `GAME_SERVICES_APP_STORE_BUNDLE_ID`. A
  registry that nothing fills is therefore never served as "no refunds". On the memory store,
  the route records into one isolate's memory for local development, and
  the entrypoint still rejects. The flag must be the string `"true"`. Any
  other value, such as an unquoted TOML `true`, is logged once per isolate
  and records nothing.

Turn the flag on in `server-api` mode too, as soon as the route runs on D1.
Recording costs one D1 write per refund, and a later switch to
`offline-only` then starts with the refunds already recorded.

```toml
# This Worker
[vars]
GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY = "true"
```

```toml
# The iOS verifier Worker
[[services]]
binding = "GAME_SERVICES_APP_STORE_REVOCATIONS"
service = "mpgd-game-services"
entrypoint = "GameServicesAppStoreRevocations"
```

```ts
import {
  createAppStoreGameServicesEvidenceVerifier,
  createAppStoreRevocationLookupOverBinding,
} from '@mpgd/game-services/app-store-verifier';

const verifier = createAppStoreGameServicesEvidenceVerifier({
  // ...bundleId, environment, serverApi, signedTransactionVerifier,
  // resolveAppAccountToken as before
  clockSkewMs: 5 * 60 * 1000, // the default
  signedTransactionEvidence: {
    mode: 'offline-only',
    maxSignedAgeMs: 60 * 60 * 1000,
    revocations: createAppStoreRevocationLookupOverBinding(
      env.GAME_SERVICES_APP_STORE_REVOCATIONS,
    ),
  },
});
```

`createAppStoreRevocationLookupOverBinding` fails closed. If the binding
throws, answers `unavailable` or something malformed, or the verification is
aborted, the purchase stays `pending` (`APP_STORE_REVOCATION_LOOKUP_UNAVAILABLE`).
It is never granted without the check.

A recorded revocation refuses any JWS signed at or before its `revokedAt`
plus `clockSkewMs`. `revokedAt` is Apple's `revocationDate`, else the
notification's `signedDate`. Keep `clockSkewMs` at least as large as the
clock difference between Apple and the verifier Worker. A larger skew refuses
more pre-refund JWS. It also refuses a JWS that was re-signed within that
window after a `REFUND_REVERSED`. `REFUND_REVERSED` records nothing: a JWS
signed after the reversal carries no `revocationDate`, so it grants again, as
it would in `server-api` mode. A ledger grant that a refund already revoked
stays revoked
([re-granting](GAME_SERVICES_BACKEND.md#re-granting-after-a-refund-reversal)).

The two Workers bind each other. Deploy them in this order:

1. The iOS verifier Worker, in `server-api` mode and without
   `GAME_SERVICES_APP_STORE_REVOCATIONS`.
2. This Worker, with 0011 applied and the flag set.
3. The iOS verifier Worker again, with the binding and `offline-only`.

Rows hold no player id. A row can be deleted once its `revoked_at_ms` is
older than the verifier's `maxSignedAgeMs` plus `clockSkewMs`. By then, every
JWS the row would refuse is stale anyway.

To have the cron delete such rows, set
`GAME_SERVICES_APP_STORE_REVOCATION_RETENTION_MS`. The value is a positive
integer number of milliseconds, written as a string. It must be at least the
verifier's `maxSignedAgeMs` plus `clockSkewMs`, because this Worker does not
know the verifier's window. With the variable unset, nothing is pruned. An
invalid value is logged once and ignored. Each isolate prunes at most once an
hour, in bounded batches. For a one-hour window with the default five-minute
skew:

```toml
[vars]
GAME_SERVICES_APP_STORE_REVOCATION_RETENTION_MS = "7200000" # 2 hours >= 1 h + 5 min
```

Alternatively, delete the rows by hand:

```sh
pnpm --dir apps/game-services-worker exec wrangler d1 execute mpgd-game-services --remote \
  --command "DELETE FROM app_store_revocations WHERE revoked_at_ms < (unixepoch('now') - 7200) * 1000"
```

A row whose `revoked_at` did not parse (`revoked_at_ms` is NULL) refuses
every JWS for that grant. Such a row is never replaced, and neither the
retention nor the query above deletes it. Support removes it by hand.

<!-- @link ../apps/game-services-worker/src/appStoreRevocations.ts#createD1AppStoreRevocationRegistry One conditional upsert keeps the latest revokedAt; a D1 failure is AppStoreDependencyUnavailableError. -->

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
  in your console, they change). Real-time developer notifications revoke
  faster (next section); the sweep stays on next to them and is what keeps
  the ledger correct.

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

### Google Play: real-time developer notifications

The Worker mounts `POST /google-play/rtdn` for Google Play Real-time
developer notifications (RTDN) delivered by a Cloud Pub/Sub push
subscription. A `voidedPurchaseNotification` for a fully refunded or voided
one-time product is a trigger, not proof: the Worker looks the purchase
token up with the Voided Purchases API (the sweep's client, one query over a
window from 15 minutes before the notification's event time to the earlier
of now and six hours after it) and revokes the grant with the listed entry. The revocation goes through the
same `revokeGooglePlayVoidedPurchase` path and key as the sweep and records
the same reason (`chargeback` for `voidedReason` 7), source, and void time;
a redelivered push and the sweep's later read of the same token both answer
the first `revoke` entry (`alreadyProcessed`). A message published to the
topic by anyone but Google cannot revoke a purchase Google did not void.

**The sweep stays required.** Pub/Sub delivers at least once and can drop a
message for good (a wrong push endpoint or audience past the subscription's
retention, a topic that Play Console stopped publishing to, a deleted
subscription). Keep `MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES` on; RTDN is the
fast path, the sweep is the backstop.

**Quota.** Google allows 6,000 Voided Purchases API queries a day and 30 in
any 30 seconds per package, shared by the sweep and this route
([Voided Purchases API](https://developers.google.com/android-publisher/voided-purchases)).
A voided notification costs one query (a second only when more than 1,000
voids share its window); every other kind costs none. The sweep uses about
24 a day once caught up. A void Google does not list yet is redelivered with
the subscription's retry policy (10 to 600 seconds below), about ten
queries over its hour. A `429` (or any lookup failure, a stuck token service
included) is answered `503`, so Pub/Sub backs off and redelivers with that
policy; refund volume stays far below 30 queries in 30 seconds, so the
Worker keeps no rate limiter of its own.

```toml
[vars]
# GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME is the in-Worker Play boundary's (above).
# The push subscription's audience and the service account it signs as.
GAME_SERVICES_GOOGLE_PLAY_RTDN_AUDIENCE = "https://<worker-host>/google-play/rtdn"
GAME_SERVICES_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT = "play-rtdn-push@<project-id>.iam.gserviceaccount.com"
```

Either RTDN setting mounts the route. With one of the three missing, or
without the in-Worker Play boundary (`GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME`
with `GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH` and the account binding or
the unbound opt-in), whose Voided Purchases client confirms each void, the
route answers `503` to every push (logged at startup), so Pub/Sub keeps the
messages until the settings are complete. It never revokes unconfirmed. Like
the sweep, it only finds grants that boundary verified, and it revokes in
the Worker's store: D1 in production.

**Authentication.** Every push must carry the OIDC token an authenticated
push subscription sends (`Authorization: Bearer <JWT>`). The Worker checks
the RS256 signature against Google's published keys
(`https://www.googleapis.com/oauth2/v3/certs`, cached per isolate for the
response's `max-age`), the issuer (`https://accounts.google.com` or
`accounts.google.com`), the audience, the `email` claim against
`GAME_SERVICES_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT` with `email_verified`, and
`exp`/`iat` with a minute of clock skew
([Authenticate push subscriptions](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)).
The email check matters: any Google service account can mint a token for any
audience. A push that fails is answered `401` and not acknowledged; a Google
key outage is `503`. There is no shared-secret fallback. The token proves the
push came from your subscription, not who published to the topic; the Voided
Purchases API lookup is what makes a revocation Google's.

**Push formats.** Both are read: the default wrapped body
(`{ "message": { "data": "<base64 DeveloperNotification>", "messageId": … },
"subscription": … }`) and an unwrapped one (payload unwrapping on: the body is
the `DeveloperNotification` JSON itself, with a top-level `packageName`).
An unwrapped push carries its message id only in the `x-goog-pubsub-message-id`
header, sent when "write metadata" is on
([Payload unwrapping](https://cloud.google.com/pubsub/docs/payload-unwrapping)).

**Responses.** Pub/Sub acknowledges a `102`, `200`, `201`, `202`, or `204` and
redelivers on anything else
([Push subscriptions](https://cloud.google.com/pubsub/docs/push)).

| Push | Answer |
| --- | --- |
| Voided one-time product, full refund (`refundType` 1), listed by the Voided Purchases API, grant found | `200 revoked` (`alreadyProcessed` on a repeat) |
| Voided, not listed yet, or grant not on this ledger, event less than an hour old | `503` (redelivered: Google lists voids with some lag, and a purchase may still be writing its grant) |
| Voided, not listed or grant not found after that hour, or no event time | `200 ignored`; the sweep reads the void again |
| The Voided Purchases API lookup failed (outage, quota) | `503` |
| Quantity-based partial refund (`refundType` 2) | `200 ignored`, logged with the order id; the grant stays, as with the sweep |
| Voided subscription (`productType` 1), `subscriptionNotification` | `200 ignored`: the kit sells no Play subscriptions |
| `testNotification`, `oneTimeProductNotification`, other kinds | `200 ignored`, logged: purchases are granted only when the game verifies them |
| Another package, a malformed envelope or payload, a body over 64 KiB | `200` (`ignored` or `rejected`), so it is not redelivered until retention runs out |
| A ledger conflict | `200 conflict`, logged at error |
| Unauthenticated | `401`; incomplete settings `503`; a store error `500` |

The log line names the Pub/Sub message id, the outcome, and the order id;
the purchase token is never logged. Revocations are keyed by the purchase
token, so a redelivery needs no message id bookkeeping.

**Setup** (Google Cloud project of the app's Play Console link, then Play
Console; see
[Configure real-time developer notifications](https://developer.android.com/google/play/billing/getting-ready)):

1. Create the topic, for example `play-rtdn`:
   `gcloud pubsub topics create play-rtdn`.
2. Grant `google-play-developer-notifications@system.gserviceaccount.com`
   the **Pub/Sub Publisher** role on that topic (topic permissions in the
   Cloud console, or
   `gcloud pubsub topics add-iam-policy-binding play-rtdn --member=serviceAccount:google-play-developer-notifications@system.gserviceaccount.com --role=roles/pubsub.publisher`).
   An organization policy that restricts domains needs an exception for it.
3. Create a service account for the push token, for example
   `play-rtdn-push`, and let the Pub/Sub service agent
   (`service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com`) mint
   tokens for it (`roles/iam.serviceAccountTokenCreator`).
4. Create the push subscription with authentication and an explicit
   audience (wrapped is the default; payload unwrapping works too, with
   "write metadata" for the message id in logs), and an exponential retry
   policy so a `503` waits between redeliveries:

   ```sh
   gcloud pubsub subscriptions create play-rtdn-worker \
     --topic=play-rtdn \
     --push-endpoint=https://<worker-host>/google-play/rtdn \
     --push-auth-service-account=play-rtdn-push@<project-id>.iam.gserviceaccount.com \
     --push-auth-token-audience=https://<worker-host>/google-play/rtdn \
     --min-retry-delay=10s --max-retry-delay=600s
   ```

   Set the same audience and service account in the Worker settings above.
5. In Play Console, open the app, **Monetize > Monetization setup**, then
   **Real-time developer notifications**: enable them, enter the topic as
   `projects/<project-id>/topics/play-rtdn`, and pick "Get notifications for
   subscriptions and all voided purchases" (one-time product purchase events
   are acknowledged and ignored, so the other option only adds traffic).
6. Click **Send Test Message**. The Worker answers `200` and logs
   `Google Play RTDN ignored <message id> GOOGLE_PLAY_RTDN_TEST`. A `401` in
   the subscription's delivery metrics means the audience or the service
   account does not match the Worker settings.

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
- Apply `0010_account_deletion.sql` (the deletion audit, the pending
  erasures, tombstones, the retention column and its triggers, and player
  indexes), set the secret `GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY`
  (`openssl rand -base64 48 | pnpm --dir apps/game-services-worker exec wrangler secret put GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY`;
  without it the route answers `503`; changing it forgets live tombstones),
  and bind `GAME_SERVICES_ACCOUNT_DELETION` to
  the identity Worker's `AccountDeletion` entrypoint (its migration
  `0002_account_deletion.sql` applied) before players can delete
  their accounts: without the binding `POST /game-services/account/delete`
  answers `503`, and without the migration it answers `500`. The cron
  (required: without the trigger pending erasures never finish and kept
  records are never purged) finishes pending erasures and purges purchase
  records kept for deleted players after five years
  ([account deletion](GAME_SERVICES_BACKEND.md#account-deletion)). Support
  tooling deletes a player through the `GameServicesAccountDeletion`
  entrypoint (`deletePlayerAccount({ playerId })`).
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
