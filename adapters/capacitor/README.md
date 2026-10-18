# @mpgd/adapter-capacitor

The base adapter uses `@mpgd/capacitor-game-services` for bounded local JSON
storage and a small fail-closed bridge. It does **not** install a store, ad,
identity, leaderboard, or push SDK. Pass separately installed modules through
`createCapacitorPlatformGateway({ providers })`; each module declares its
owned bridge methods, provider features, and current availability. Duplicate
method/feature registrations and attempts to replace base storage are errors.

```ts
import {
  createCapacitorPlatformGateway,
  type CapacitorServiceProvider,
} from '@mpgd/adapter-capacitor';

export function createGameGateway(providers: readonly CapacitorServiceProvider[]) {
  return createCapacitorPlatformGateway({
    target: 'android',
    appVersion: '1.0.0',
    buildId: 'game-build',
    providers,
    classifyIncomingUrl(url) {
      const incoming = new URL(url);
      // Replace this example scheme with one registered by your native host.
      if (incoming.protocol !== 'mygame:') return null;
      if (incoming.hostname === 'oauth') return 'oauth';
      if (incoming.hostname === 'game') return 'game';
      return null;
    },
  });
}
```

`getCapabilities()` reports a fresh boolean snapshot, optional
`providerAvailability` detail, and the `commerce` capability block. The
possible states are `unsupported`, `configuration-required`, `action-required`,
`temporarily-unavailable`, and `available`. A target's `features` configuration
is an upper bound, **not** proof that a provider is installed or ready.
Commerce is not a provider feature: the `commerce` block (see below) is the
only commerce source, and the retired `nativeIap` and `subscriptionIap` flags
are never reported, even when a native shell built before commerce v2 still
sends them. Rewarded, interstitial, and banner ads and native versus remote
leaderboards remain distinct. Target-config applies the configured upper
bound to this live provider state.

When native and remote leaderboard routes coexist, the target-config wrapper
selects a `route` on score/open calls; direct adapter callers can request
`route: 'remote'` to use the base remote bridge instead of the native provider.
When one ads provider handles multiple formats, pass `format` to `ads.preload`
so its readiness check cannot use an available format for an unavailable one.

Provider initialization failures and availability reads stalled beyond three
seconds leave the base bridge and local guest boot available. A registered
provider never silently falls back for purchase, ad, or native leaderboard
operations; an explicit remote leaderboard route is a separate path. Errors
retain a stable code and retry hint. The
provider bridge must return a method-shaped response. In particular, an ad
`rewardGranted: true` result requires a backend ledger entry. The AdMob SDK
provider always returns `rewardGranted: false`, even after the SDK fires a
reward callback. Its explicitly non-authoritative evidence envelope only lets
the game-services client request a grant; the server must independently verify
a signed SSV callback before writing its ledger. A native callback alone is
never a grant. Game-specific product, consent, entitlement, and
identity policy belongs to the consuming game and its backend.

The source tests and installed-tarball consumer validate composition, types,
error paths, and fallback behavior. They do not establish that any optional
SDK works on a physical device or that a store/ad setup is release-ready.

## Commerce providers

Commerce ([RFC](../../docs/specs/commerce/commerce-v2-rfc.md)) has one
surface: the `CommerceProvider` from `@mpgd/platform/commerce`, exposed as
`gateway.commerce` and served over the six `commerce.v2.*` bridge methods. A
store plugin exposes an in-process `StoreSdk`, the adapter turns it into a
`CommerceProvider`, and the provider registry serves it. The four v1
`commerce.*` bridge methods and the v1 gateway object are removed.

`StoreSdk` is shaped like the OpenIAP Client Protocol so a future Capacitor
IAP plugin over the OpenIAP cores is a drop-in: `fetchProducts({ skus, type })`,
`requestPurchase({ sku, offerId?, quantity?, accountBinding? })` answering
`launched`, `purchased`, `cancelled`, or `failed`, `getAvailablePurchases`
listing unfinished store purchases, optional `finishTransaction` and
`restorePurchases`, `addListener('purchaseUpdated' | 'purchaseError')`, an
optional `getAvailability`, and a static `capabilities` declaration (purchase
kinds, quantity, pending, restore, finish owner). The SDK speaks store SKUs
and its own error codes only. B2 adapts `@mpgd/capacitor-play-billing` and B3
adapts `@mpgd/capacitor-storekit` to this interface; B1 ships no plugin
change.

```ts
import {
  createCapacitorPlatformGateway,
  createCommerceServiceProvider,
  createStoreCommerceProvider,
  type StoreSdk,
} from '@mpgd/adapter-capacitor';

export function createStoreGateway(sdk: StoreSdk) {
  const commerce = createStoreCommerceProvider({
    sdk,
    products: [
      { logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' },
      { logicalId: 'remove_ads', storeSku: 'remove.ads', kind: 'durable' },
    ],
    evidenceSchema: 'google-play.product-purchase.v2',
    evidencePayload: (purchase) => ({ purchaseToken: purchase.token }),
    accountBinding: async () => ({ kind: 'obfuscated-account-id', value: 'player-1' }),
    authority: { evidence: 'client-token', accountBinding: 'required' },
    mapError: { PLAY_BILLING_OFFER_REQUIRED: 'CONFIGURATION_REQUIRED' },
  });
  return createCapacitorPlatformGateway({
    target: 'android',
    appVersion: '1.0.0',
    buildId: 'game-build',
    providers: [createCommerceServiceProvider({ id: 'play-billing', commerce })],
  });
}
```

`createStoreCommerceProvider` maps logical ids to store SKUs both ways (an
unknown SKU is still reported, with `logicalId` undefined; an unknown logical
id fails with `ITEM_UNAVAILABLE`), rejects unsupported kinds and quantities
with `assertRequestPurchaseSupported` before any store UI opens, refuses to
open the store while `getAvailability` is not `available`, builds every
`StorePurchase` with the store `token` and the `{ schema: evidenceSchema,
payload }` envelope, buffers SDK events until the first `subscribe` with
`createCommerceEventBuffer`, composes `CommerceCapabilities` from the SDK
declaration plus `capabilities` overrides and a fresh `availability` read
(three-second timeout, degraded to `temporarily-unavailable`), validates every
SDK answer with the platform typia asserts (`INVALID_RESPONSE` otherwise), and
normalizes every SDK failure through `mapError` into a `CommerceError` whose
`storeCode` keeps the store's own code. It never grants and never sets
`settlement`; the backend ledger decides.

Two failure classes are not terminal. When `requestPurchase` throws or
returns a code that normalizes to `OUTCOME_UNKNOWN` (for example
`PLAY_BILLING_TIMEOUT`, `PLAY_BILLING_INTERRUPTED`,
`STOREKIT_PURCHASE_UNCERTAIN`) or `ALREADY_OWNED`, an unfinished purchase may
exist, so the provider answers `{ outcome: 'launched' }` instead of `failed`
and does not forward a `purchaseError` event carrying those codes
(`recoverableErrorCodes`). The attempt stays open and the reconciler resolves
it from `getAvailablePurchases`; the store UI is never reopened blindly. A
`capabilities.lifecycle` override may hide `restore` or `finish`, but it
cannot advertise one the SDK lacks: `restore: true` without
`sdk.restorePurchases`, like `finish: 'client' | 'host'` without
`sdk.finishTransaction`, is rejected when the provider is created.

`createCommerceServiceProvider({ id, commerce })` wraps the provider as a
`CapacitorServiceProvider` whose `commerce` field the registry recognizes. It
declares no `features` and no `methods`: the six `commerce.v2.*` bridge methods
are implied (declaring one, or a retired v1 `commerce.*` method, is an error),
the bridge must implement `subscribe`, and the in-process bridge delivers
events as `{ protocol: 'mpgd.commerce.v2', sequence, event }` with a
per-session sequence starting at 0. `CapacitorServiceProvider.features` lists
non-commerce features only (`PlatformProviderFeature` has no IAP names), and a
second commerce provider is a registration error.

The gateway exposes the provider as `gateway.commerce` (served through the same
validated bridge path, which the conformance test exercises for every store
vector) and omits the property when no provider is registered. The
`commerce` block of `getCapabilities()` is always present and is a fresh copy
on every read: the provider's validated capability block, or
`createUnsupportedCommerceCapabilities()` when no commerce provider is
registered. A native `runtime.getCapabilities` answer is only the base: its
`nativeIap` and `subscriptionIap` keys are stripped and its `commerce` block,
whatever it says, is replaced. The block comes from the registry's one bounded
read per snapshot (`getCapabilitySnapshot` returns `{ availability, commerce }`,
three-second timeout, shape validated): a stalled, failing, or invalid
provider yields a degraded block (`createDegradedCommerceCapabilities`:
`availability: 'temporarily-unavailable'`, nothing sold) and never rejects the
capability read. A `launched` purchase keeps `beginExternalActivity()` open
after the request returns, since the store UI is still up: the gateway releases
it when the provider reports that product (`purchaseUpdated` or
`purchaseError`), after `launchedPurchaseActivityTimeoutMs` (two minutes), or
on `lifecycle.dispose`. The registry does not gate a commerce method by a
snapshot: the provider reads its own `availability` and fails closed before any
store UI opens. A `commerce.v2.*` request that reaches a transport without a
provider still answers `COMMERCE_V2_UNAVAILABLE`.

Games do not call the provider from a scene: `createGameServicesClient` from
`@mpgd/game-services` purchases through `createCommerceReconciler` over
`gateway.commerce`, and nothing is granted from a client callback.

## Notifications v2

`@mpgd/adapter-capacitor/notifications` is the Android and iOS provider of the
[notifications RFC](../../docs/specs/notifications/notifications-v2-rfc.md#profile-capacitor).
Only this subpath loads the notifications validators and the two plugins, so a
game without notifications bundles neither.

```ts
import { resolveNotificationTopicsForTarget } from '@mpgd/catalog';
import {
  createCapacitorNotificationServiceProvider,
  loadCapacitorNotificationSdks,
} from '@mpgd/adapter-capacitor/notifications';

const sdks = await loadCapacitorNotificationSdks();
const notifications = createCapacitorNotificationServiceProvider({
  platform: 'android',
  topics: resolveNotificationTopicsForTarget(catalog, 'android'),
  ...sdks,
  // Optional: opens this app's notification settings (see below).
  openSettings,
});
const gateway = createCapacitorPlatformGateway({ ..., providers: [notifications] });
```

Create it once, early in startup: it registers its native listeners when it
is created, which is how a cold-start open reaches it.

- **Plugins.** Install `@capacitor-firebase/messaging` (with the `firebase`
  package its web fallback imports) and `@capacitor/local-notifications` 8.x,
  both optional peers of this package. Do not also install
  `@capacitor/push-notifications`: on iOS both claim Capacitor's single push
  handler. `loadCapacitorNotificationSdks` imports them dynamically and leaves
  one out when the app is not native, the shell has no native implementation,
  or the import fails. Without both the provider is `unsupported`; without the
  push plugin it declares no remote delivery; without the local plugin it
  declares no local reminders, registers no advertising opt-out category, and
  reads the permission through the push plugin, which answers `granted` on
  Android 12 and lower whatever the setting is. A game with advertising topics
  installs both. iOS remote notifications go through FCM, which relays to
  APNs.
- **Gateway.** `createCapacitorNotificationServiceProvider` (or
  `createNotificationServiceProvider` over another provider) registers the
  nine `notifications.v2.*` methods. The gateway then exposes
  `notificationsV2`, validates every payload and answer on both sides of its
  in-process bridge, pauses the game under `requestPermission` and until the
  player is back from `openSettings`, and serves the v1 `notifications`
  adapter from the same provider. `getCapabilities()` carries the provider's
  `notifications` block, and `providerAvailability.pushNotifications` equals
  its availability. A v1 `pushNotifications` provider cannot be registered
  next to it. Without a notifications service the gateway exposes no
  `notificationsV2` and answers every `notifications.v2.*` request with
  `NOTIFICATIONS_V2_UNAVAILABLE` before it pauses the game.
- **Permission.** One OS permission for the app. The provider reads it through
  the local plugin, which reflects the system setting on Android 12 and lower
  where the push plugin answers `granted` regardless. The OS `denied` reads
  `blocked`: after one denial on iOS (`promptLimit` 1) and after the second on
  Android 13+ (`promptLimit` 2; pass `androidPromptLimit: 1` for an app that
  targets SDK 32 or lower). Only `requestPermission` shows the dialog, and a
  request made while the dialog is up shares its answer. A change made in
  system settings is read on the next read and announced as
  `permission-changed` when the app returns to the foreground.
- **Local reminders.** `scheduleLocal` answers `unsupported` for a topic
  outside the resolved catalog and for an advertising topic, which never
  schedules locally. Otherwise it reads the permission first and answers
  `permission-required` without calling the plugin, whose own `schedule` would
  prompt on Android 13+.
  - Reminders are inexact (`isExactNotification: false`; the plugin's default
    would open the exact-alarm settings screen) but may fire in Doze
    (`allowWhileIdle: true`). Remove `SCHEDULE_EXACT_ALARM`, which the
    plugin's manifest adds, from the merged manifest (`tools:node="remove"`).
  - Each is keyed by a stable 32-bit native id, replaced by key, and posted on
    the topic's Android channel. Operations run one at a time, in call order.
  - iOS keeps at most 64 pending, so the provider keeps the nearest: at the
    ceiling it cancels the farthest of its reminders before it schedules a
    nearer one. Android declares no ceiling, but its alarm manager refuses an
    app with about 500 pending alarms.
- **Channels.** Each topic posts to its mapping's `channelId`, or to
  `mpgd-service`, `mpgd-requested`, or `mpgd-advertising` by purpose
  (`capacitorNotificationChannelId`). Creating the provider throws when a
  channel would mix advertising with other topics, so a player can always turn
  advertising off in system settings. Name the channels with the `channels`
  option.
- **Opens.** A tap becomes one `opened` event, buffered until the first
  subscriber. A push carries its topic and route in the data keys `topic` and
  `route` (`capacitorNotificationDataKeys`); its other string entries, except
  the transport's own keys (`from`, `collapse_key`, `google.*`, `gcm.*`, and
  the like), reach the game as untrusted `data`. A route is kept only when
  `isRootRelativeNotificationRoute` accepts it, and a topic only when the
  catalog declares it. Nothing is granted from an open. An open that arrives
  before the first subscriber is marked `cold`; Capacitor replays a cold-start
  tap asynchronously, so one replayed after the game subscribed reads `warm`.
- **Advertising opt-out.** For a catalog with an advertising topic, the
  provider registers the action type `mpgd-advertising`
  (`capacitorAdvertisingActionTypeId`) with the `advertising-opt-out` action
  (title `advertisingOptOutTitle`, '수신거부' by default) through the local
  plugin.
  - On iOS that sets the app's notification categories, all at once, so it
    replaces categories the shell registered through the same plugin. An FCM
    send names the category in `apns.payload.aps.category`.
  - The action opens the `optOutRoute` of the advertising topic the push names
    in its `topic` data key; without that key it opens nothing.
  - An Android FCM notification message cannot carry actions, so an Android
    advertising push needs the shell to render it natively with the action;
    the template work for that is C1's.
- **Settings.** Neither plugin opens the notification settings, so the shell
  passes `openSettings` (for example a small native method); without it
  `permission.settings` is `false` and `openSettings` answers `unavailable`.
  The provider resolves `openSettings` only once the app is back in the
  foreground, after at most ten minutes, or after five seconds when the app
  never left.
- **Endpoints.** `register()` answers the FCM token with the device
  permission, locale, and time zone, or `null` while Firebase cannot issue one
  yet; a token Firebase issues later arrives as `endpoint-changed`. Pass
  `address: 'fcm-installation'` with a `PushSdk` whose `getInstallationId`
  issues Firebase installation ids to register those instead. The messaging
  plugin has no such method, and its proxy cannot be told apart from one that
  has, so with the plain plugin `register()` answers
  `NOTIFICATIONS_CONFIGURATION_REQUIRED`.

## App Store server-side transaction signatures

The server-side verifier lives in `@mpgd/game-services/app-store-server`
(see the [game-services README](../../packages/game-services/README.md)):
install the optional `@apple/app-store-server-library@3.1.0` peer next to
`@mpgd/game-services` and import `createAppleSignedTransactionVerifier` from
there. The former `@mpgd/adapter-capacitor/app-store-server` subpath, a
deprecated re-export, was removed. Supply DER-encoded Apple root certificates from the
[Apple PKI](https://www.apple.com/certificateauthority/), the game's bundle
ID, environment, and production App Apple ID. Use the result as
`signedTransactionVerifier` in `createAppStoreGameServicesEvidenceVerifier`.
Keep App Store API credentials, trust roots, and this verifier on the backend,
not in the Capacitor game; the adapter itself no longer peers on Apple's
library.

The server fetches the transaction from Apple's API, verifies its JWS, checks
the product, bundle, environment, account token and transaction ID, then
writes the game-services grant. A StoreKit device callback is only provisional
evidence; it never grants a product. Retryable certificate-status failures
remain pending, while invalid signatures are rejected. Mock verification does
not prove a real App Store purchase or device delivery.

### Migrating from v1

Commerce v2 PR C4 removed the v1 surface in one major release.

| Removed | Replacement |
| --- | --- |
| `gateway.commerce.getProducts / purchase / restore / getEntitlements` (v1 `CommerceAdapter`) | `gateway.commerce` is now the `CommerceProvider` (`fetchProducts`, `requestPurchase`, `getAvailablePurchases`, `finishTransaction?`, `restorePurchases?`, `subscribe`); games purchase through `@mpgd/game-services` |
| `gateway.commerceV2` | `gateway.commerce` |
| `commerce.getProducts`, `commerce.purchase`, `commerce.restore`, `commerce.getEntitlements` bridge methods and `toCommerceAdapter` | the six `commerce.v2.*` methods |
| `nativeIap`, `subscriptionIap` in `getCapabilities()` and `providerAvailability` | `capabilities.commerce` (`purchase.consumable`, `purchase.durable`, `purchase.subscription`, `availability`) |
| `'nativeIap'` / `'subscriptionIap'` in `CapacitorServiceProvider.features`; the `features` input of `createCommerceServiceProvider`; `CapacitorCommerceFeature`; `deriveCommerceFeatureStates` | omit `features`: a provider with `commerce` declares none, and its readiness is its capability block |
| the `productType` parameter of `assertMethodReady`; `NATIVE_PROVIDER_PRODUCT_UNKNOWN`, `NATIVE_PROVIDER_PRODUCT_TYPE_REQUIRED` | none: product routing belongs to the commerce provider |
| `CapacitorProviderCapabilitySnapshot.commerce?` (optional) | always present: the provider block, the degraded block, or the unsupported block |
| `@mpgd/adapter-capacitor/app-store-server` | `@mpgd/game-services/app-store-server` |

## Opt-in AdMob rewarded ads

Install `@capacitor-community/admob@8.1.0` in the game-owned Capacitor project,
configure the distinct AdMob **application ID** in AndroidManifest.xml and
Info.plist, and run `cap sync`. Use the [plugin installation and native setup
guide](https://github.com/capacitor-community/admob#installation) for the exact
Android and iOS keys, SKAdNetwork list, and tracking disclosure. The optional
`@mpgd/adapter-capacitor/admob` subpath does not load from the base adapter;
games that do not install AdMob retain their existing SDK-free gateway.
The community plugin currently targets Google Mobile Ads Android 25.4.x and
iOS 13.6.0. Its Android default uses a dynamic patch selector; set
`playServicesAdsVersion = '25.4.0'` in the game-owned `variables.gradle` to
keep release builds reproducible until the plugin adopts a newer tested SDK.

```ts
import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import { createCapacitorAdMobRewardedProvider } from '@mpgd/adapter-capacitor/admob';

const admob = createCapacitorAdMobRewardedProvider({
  adUnits: { CONTINUE_AFTER_FAIL: 'ca-app-pub-1234567890123456/1234567890' },
  getPlayerId: () => authenticatedPlayerId,
});
const gateway = createCapacitorPlatformGateway({
  target: 'android', appVersion: '1.0.0', buildId: 'game-build',
  providers: [admob],
});
const consentAllowsAds = await admob.requestConsent();
if (!consentAllowsAds) {
  // Keep the ad action disabled; never bypass the privacy choice.
}
```

Use target-specific ad unit IDs for Android and iOS; the logical placement
ID must match the game catalog and backend config. `getPlayerId()` must return
the same authenticated player ID as `GameServicesClient`, not a device ID or
an unverified local guest label. Re-check consent when the game resumes or
the privacy choice changes, and expose `admob.showPrivacyOptions()` from game
settings where required. `getCapabilities()` reports `action-required` until
consent is ready and `temporarily-unavailable` during a show. A timed-out
native load or presentation reports `action-required` and quarantines that
SDK instance to avoid overlapping shows. A timed-out load fails before display
and remains quarantined until that original preparation settles; it never
opens an ad later. A display timeout returns pending even if an SDK reward was
observed, because earning does not prove closure. The provider retains native
terminal listeners and clears presentation uncertainty after a confirmed late
close. Listener registration/cleanup failures remain quarantined until native
app restart. Recreating a Kit provider with the same SDK does not clear these
guards. Do not
show rewarded ads through another direct SDK caller concurrently: the plugin's
reward and dismissal events are global, not tagged with a Kit operation ID.

`gateway.ads.preload()` validates the logical placement but deliberately does
not load an ad: this SDK attaches SSV data at load time, whereas the Kit's
operation ID exists only at show time. `gateway.ads.showRewarded()` therefore
loads a fresh ad with SSV `userId` and encoded player/placement/operation
binding, waits for native dismissal, then returns SDK reward evidence. Call
`GameServicesClient.claimRewardedAd()` rather than award currency from that
result; `rewardGranted` remains `false` in that provisional platform result.
If dismissal arrives without an observed reward, the provider returns
`pending` with the same non-authoritative binding. The backend can then look
for a later signed SSV callback without replaying the ad UI; a genuinely
skipped ad may remain pending until game-owned support or expiry policy
settles it. Mediation and asynchronous bridge delivery have no safe universal
250 ms reward-event cutoff.

The gateway exposes `ads.provider` with protocol `mpgd.ads.v2`. Its rewarded
preparation is `deferred`, since the operation's SSV binding must be attached to
the fresh load. Missing placements are `configuration-required`, consent is
`action-required`, and interstitials are explicitly unsupported by this provider.
Native `Showed`, `Dismissed`, and `FailedToShow` events establish presentation
facts; the original `showRewardVideoAd` Promise establishes per-call SDK
eligibility. Global `Rewarded` events carry no invocation identity and cannot
bind a late reward to a new show. A requested event carries
`claimEvidence` for server proof lookup under the original idempotency key;
this does not assert local eligibility or a grant. Pass this actual provider to
the shared [game runtime](../../packages/game-runtime/README.md#native-presentation-and-financial-settlement)
to coordinate execution and deadlines above all scenes. Removing SDK listeners
and disposing a view cannot establish native closure.
The receiver and ledger described in [AdMob SSV](../../docs/ADMOB_SSV.md)
remain mandatory. A late SSV callback can leave the claim pending for
reconciliation. `isTesting: true` is for SDK test ads only; [the plugin notes
that test ads do not invoke the SSV endpoint](https://github.com/capacitor-community/admob/blob/main/docs/rewarded.md#server-side-verification),
so they cannot prove a production grant.

The Kit tests cover consent, per-operation binding, reward versus dismissal,
and bridge contracts with an injected SDK. Seven shared presentation vectors
run through this real provider, the installed Capacitor gateway, and the common
runtime: consent/action, configuration, policy, deferred preparation, deadline
with late closure, full-screen arbitration, and background ownership. This is
presentation coverage, not complete certification of the server-ledger vector
matrix. The fixtures are not evidence of a real
AdMob account, live callback delivery, native device behavior, or store policy
approval.

`gateway.secureCredentials` uses dedicated native Keychain/Keystore methods for
opaque session credentials. Its absence or a native error must not be hidden by
writing the secret into `gateway.storage`. Keys are bounded, values are
size-limited, and malformed bridge responses fail closed. This is a storage
boundary, not proof of server authentication: an installation ID or local
`playerId` is never a server principal by itself.

## App lifecycle and native entry

The adapter uses the official Capacitor App plugin for foreground state,
Android back navigation, and incoming URLs. Install `@capacitor/app` in the
native shell and run `cap sync` so the native plugin is present. The reference
shell and generated game template include it. A `classifyIncomingUrl` callback
must explicitly return `game` or `oauth`; unknown URLs are discarded rather
than being delivered to gameplay. Register your URL scheme or App/Universal
Links in the native host separately. See the [Capacitor App API](https://capacitorjs.com/docs/apis/app).

`lifecycle.onPause` and `onResume` deduplicate App and web visibility events.
Purchases, ads, and identity upgrades keep execution paused until their
provider operation settles. Use `beginExternalActivity` for other external UI.
On Android, a back handler returns `true` if the game consumed the event;
otherwise the adapter navigates browser history when possible or exits the
app. Cold URLs are read through `getInitialGameUrl` or
`getInitialOAuthRedirect`; warm URLs use separate `onGameUrlOpen` and
`onOAuthRedirect` callbacks. OAuth responses never enter the game-link
callback. Call `lifecycle.dispose()` when the host tears down this gateway;
the adapter removes only its own listener handles, never every App listener.

A game link is untrusted input. The adapter checks the link's path, query, and
fragment with `normalizeRootRelativeRoute` from `@mpgd/platform/routes` and
discards a link that rule refuses, such as `mygame://game//evil.example/x` or
`https://game.example/%2F%2Fevil.example/x`, because a client could read its
path as another host. A delivered event carries the checked path as `route`:
`/daily` for `mygame://game/daily`, as in the example above, where the host
only names the link kind. The host is never part of `route`, so
`mygame://level/3` gives `/3`. A router that routes by path opens
`event.route` rather than parsing `event.url`. A link with no path to check,
such as `mygame://daily`, arrives without `route`. A router that builds its
route from anything else in the URL, such as the host, checks that route with
`normalizeRootRelativeRoute` and opens only what it returns.

Save progress at checkpoints and transaction boundaries. A pause callback can
request a best-effort save, but neither pause nor back is guaranteed to run
before the operating system terminates a process. The lifecycle tests use an
injected App API and do not claim device-level lifecycle verification.

For example, let the game's checkpoint flow own durability; the native pause
event is only an additional opportunity to flush the latest checkpoint:

```ts
import type { PlatformGateway } from '@mpgd/platform';

export function attachCheckpointSaving(
  gateway: PlatformGateway,
  saveCheckpoint: () => Promise<void>,
): () => void {
  return gateway.lifecycle.onPause(() => {
    void saveCheckpoint().catch((error: unknown) => {
      console.error('Best-effort pause save failed.', error);
    });
  });
}

// The game also awaits saveCheckpoint() at level and transaction boundaries;
// it must never defer its only save until a close, back, or pause event.
```

## Scoped native JSON HTTP

`createCapacitorNativeJsonTransport` uses the explicit `CapacitorHttp.request`
helper from `@capacitor/core`; it does not enable global `fetch` or XHR patching.
Use it with the HTTP JSON path of `createGameServicesRuntime`, not the oRPC
path. The game imports only public kit APIs:

```ts
import { createCapacitorNativeJsonTransport } from '@mpgd/adapter-capacitor';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';

const baseUrl = 'https://api.example.com';
const httpTransport = createCapacitorNativeJsonTransport({
  target: 'android',
  baseUrl,
  allowedOrigin: 'https://api.example.com',
});
const runtime = createGameServicesRuntime({
  gateway,
  playerId,
  authorityMode: 'production',
  baseUrl,
  transport: 'http',
  httpTransport,
  getHeaders: () => ({ authorization: `Bearer ${currentAccessToken()}` }),
});
```

The game supplies its real gateway, player ID, and token resolver. The native
transport permits only its configured HTTPS origin and relative JSON API paths;
it rejects 3xx responses and changed routes while tolerating equivalent native
URL encoding of the same path or query. It requests
`disableRedirects: true` from Capacitor. A native implementation that ignored
that option could have followed a redirect before JS sees the result, so
redirect and credential handling still require native integration testing.
The transport owns `Accept: application/json` and POST `Content-Type`; callers
supplying either header are rejected instead of having it silently rewritten.
It supports GET and POST JSON only, not streaming, file uploads, or arbitrary
Fetch semantics. `AbortSignal` and the overall timeout stop the
JS wait; they do **not** prove the native request or server operation was
canceled. Reconcile purchases and reward claims before retrying them.

Request size is checked before calling the native bridge. The response size
limit is checked **after** Capacitor returns data to JS; it is not a native
receive-memory cap. The injected Http tests and platform staging builds cover
the contract, not real network behavior on both physical OSes. See the
[Capacitor HTTP API](https://capacitorjs.com/docs/apis/http) for the native
helper and its redirect/timeout options.

## Usable viewport and native occupied surfaces

`gateway.viewport` reports the full WebView size and separate safe-area,
system-bar, keyboard, and named occupied-surface measurements in **CSS pixels**.
Pass the state to `resolveTargetViewportUsableArea` from `@mpgd/target-config`;
it takes the furthest intrusion per edge rather than summing overlapping
safe-area, system-bar, keyboard, and banner values. The default host reads the
starter's `--mpgd-safe-area-*` CSS variables, Capacitor SystemBars'
`--safe-area-inset-*` fallback, and `visualViewport` changes. On Android,
SystemBars injects fallback CSS variables for older WebViews whose CSS `env`
safe-area values are incorrect. The injected `--safe-area-inset-*` values must
be valid CSS lengths on `documentElement` (`:root`); putting them only on
`body` or a nested container does not update the root aliases. See the
[SystemBars API](https://capacitorjs.com/docs/apis/system-bars).
Keyboard behavior also depends on the native [Keyboard resize mode](https://capacitorjs.com/docs/apis/keyboard),
so inspect the actual device layout before promising a particular inset.

Choose **one layout owner**. The starter's existing CSS padding already
reserves safe-area space; do not apply `usableArea.contentBounds` to that
already-padded `#game` element. For a JS-owned full-viewport canvas and DOM
overlay, remove the host's safe-area padding and apply the same rectangle to
both elements:

```ts
import { resolveTargetViewportUsableArea } from '@mpgd/target-config';
import type { PlatformGateway } from '@mpgd/platform';

export function mountUsableViewport(
  gateway: PlatformGateway,
  canvasHost: HTMLElement,
  overlayHost: HTMLElement,
): () => void {
  const viewport = gateway.viewport;
  if (viewport === undefined) return () => undefined;
  const apply = () => {
    const state = viewport.getState();
    const bounds = resolveTargetViewportUsableArea(state, state).contentBounds;
    for (const element of [canvasHost, overlayHost]) {
      element.style.position = 'absolute';
      element.style.left = `${bounds.x}px`;
      element.style.top = `${bounds.y}px`;
      element.style.width = `${bounds.width}px`;
      element.style.height = `${bounds.height}px`;
    }
  };
  apply();
  return viewport.onChange(apply);
}

// Call the returned unsubscribe during game teardown. lifecycle.dispose()
// tears down the gateway-owned native viewport listeners.
```

Future banner providers can call `createCapacitorViewport()` and pass that
controller to `createCapacitorPlatformGateway({ viewport })`, then report
actual `surfaceId` bounds with `setOccupiedSurface`. For physical-pixel
measurements, the provider supplies `pixelsPerCssPixel`; the game never guesses
device pixel ratio. A caller-injected controller remains caller-owned and must
be disposed separately. Tests cover layout, rotation, multiple surfaces, and
unsubscribe, but do not establish physical-device inset or keyboard accuracy.
