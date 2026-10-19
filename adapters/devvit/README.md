# @mpgd/adapter-devvit

Reddit Devvit Web platform adapter for mpgd games.

| Entry point | Purpose |
| --- | --- |
| `@mpgd/adapter-devvit` | `createDevvitPlatformGateway`, the oRPC bridge and sandbox bridge, the commerce provider and catalog helpers, the Devvit notifications profile values |
| `@mpgd/adapter-devvit/payments` | `normalizeDevvitCommerceProducts` and the checkout types |
| `@mpgd/adapter-devvit/server` | `createDevvitCommerceV2BridgeHandler`, `createDevvitNotificationsV2BridgeHandler`, the notifications service and delivery provider, payment-order normalizers, durable post operations, Redis stores |
| `@mpgd/adapter-devvit/web` | Webview helpers, including `createDevvitWebPaymentsClient()` over `purchase()` and `createDevvitWebLoginPrompt()` over `showLoginPrompt()` from `@devvit/web/client` |
| `@mpgd/adapter-devvit/surface`, `/view-mode` | Inline and expanded view-mode helpers |

## Commerce

The gateway has at most one commerce surface, `gateway.commerce`, a commerce v2 `CommerceProvider`
(`createDevvitCommerceProvider`). `createDevvitPlatformGateway({ commerce: { products, client } })`
installs it and reports its block as `getCapabilities().commerce`; without the option the gateway
sells nothing, has no `commerce`, and reports `createUnsupportedCommerceCapabilities()`. Reddit
settles a purchase on the server, so only the backend ledger the fulfillment handler writes grants
anything. Games purchase through `@mpgd/game-services`; see the
[Devvit commerce guide](../../docs/DEVVIT_COMMERCE.md).

## Notifications

Devvit push notifications are a gated beta: an app must
[apply](https://developers.reddit.com/docs/versioned_docs/version-0.14/capabilities/notifications/notifications-overview)
and Devvit admins pre-approve every title and body. Until Reddit approves the
app, keep `integrations.notifications` at `approval-required` (the default for
`reddit`), which hides notifications from the game; set it to `available` once
Reddit approves. The profile follows the
[notifications v2 RFC](../../docs/specs/notifications/notifications-v2-rfc.md#profile-devvit):

- **Consent the game renders.** Reddit shows no consent screen. The game draws
  an on/off control with its current state and offers both directions.
- **The server bridge.** Pass
  `createDevvitNotificationsV2BridgeHandler({ notifications, currentUserId, topics })`
  as the bridge's `notifications` dependency; it takes the Devvit plugin as
  `notifications`. It opts the request's logged-in user in with
  `optInCurrentUser` from `requestPermission`, out with `optOutCurrentUser`
  from `revokePermission`, and reads `isOptedIn`.
- **The gateway.** `createDevvitPlatformGateway({ notifications: { topics } })`
  exposes `notificationsV2` over that bridge (its client loads in its own
  chunk, starting with the gateway)
  and serves the v1 `notifications` adapter from it. `topics` are the ids the
  catalog maps for `reddit`.
- **Login.** A logged-out viewer reads `action-required` with
  `requiredAction: 'login'`. With `loginPrompt: createDevvitWebLoginPrompt()`
  (from `@mpgd/adapter-devvit/web`), `identity.requestUpgrade` opens Reddit's
  login and answers `reloadExpected: true`, since Reddit reloads the post after
  login; set `integrations.identityUpgrade` to `available` in the game's target
  config to expose it.
- **No opt-out event.** Devvit reports no opt-out, and opt-out may move into
  Reddit settings, so the backend reads `isOptedIn` at every send.
- **Sending.** Remote delivery runs inside the Devvit server:
  `createDevvitNotificationService({ redis, notifications, catalog })` is the
  `@mpgd/game-services/notifications` service over a Redis store
  (`createDevvitRedisNotificationStore`) with the Devvit delivery provider. Each
  send needs a post (`t3_`) or comment (`t1_`) link, from the send or the
  topic's mapping. Titles are at most 60 and bodies at most 100 Unicode code
  points of the filled text. Devvit allows 2 sends per user per day and 25,000
  per app per day. Players' own calls take `devvitNotificationSession(userId)`.
  Two `devvit.json` scheduler tasks keep its work moving:
  `mpgd-notifications-dispatch` (every minute, at most 100 due sends) and
  `mpgd-notifications-purge` (hourly, at most 500 rows of each kind). Route
  their endpoints (`devvitNotificationSchedulerTasks`) to
  `runDevvitNotificationTask(service, task)`, as the kit's
  `apps/target-devvit` server does. S2's reminders come with the reminder
  scheduler.
- **Opens.** A notification opens its post; the game routes from that post's
  data.

## Migrating from v1

| Removed | Replacement |
| --- | --- |
| `createDevvitCommerceAdapter`, `withDevvitCommerceAdapter`, `CreateDevvitCommerceAdapterInput` | `createDevvitPlatformGateway({ commerce })` or `createDevvitCommerceProvider` |
| v1 `gateway.commerce` (`getProducts`, `purchase`, `restore`, `getEntitlements`) | `gateway.commerce`, the provider (absent when nothing is sold) |
| `gateway.commerceV2` | `gateway.commerce` |
| `DevvitPaymentsClient.getEntitlements()` | The backend ledger (`listActiveEntitlementTransactions` on the server); the client is only `purchase(sku)` |
| `capabilities.nativeIap`, `capabilities.subscriptionIap` | `capabilities.commerce` |
| Bridge methods `commerce.getProducts`, `commerce.purchase`, `commerce.restore`, `commerce.getEntitlements` | `UNSUPPORTED_METHOD`; the six `commerce.v2.*` methods |
