# @mpgd/adapter-ait

## 0.21.7 — 2026-10-29

### Patch changes

- Updated dependencies: @mpgd/bridge@0.18.0, @mpgd/catalog@0.14.1, @mpgd/game-runtime@0.9.0, @mpgd/platform@0.34.0

## 0.21.6 — 2026-10-28

### Patch changes

- Updated dependencies: @mpgd/bridge@0.17.0, @mpgd/catalog@0.14.0, @mpgd/game-runtime@0.8.10, @mpgd/platform@0.33.0

## 0.21.5 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/catalog@0.13.0, @mpgd/game-runtime@0.8.9

## 0.21.4 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/catalog@0.12.0, @mpgd/game-runtime@0.8.8

## 0.21.3 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/game-runtime@0.8.7

## 0.21.2 — 2026-10-27

### Patch changes

- [0a0ebd93](https://github.com/imjlk/mpgd-kit/commit/0a0ebd93bfda1aec7737f20465fe78bd4d562767) Align the tested Apps in Toss WebView SDK and CLI baseline on 3.9.0 in the adapter, generated AIT hosts and lite/Phaser starters. This SDK fixes completed/refunded order pagination and reports product-grant callback failures once. Existing games upgrade their game and wrapper pins together and revalidate native identity, sharing, review, advertising and purchase flows; Kit upgrades do not silently replace an uploaded game bundle. — Thanks @imjlk!

## 0.21.1 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/bridge@0.16.4, @mpgd/catalog@0.11.3, @mpgd/game-runtime@0.8.6, @mpgd/platform@0.32.0

## 0.21.0 — 2026-10-26

### Minor changes

- [1d2d74e0](https://github.com/imjlk/mpgd-kit/commit/1d2d74e058e6fae18e7d5b4d1850b29a94c6165e) Optional review providers distinguish opaque native requests from explicit store-page navigation. Add an opt-in target integration, persisted visit/play/cooldown policy, AIT Review.request, Capawesome AppReview for explicitly selected mobile stores, and Microsoft/registered ONE store or Verse8 listing helpers. Unsupported hosts have no prompt or storage activity; no outcome claims that a review was displayed or submitted. Import review adapters by subpath so unused SDKs stay out of browser and inline bundles. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/bridge@0.16.3, @mpgd/catalog@0.11.2, @mpgd/game-runtime@0.8.5, @mpgd/platform@0.31.0

## 0.20.7 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/bridge@0.16.2, @mpgd/catalog@0.11.1, @mpgd/game-runtime@0.8.4, @mpgd/platform@0.30.0

## 0.20.6 — 2026-10-26

### Patch changes

- [3d603721](https://github.com/imjlk/mpgd-kit/commit/3d6037213f0494348cdca31e694416cb40de3354) Describe optional host-carried promotion authority acknowledgements and verify AIT passthrough, allowing consumers to omit duplicate finalization only after account-scoped server confirmation. — Thanks @imjlk!
- Updated dependencies: @mpgd/bridge@0.16.1, @mpgd/catalog@0.11.0, @mpgd/game-runtime@0.8.3, @mpgd/platform@0.29.0

## 0.20.5 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/bridge@0.16.0, @mpgd/catalog@0.10.8, @mpgd/game-runtime@0.8.2, @mpgd/platform@0.28.0

## 0.20.4 — 2026-10-24

### Patch changes

- Updated dependencies: game-runtime@0.8.1

## 0.20.3 — 2026-10-21

### Patch changes

- [c7e1e16d](https://github.com/imjlk/mpgd-kit/commit/c7e1e16dac23683c361db096e90a01694eb871d0) Store new Apps in Toss promotion markers under `mpgd:ait:promotion-grant:v2:<campaignId>:<idempotencyKey>`, and write a v1 dispatch fence at `mpgd:ait:promotion-grant:v1:<idempotencyKey>` before that copy and before payout. The fence includes `campaignId`. Until a granted receipt replaces it, its status is `fenced`, which a rolled-back @mpgd/adapter-ait 0.20.1 bridge treats as already fenced and does not dispatch or remove. If that v1 write fails, the claim stays pending and nothing is dispatched.
  
  A legacy v1 marker with no `campaignId` is still stamped in place before any scoped copy. If that stamp cannot be stored, or the legacy marker cannot be read, the claim stays pending, nothing is copied, and an authority receipt is not cached or returned. The read-failure behavior is an approved fail-closed decision: a markerless authority receipt is not persisted while the legacy read is failing. A v1 marker bound to this campaign is this campaign's record. One bound to another campaign stays pending and is not overwritten or paid again.
  
  When `authorizePromotionGrant` is configured, it remains the primary dispatch fence. The local markers do not authorize a payout the authorizer did not approve, and they do not add a dispatch path that skips it. A pending scoped copy does not hide a granted v1 receipt: a retry sees that receipt and does not dispatch again. Host bridges that share storage share the claim lock. Server-issued idempotency keys should stay unique across campaigns. — Thanks @imjlk!
- Updated dependencies: @mpgd/bridge@0.15.0, @mpgd/catalog@0.10.7, @mpgd/game-runtime@0.8.0, @mpgd/platform@0.27.2

### Changed

- [b918119c](https://github.com/imjlk/mpgd-kit/commit/b918119c26437b13d6ca4a7e57a3104b81fe0687) The Apps in Toss host serves `notifications.v2.*` with `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`, the handler the Capacitor and Devvit bridges share. For errors thrown by `@mpgd/platform` and this package, codes, retryable flags, and events are unchanged (some error messages are reworded), except that a provider answering `register` or `openSettings` with `undefined` now answers `NOTIFICATIONS_CONFIGURATION_REQUIRED`, as any other answer that breaks the contract does, instead of `null` or `unavailable`. The Apps in Toss provider never answers that. The game-side provider reads a host code back with `readBridgeNotificationsHostCode`. Failures are now also read by shape, so an error from another copy of `@mpgd/platform`, or a thrown object with a platform `code` and a boolean `retryable`, keeps its retryable flag, and its code too when that is a notifications code (any other code crosses as `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`). — Thanks @imjlk!

### Fixed

- [b918119c](https://github.com/imjlk/mpgd-kit/commit/b918119c26437b13d6ca4a7e57a3104b81fe0687) The Apps in Toss game-side notifications provider fails closed when the host answers `notifications.v2.getCapabilities` with a notifications protocol version the game's `notificationsProtocolVersion` is not compatible with: while either is a pre-release (now `2.0.0-draft.1`), the host must share the major and the whole pre-release tag, so `2.0.0-draft.1` does not accept `2.0.0-draft.2` or `2.0.0`; between releases, the major decides; anything that is not a semantic version is refused. Such a host, or one serving another provider id, is judged from a capability read: `getCapabilities` reads every time, any other method reads once before the first verdict, and a failed read gives no verdict, so the next call reads again. Once the host is judged incompatible, every method throws `NOTIFICATIONS_CONFIGURATION_REQUIRED` without reaching it (the gateway reports notifications as `configuration-required`), live subscriptions are detached, and `subscribe` attaches nothing. — Thanks @imjlk!

## 0.20.2 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/bridge@0.14.3, @mpgd/catalog@0.10.6, @mpgd/game-runtime@0.7.6, @mpgd/platform@0.27.1

## 0.20.1 — 2026-10-21

### Patch changes

- [eccdcb2c](https://github.com/imjlk/mpgd-kit/commit/eccdcb2c2cbc0629aa449ec9cde11f4864f603d8) Stop a second Apps in Toss promotion payout when a granted receipt could not be stored, when grant and recover overlap, or when an explicit failure marker could not be written. Grant and recover for one idempotency key share a lock, re-read storage and the bridge-local receipt cache before payout, and do not evict a receipt whose durable write failed.
  
  Promotion markers stay keyed by the claim id, `mpgd:ait:promotion-grant:v1:<idempotencyKey>`. New records include `campaignId`. A stored record whose campaign id differs stays pending and is not overwritten or paid again. Records without `campaignId` are unchanged. Campaign-scoped keys are a follow-up.
  
  A stored explicit failure can be cleared by an authority `retry`. A failure whose diagnostic write did not land stays blocked in that process.
  
  An older host that does not implement `promotions.recoverReward` now answers `{ status: 'pending' }` instead of throwing. That includes a protocol validator rejection reported as `AIT_BRIDGE_REQUEST_FAILED`, not only `UNSUPPORTED_METHOD`. `grantReward` is unchanged. A late promotion observer rejection is ignored and cannot reject the payout result. — Thanks @imjlk!
- Updated dependencies: @mpgd/bridge@0.14.2, @mpgd/catalog@0.10.5, @mpgd/game-runtime@0.7.5, @mpgd/platform@0.27.0

## 0.20.0 — 2026-10-20

### Added

- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) `@mpgd/adapter-ait/notification-config` exports `extractAitNotificationTopicConfig(catalog, { target, sourceLabel })`, which reads the `notificationTopics` of `installAitHostBridge` from a notification topic catalog's `targets.ait` mappings (`templateSetCode`, `agreement`). The catalog is checked with `validateNotificationTopicCatalog` from `@mpgd/catalog` (now a dependency) and the Apps in Toss registry entry, so for the Apps in Toss target the wrapper refuses what `pnpm validate:notifications` refuses, including an advertising topic mapped for Apps in Toss; other targets' mappings and the deployment are left to `pnpm validate:notifications`.
  
  The generated Apps in Toss wrapper reads the game's notification topic catalog at build time (`MPGD_NOTIFICATION_TOPICS_FILE`, else `notifications/topics.json` when it exists) and passes its Apps in Toss topics to the host bridge, so notifications v2 agreements and landings work once the game maps its console templates. Without a catalog or a mapping the wrapper behaves as before. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/bridge@0.14.1, @mpgd/catalog@0.10.4, @mpgd/game-runtime@0.7.4, @mpgd/platform@0.26.0

## 0.19.0 — 2026-10-19

### Minor changes

- [96d8add4](https://github.com/imjlk/mpgd-kit/commit/96d8add43a4eff1f790b4cc8514a8839f7f7608c) Add optional recovery-only promotion calls that read persisted or authority-confirmed receipts without authorizing or starting a provider payment. Preserve pending markers even when the resolver permits a retry; a fresh explicit grant remains separate. — Thanks @imjlk!

### Patch changes

- [d6edd2c6](https://github.com/imjlk/mpgd-kit/commit/d6edd2c6c43e958a1d322a1d3581789d8ef611e6) Recover cached and authority-confirmed promotion receipts regardless of payout capability, retain markerless receipts, and consult the authority after storage read failure without inventing a dispatch timestamp. Preserve ambiguous SDK diagnostics across restarts and retain terminal receipts in a bounded bridge-local fallback when native storage fails. Recovery never authorizes a new payout. — Thanks @imjlk!
- Updated dependencies: bridge@0.14.0, game-runtime@0.7.3, platform@0.25.0

## 0.18.0 — 2026-10-19

### Minor changes

- Preserve bounded provider error codes and the pending dispatch marker after an explicit promotion failure. Add an optional best-effort outcome observer for authority diagnostics and successful receipt recording, including replay after host restart. Observation failure or timeout never changes payout success or permits retry; raw provider messages are not persisted or forwarded.
- [a6690e9e](https://github.com/imjlk/mpgd-kit/commit/a6690e9e734195fee0478be50078b4955f0bef34) Serve notifications v2 on Apps in Toss. The host bridge answers the `notifications.v2.*` methods from a provider over `Notification.requestAgreement` (Toss 5.255.0 or later), configured with the new `notificationTopics` option (`templateSetCode` and `agreement` per topic; v1 `notificationTemplateCodes` become agreement-required topics), and the gateway exposes `notificationsV2` whenever the host offers the notifications event channel, which the host does while a topic is mapped; the game side loads the bridge client and its validators lazily, on first use. Agreement answers map to `granted`, `already-granted`, and `denied`, a sheet without an answer within 120 seconds to `dismissed`, `TERMS_DISAGREED_MEMBER` to `action-required` (`host-settings`), and each decision carries `apps-in-toss.notification-agreement.v1` evidence for the backend's consent record. A launch whose referrer is `push` or `inbox` is routed exactly once, by whichever comes first: a cold `opened` event with its landing route, after which `presentation.getLaunchIntent()` answers `home`, or the launch intent itself; this applies while `notificationTopics` maps a topic (games that map only v1 template codes keep their launch routes). The v1 `notifications` methods are now served from the same provider; a topic agreed to during the bridge's lifetime reads `subscribed` from a v1-only session cache, as before, and v2 reads stay `unknown` (`unsupported`, and `requestSubscription` `unavailable`, on Toss older than 5.255.0). The `requestNotificationAgreement` host dependency is now typed as and defaults to `Notification.requestAgreement`, a new `readInitialUrl` dependency reads `Environment.initialURL` (the page URL serves where the host gives none), and `notificationAgreementTimeoutMs` may shorten the 120-second settle. Without any mapped topic the gateway offers no `notificationsV2`, and the host's v2 methods answer `configuration-required` capabilities. `@mpgd/adapter-ait/local-mock` now exports `Notification` and `Environment` in place of `requestNotificationAgreement`. In the kit's Apps in Toss staging build the game's eagerly loaded chunks grow by about 2 kB gzip, the lazily loaded notifications chunk is about 18 kB gzip, and the wrapper bundle, which serves the host side, grows by about 19 kB gzip. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.13.2, game-runtime@0.7.2, platform@0.24.0

## 0.17.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.13.1, game-runtime@0.7.1, platform@0.23.1

## 0.17.0 — 2026-10-15

### Minor changes

- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: commerce v2, PR C4 removes the commerce v1 surfaces from the Apps in
  Toss adapter. The `commerce.v2.*` provider is the only commerce path.
  
  - `createAitPlatformGateway()` no longer builds the v1 `gateway.commerce`
    adapter (`getProducts`, `purchase`, `restore`, `getEntitlements`). The
    provider the gateway builds over the host bridge's commerce event channel is
    now `gateway.commerce` (it was `gateway.commerceV2`); the gateway has no
    `commerce` when the installed bridge exposes no channel. The
    `GamePlatformBridge.commerceV2` event-channel field keeps its name: it is the
    protocol's channel, not the gateway property.
  - `gateway.getCapabilities()` returns the host answer without the removed
    `nativeIap` and `subscriptionIap` flags and with a `commerce` block that is
    always valid: the host's block when the gateway has a commerce provider and
    the block is well formed, otherwise `createUnsupportedCommerceCapabilities()`
    (a fresh object on every read).
  - `createAitHostBridge()` / `installAitHostBridge()` no longer serve the
    `commerce.getProducts`, `commerce.purchase`, `commerce.restore` and
    `commerce.getEntitlements` methods (the bridge protocol dropped them, so a
    request for one is rejected), and `runtime.getCapabilities` no longer sends
    `nativeIap` or `subscriptionIap`; the `commerce` block is the only source.
    Replacement for each: `commerce.v2.fetchProducts`, `commerce.v2.requestPurchase`,
    `commerce.v2.restorePurchases` and `commerce.v2.getAvailablePurchases`
    (through `gateway.commerce`, which `@mpgd/game-services` drives).
  - The `readIapEntitlements` option, the `AitIapEntitlementReader` type, and the
    `AIT_IAP_ENTITLEMENT_READ_FAILED` diagnostic code
    (`aitIapDiagnosticCodes.entitlementReadFailed`, and its
    `aitIapCommerceErrorCodeMap` entry) are removed. Selling no longer requires
    an entitlement reader: with `iapProducts`, `prepareIap`, `verifyIapProductGrant`
    and the four native IAP methods the commerce block reports `available`.
    Ownership that survives a wrapper restart comes from the backend ledger
    (server-side `listActiveEntitlementTransactions` in `@mpgd/game-services`).
  - `createAitSandboxBridge()` drops the v1 `commerce.*` cases (its v1 purchase
    completed itself with entitlement ids) and the `nativeIap` flag. Its
    `runtime.getCapabilities` answers `createAitCommerceCapabilities('available')`
    only for the `ait-sandbox` build and the unsupported block otherwise.
  - `AitIapControllerOptions`, the base of `CreateAitCommerceProviderInput` for
    `createAitCommerceProvider()`, loses `readIapEntitlements`. The provider's
    behavior (purchase, available purchases, `finishTransaction`,
    `restorePurchases`) is unchanged.
  
  Gateway commerce capabilities follow the same pinned host bridge as purchase commands and events after a global bridge replacement. — Thanks @imjlk!
- [0234f853](https://github.com/imjlk/mpgd-kit/commit/0234f853cffff19e181587cef79fd0465144ed61) Every target whose host builds or receives a share URL now checks
  `ShareIntent.deepLink` with one rule before the host sees the intent.
  
  - `@mpgd/platform/routes` adds `normalizeShareLink(deepLink)`, the share-link
    rule web sharing already followed. A root-relative link becomes the route
    `normalizeRootRelativeRoute` returns. An absolute link must spell out
    `https://` or `http://`, carry no credentials, and keep a path no client
    reads as another host. Anything else answers `undefined`.
  - `@mpgd/platform/routes` also adds `readShareIntent(intent)` and
    `withShareIntentCheck(sharing)`. The wrapper answers
    `{ status: 'unavailable' }` for an intent that is not an object, has no
    string `text`, or has a link the rule refuses, without calling the adapter.
    An accepted intent reaches the adapter with its link normalized. They stay
    out of the main entry, which headless consumers type-check without the
    `URL` global.
  - `@mpgd/platform/share-link-conformance` adds `runShareLinkConformance`. It
    shares every vector in `rootRelativeRouteVectors` and the new
    `shareLinkVectors` (`@mpgd/platform/route-vectors`), plus malformed intents,
    through an adapter's `share`. It checks the answers and the link the host
    was handed, and it throws one error that lists every failure. Each adapter
    that maps share links runs it, and the root
    `pnpm validate:share-link-conformance` fails for an adapter that defines a
    share without running it. WeChat is listed as exempt: its share card carries
    no link, and mini-game runtimes have no `URL` global.
  - The Capacitor and Devvit gateways wrap `sharing` with
    `withShareIntentCheck`. A link outside the contract, such as
    `mygame://invite`, `./daily`, or `/%2F%2Fevil.example/x`, now answers
    `unavailable` without reaching the native or server bridge, and the bridge
    receives the normalized link. Before, they passed every intent on as is.
    The common reader also requires a supported `kind` and string `title` and
    `text` before dispatching to these adapters.
  - Apps in Toss reads links that are not `intoss://<app>` links with
    `normalizeShareLink` before reducing them to their path. It now also refuses
    `https:/daily`, `https:evil.example/x`, and links with credentials, which it
    used to reduce to a path. — Thanks @imjlk!
- [dd76b8d7](https://github.com/imjlk/mpgd-kit/commit/dd76b8d736cc90b1e1d810d18745b2cd043d2c55) `@mpgd/platform/routes` exports one route-safety rule for links a game hands
  to the kit, and `@mpgd/platform/route-vectors` exports the shared `normalized`
  and `rejected` vectors that every package mapping such links runs:
  
  - `normalizeRootRelativeRoute(input)` returns the path, query, and hash a
    root-relative link names on the game's origin. It answers `undefined` when a
    client could read the link as another host: a second slash or a backslash
    after the leading slash, a control character, or a path that begins with an
    empty segment after dot segments collapse. The same holds when the path is
    percent-decoded once and parsed again, with the path ending at any decoded
    `?` or `#` or keeping them all. A path with more than 16 decoded `?` and `#`
    is refused.
  - `hasNetworkPathPrefix(pathname)` and `hasRouteControlCharacter(value)` are the
    checks it builds on. `hasNetworkPathPrefix` answers `true` for anything that
    is not a URL path.
  
  Notification delivery in `@mpgd/game-services` and Apps in Toss sharing in
  `@mpgd/adapter-ait` use this rule instead of their own copies. They now also
  refuse a path that reaches another host when a decoded `?` or `#` stays in the
  path instead of ending it, such as `/%3F%2F..%2F%2Fhost`, and a path with more
  than 16 decoded `?` and `#`.
  
  Web sharing in `@mpgd/adapter-browser` now follows the `ShareIntent.deepLink`
  contract:
  
  - A root-relative link is normalized and stays relative, so Web Share resolves
    it against the document as before.
  - An absolute link must spell out `https://` or `http://`, carry no
    credentials, and keep a path no client can read as another host.
  - It answers `unavailable` for anything else, including page-relative links
    (`./daily`, `?x=1`), `javascript:`, `data:`, and `intoss:` links, and a
    `text` or `deepLink` that is not a string. Before, it passed any string on.
  
  The Apps in Toss sandbox bridge now reads share requests exactly as the host
  bridge does:
  
  - It answers `unavailable` for a request the host refuses, and
    `{ status: 'shared', completion: 'presented' }` otherwise. Before, it
    answered `{ status: 'shared' }` for any request, which reads as completed.
  - A new optional `appName` option sets the app name `intoss://` links must
    carry. It defaults to `mpgd-kit`, as on the host. — Thanks @imjlk!

### Patch changes

- [d8486b02](https://github.com/imjlk/mpgd-kit/commit/d8486b0279dd6b1e6d83e4bef192e62413aa1636) Notifications v2, PR N3: transports without v2 answer every
  `notifications.v2.*` method with `NOTIFICATIONS_V2_UNAVAILABLE`, which is not
  retryable, instead of `UNSUPPORTED_METHOD`. No adapter serves notifications v2
  yet; P1–P3 add the providers.
  
  - `@mpgd/adapter-ait`: the host bridge and the sandbox bridge, in every build,
    answer the code without reaching the host's agreement API. The commerce v2
    provider over the bridge validates events with the commerce envelope and
    ignores notifications envelopes. The commerce event channel
    (`GamePlatformBridge.commerceV2`), `AitCommerceV2BridgeHandler`, and
    `CreateAitBridgeCommerceProviderInput.subscribe` keep the commerce envelope
    type (`BridgeCommerceEvent`) they had before `BridgeEvent` became a union.
  - `@mpgd/adapter-capacitor`: the gateway's request path answers the code for
    a method no registered provider serves, before it pauses the game or
    reaches the base plugin, and a provider cannot declare those methods. For
    the provider P2 adds, `notifications.v2.requestPermission` and
    `notifications.v2.openSettings` pause the game, and the registry passes
    `notifications.v2.*` through `assertMethodReady` as it does `commerce.v2.*`.
    A launched commerce v2 purchase ends its pause on commerce events only, and
    the gateway hands its commerce provider only the commerce envelopes of the
    provider's channel. The commerce v2 provider over the bridge reports an
    envelope that names no protocol as a purchase error, as the Apps in Toss
    provider does, instead of dropping it. `CommerceProviderBridge.subscribe` and
    `CreateBridgeCommerceProviderInput.subscribe` keep the commerce envelope
    type (`BridgeCommerceEvent`) they had before `BridgeEvent` became a union.
  - `@mpgd/adapter-devvit`: the sandbox bridge answers the code.
  - `@mpgd/cli` and `@mpgd/create-game`: the generated Devvit server bridge
    answers the code, and the Apps in Toss sandbox gateway says so. — Thanks @imjlk!
- Updated dependencies: bridge@0.13.0, game-runtime@0.7.0, platform@0.23.0

### Added

- [295435cd](https://github.com/imjlk/mpgd-kit/commit/295435cd3f960901596f21c6e60df4edfc749825) Reuse ait-kit for SDK 3.6 single-use anonymous authentication: expose a host code issuer and a server mTLS exchange method while retaining response bounds, cancellation, and authoritative session boundaries.
  
  Align generated AIT hosts and starter validation on official WebView SDK and CLI 3.6.0 so new projects can issue anonymous authentication codes. — Thanks @imjlk!

## 0.16.0 — 2026-10-12

### Minor changes

- [5871a314](https://github.com/imjlk/mpgd-kit/commit/5871a31405de4caddd7fbb5d252b452310dd44df) Commerce v2, PR C3: catalog-derived host products for Apps in Toss and Devvit.
  
  - `@mpgd/adapter-ait/iap-config` exports `extractAitIapProductConfig(catalog,
    { target?, sourceLabel? })`: one `AitIapProductConfig` `{ productId, sku }`
    per one-time product whose `platformProductIds.ait` (or `target`) names the
    console SKU, for `installAitHostBridge({ iapProducts })`. Subscriptions are
    skipped; an invalid catalog, a duplicate product id, and a blank, padded,
    or duplicate SKU throw. It imports no SDK, so a wrapper's build config can
    call it.
  - `@mpgd/adapter-devvit` exports `createDevvitCommerceBridgeProducts(catalog,
    target = 'reddit')` (`{ productId, sku }` for
    `createDevvitCommerceV2BridgeHandler`, also from
    `@mpgd/adapter-devvit/server`) and `createDevvitCommerceProducts(catalog,
    { target?, describe? })` (the `DevvitCommerceProduct` list for
    `createDevvitPlatformGateway({ commerce })`), both read from
    `platformProductIds.reddit` so the webview and the server agree on every
    SKU; subscriptions are skipped and blank, padded, or duplicate SKUs throw.
  - `@mpgd/adapter-devvit/web` exports `createDevvitWebPaymentsClient()`, the
    checkout client over `purchase()` from `@devvit/web/client` (one SKU, no
    client metadata), and `toDevvitCheckoutResult(event)`: `STATUS_SUCCESS`
    with an order id is `completed`, without one `pending`, `STATUS_CANCELLED`
    is `cancelled` (`USER_CANCELLED`), `STATUS_ERROR` is `failed` with the
    platform `errorCode` as `storeCode`, and an unknown status is `pending`, so
    nothing is granted or dropped on the client. — Thanks @imjlk!

### Patch changes

- [a55cb900](https://github.com/imjlk/mpgd-kit/commit/a55cb9007cca5b0af50fb38df5e8aec1bb452567) Sharing on Apps in Toss now answers `unavailable` for a share link that a
  client could read as another host, and for any link that contains a control
  character. A root-relative link with a backslash right after the leading
  slash used to throw `TypeError: Invalid URL` (`/\ x`), which the bridge
  reported as a retryable request failure, or was rewritten to an `intoss://`
  path (`/\` followed by the internal placeholder host). The same rules now
  apply to the path of root-relative, `https://`, and `intoss://` links, as
  they do for notification deep links in `@mpgd/game-services`: a path that
  begins with an empty segment directly (`//host`), after dot segments collapse
  (`/.//host`), or once percent-decoded (`/%2F/host`, `/%09/host`) is refused.
  
  An `intoss://` link is now read as the path it carries and rebuilt, and it
  must start with exactly `intoss://<app>` followed by `/`, `?`, `#`, or
  nothing. Before, the raw input was forwarded whenever URL parsing found the
  app's host, so `intoss://other\@<app>/path`, which Android reads as the host
  `other`, was shared unchanged. Links with a stray tab or newline, which URL
  parsing used to drop silently, are now refused rather than shared. — Thanks @imjlk!
- Updated dependencies: game-runtime@0.6.6

## 0.15.2 — 2026-10-12

### Patch changes

- Updated dependencies: bridge@0.12.3, game-runtime@0.6.5, platform@0.22.0

## 0.15.1 — 2026-10-12

### Patch changes

- Updated dependencies: bridge@0.12.2, game-runtime@0.6.4, platform@0.21.0

## 0.15.0 — 2026-10-12

### Minor changes

- [d59304d8](https://github.com/imjlk/mpgd-kit/commit/d59304d8eec21ad61f8e24c07bbafb44e953b268) Commerce v2, PR B5: the Apps in Toss provider.
  
  `@mpgd/adapter-ait` adds `createAitCommerceProvider({ dependencies, iapProducts,
  prepareIap, verifyIapProductGrant, readIapEntitlements?, iapProductGrantTimeoutMs?,
  onPendingOrdersChanged? })`, a `CommerceProvider` with `store: 'apps-in-toss'`
  and the RFC profile (consumable and durable one-time products, no subscription,
  no quantity, `lifecycle.finish: 'host'`, `authority.evidence: 'host-callback'`,
  `accountBinding: 'host'`, pending, restore, events, available purchases,
  localized prices). It runs the host bridge's own IAP machinery, now shared
  through an internal controller, so a v1 `commerce.purchase` and a v2
  `requestPurchase` hold the same IAP lock and the same durable attempt markers,
  pre-checkout pending-order barrier and acknowledgement barriers; the v1
  `commerce.*` bridge methods behave exactly as before.
  
  - `fetchProducts` lists the configured one-time SKUs from `getProductItemList`
    (`CONSUMABLE` as `consumable`, `NON_CONSUMABLE` as `durable`, subscriptions hidden).
  - `requestPurchase` opens `createOneTimePurchaseOrder`. The game-owned
    `verifyIapProductGrant` hook inside the SDK grant callback stays the only
    server confirmation: a `purchased` result (order id as `transactionId` and
    `token`, `apps-in-toss.iap.callback.v1` evidence `{ orderId, sku, source }`,
    `host-identity` binding) is produced only after that hook confirmed the
    grant. A cancellation is `cancelled` and a terminal failure `failed` with the
    `AIT_IAP_*` code as `storeCode` (`aitIapCommerceErrorCodeMap`); every
    outcome the host cannot settle yet (grant pending, acknowledgement
    unconfirmed, checkout timeout, `OUTCOME_UNKNOWN` and `ALREADY_OWNED`
    classes) is `launched`, so the attempt stays open for the reconciler.
  - `getAvailablePurchases` lists the paid, ungranted orders of `getPendingOrders`
    as `purchased`, server-granted orders whose `completeProductGrant()` was not
    confirmed as `purchased`, and, with `includePending`, orders a checkout of
    this session observed that the host does not list yet as `pending`.
  - `finishTransaction({ transactionId, ledgerEntryId, isConsumable })` is the
    host finish: it refuses to run without the reconciler's ledger entry id,
    confirms the grant for the order through `verifyIapProductGrant` first
    (the game side of the bridge is not trusted to hold a grant; the hook must
    be idempotent per order, as the v1 restore pass already requires, and
    reachable from a v2-only integration, or the order stays unfinished), then
    acknowledges a listed order with `completeProductGrant()` (marking the
    linked client attempt completed first, as the restore pass does) and
    settles the barrier of an order the host already finished. It never grants,
    and an order the provider lists under another SKU is never acknowledged.
  - `restorePurchases` runs the pending-order recovery pass (prepare, verify
    through `verifyIapProductGrant`, acknowledge) and reports settled and
    still-pending orders as `purchaseUpdated` events; events before the first
    listener are buffered (`createCommerceEventBuffer`).
  - `onPendingOrdersChanged` is the signal that the pending-order list may have
    changed (the app resuming from the checkout page by default); the provider
    observes it while a listener exists, re-reads the list, reports orders the
    signal carries (`AitPendingOrdersChange`) at once, and emits
    `purchaseUpdated` once per order. Orders the host finished stay available
    until the reconciler finishes them. The provider emits no `purchaseError`:
    every checkout outcome is a synchronous result.
  
  The host bridge (`createAitHostBridge`) now serves the six `commerce.v2.*`
  bridge methods from that provider with the `@mpgd/platform/commerce` asserts
  on payloads and results, pushes `BridgeEvent` envelopes through the new
  `GamePlatformBridge.commerceV2` event channel, and answers
  `runtime.getCapabilities` with the `commerce` block and `subscriptionIap: false`
  added, `nativeIap` now derived from the block (its value is unchanged). The
  v1 `commerce.*` bridge methods keep their behaviour. `createAitPlatformGateway` exposes
  `commerceV2` (`createAitBridgeCommerceProvider`) whenever the installed bridge
  has the event channel. The sandbox bridge answers commerce v2 with an
  evidence-only stub for the `ait-sandbox` build id only; every other build keeps
  `COMMERCE_V2_UNAVAILABLE`.
  
  Conformance: `adapters/ait/src/ait-commerce-provider.conformance.test.ts` runs the
  RFC vectors through `runCommerceConformanceVectors` with a fake Apps in Toss
  host, directly and through the host bridge and gateway; `purchase-host-finish`
  is the canonical family member, and `event-before-listener`,
  `finish-failure-retry`, `restart-before-verify` and `revoked-after-grant` run
  with host-finish expectations derived for the `apps-in-toss` id. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.12.1, game-runtime@0.6.3, platform@0.20.0

## 0.14.1 — 2026-10-11

### Patch changes

- [b0b6e5a8](https://github.com/imjlk/mpgd-kit/commit/b0b6e5a8573cd251646600a646fa8ca2ec81292e) Commerce v2, PR A4: bridge methods and event envelope, `app-store-server`
  moved to `@mpgd/game-services`, one Google Play token key helper.
  
  `@mpgd/bridge` adds the six commerce v2 methods to `BridgeMethod`
  (`commerce.v2.getCapabilities`, `commerce.v2.fetchProducts`,
  `commerce.v2.requestPurchase`, `commerce.v2.getAvailablePurchases`,
  `commerce.v2.finishTransaction`, `commerce.v2.restorePurchases`), exported as
  `bridgeCommerceV2Methods` and kept equal to `commerceBridgeMethods` from
  `@mpgd/platform/commerce`, which is now a dependency. The event side exports
  `BridgeEvent` (the `{ protocol: 'mpgd.commerce.v2', sequence, event }`
  envelope), `assertBridgeEvent`, `BridgeEventListener`, `BridgeEventSource`
  (`subscribe(listener): () => void`), and `bridgeEventProtocol`. The
  `COMMERCE_V2_UNAVAILABLE` bridge error (`commerceV2UnavailableBridgeErrorCode`,
  `createCommerceV2UnavailableBridgeError`, `isBridgeCommerceV2Method`) is the
  non-retryable answer of a transport without a v2 provider; the Cloudflare
  Pages host stub returns it for every v2 method. The v1 `commerce.*` methods
  are unchanged.
  
  `@mpgd/game-services` adds the `./app-store-server` subpath with
  `createAppleSignedTransactionVerifier` and
  `CreateAppleSignedTransactionVerifierOptions`, moved from
  `@mpgd/adapter-capacitor`, together with the optional
  `@apple/app-store-server-library` (`^3.1.0`) peer dependency.
  `createGooglePlayTokenTransactionId` in `./google-play-purchase` is now a
  deprecated alias of `createGooglePlayTokenPurchaseKey` from
  `@mpgd/platform/commerce` (same key, same `TypeError` for an invalid token);
  import the platform helper instead. The alias is removed in the next major
  version.
  
  `@mpgd/adapter-capacitor` deprecates the `./app-store-server` subpath: it
  re-exports `createAppleSignedTransactionVerifier` and its options type from
  `@mpgd/game-services/app-store-server` for one release and no longer peers on
  `@apple/app-store-server-library`; install the Apple library next to
  `@mpgd/game-services`. `NativeBridge` gains an optional
  `subscribe(listener: (event: BridgeEvent) => void): () => void` so a B-phase
  store provider can deliver commerce v2 events; the gateway works without it.
  `createCapacitorProviderRegistry` rejects a provider that declares a commerce
  v2 method, since v2 providers are registered through their own surface.
  
  `@mpgd/capacitor-play-billing` computes the token transaction ID with
  `createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce` and keeps
  `createGooglePlayTokenTransactionId` as a deprecated alias of that helper.
  
  `@mpgd/adapter-devvit` and `@mpgd/adapter-ait` sandbox bridges answer
  `COMMERCE_V2_UNAVAILABLE` for commerce v2 methods instead of
  `UNSUPPORTED_METHOD`. `@mpgd/adapter-browser` only gains a test that the
  Microsoft Store native bridge ignores commerce v2 envelopes. — Thanks @imjlk!
- Updated dependencies: bridge@0.12.0, game-runtime@0.6.2, platform@0.19.0

## 0.14.0 — 2026-10-11

### Minor changes

- [e14ba051](https://github.com/imjlk/mpgd-kit/commit/e14ba0514288111447a5272e052682e1aae8f06a) Harden the built-in Apps in Toss purchase flow with recovery rules proven by a
  production game. Purchase verifiers now receive the game's own purchase key as
  `clientIdempotencyKey` on every path that can link an order to it, including
  restore after a reload. A new checkout is no longer opened while a paid order
  for the same product is still ungranted, only one checkout runs at a time
  (restore waits its turn with a retryable code), and a `PRODUCT_NOT_GRANTED_BY_PARTNER`
  error triggers one direct re-check of that order. Restore returns
  `settledPurchases` and reports failures as coded errors instead of an empty
  success; `getEntitlements` likewise rejects when the configured authority read
  fails. Catalog and purchase outcomes carry stable diagnostic codes
  (`aitIapDiagnosticCodes`). Add `aitBrowserOrigins()` and `isAitBrowserOrigin()`
  (`@mpgd/adapter-ait/origins`) for exact CORS allowlists. `@mpgd/platform` adds
  the optional `CommerceDiagnostic` type, `diagnostic` fields on purchase and
  restore results, and `idempotencyKey` on `PurchaseSettlement`.
  `@mpgd/adapter-capacitor` validates the new `diagnostic` and settlement
  `idempotencyKey` fields in native provider responses. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-runtime@0.6.1, platform@0.18.0

## 0.13.3 — 2026-10-10

### Patch changes

- Updated dependencies: game-runtime@0.6.0

## 0.13.2 — 2026-10-09

### Patch changes

- Updated dependencies: game-runtime@0.5.0, platform@0.17.0

## 0.13.1 — 2026-10-09

### Patch changes

- Updated dependencies: game-runtime@0.4.0, platform@0.16.0

## 0.13.0 — 2026-10-09

### Fixed

- [b453182e](https://github.com/imjlk/mpgd-kit/commit/b453182e07aafc5e6db636422faa1bc29e3a97b7) Add a game-owned platform runtime and audio projection shared above scene lifetimes. Wire generated Phaser games to coordinated native presentation, registered late evidence recovery, application-owned journals and reconciliation, and scene-scoped action views. Preserve physical ownership after deadlines and prevent scene teardown from unmuting live ads. — Thanks @imjlk!

### Added

- [3e560af5](https://github.com/imjlk/mpgd-kit/commit/3e560af5b3f9e15ee561a51682828337fd614e22) Expose Apps in Toss advertising through a versioned proxy/host bridge with SDK-scoped native observations. Separate reward eligibility from closure and ledger grants, retain late callbacks after deadlines, coordinate the shared native SDK, and preserve background lifecycle ownership. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.11.0, game-runtime@0.3.0, platform@0.15.0

## 0.12.7 — 2026-10-04

### Patch changes

- [f6d8f7e4](https://github.com/imjlk/mpgd-kit/commit/f6d8f7e41f46a34f7b20c99810f717d244631bbf) Harden the Apps in Toss host bridge: reject game `storage.save`/`storage.load` keys under the adapter-reserved `mpgd:ait:` prefix so game code cannot forge completed purchase or promotion markers, bound the client-supplied rewarded-ad `idempotencyKey` to 1-256 visible characters and document it as evidence the backend reward authority must verify, restrict `fetchAitAuthority` to `https:` resources (plain `http:` only for `localhost`/`127.0.0.1`) while accepting only a string, a URL-like object (string `href`, recognized by shape so a cross-realm `URL` is covered), or a same-realm `Request`, and forwarding only the validated representation to the transport (the resolved `href` string, or the `Request` instance after its `url` validated), and cap launch-intent `puzzleId`/`challengeToken` values and nested `queryParams` size and entry count.
  
  The `@mpgd/cli` `phaser-game` template now selects the self-completing `aitSandbox` gateway only for a non-production build whose `BUILD_ID` is exactly `ait-sandbox` (the value `pnpm dev:ait` sets); every other AIT build, including other debug builds, uses the production `ait` gateway so purchases and rewards cannot be granted without the backend. — Thanks @imjlk!

## 0.12.6 — 2026-09-28

### Patch changes

- Updated dependencies: platform@0.14.0

## 0.12.5 — 2026-09-25

### Patch changes

- Updated dependencies: bridge@0.10.0, platform@0.13.0

## 0.12.4 — 2026-09-24

### Patch changes

- Updated dependencies: platform@0.12.2

## 0.12.3 — 2026-09-24

### Patch changes

- [8e8abda](https://github.com/imjlk/mpgd-kit/commit/8e8abda65bc00e00d5cf6ad8bd810bd0655fdd03) Provide a shared AIT WebView authority fetch helper that calls injected native fetch without a dependency-object receiver, preventing valid purchase-grant requests from failing before reaching the server on iOS. — Thanks @imjlk!

## 0.12.2 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- [b4b77b3](https://github.com/imjlk/mpgd-kit/commit/b4b77b3e4ab08b330d8ca67de8b0023fe143910d) Update generated Apps in Toss projects to use the 3.5.0 WebView SDK and CLI, and remove the archived SDK 2-only `@ait-co/devtools` package from the starter target. — Thanks @imjlk!
- Updated dependencies: bridge@0.9.1, platform@0.12.1

## 0.12.1 — 2026-09-02

### Patch changes

- Updated dependencies: platform@0.12.0

## 0.12.0 — 2026-08-29

### Minor changes

- [c1c39a2](https://github.com/imjlk/mpgd-kit/commit/c1c39a2aaaefcde6a2a04e5ae06c784df07d0fce) Preserve provider-neutral platform operation codes and retry hints across adapter boundaries. Apps in Toss now uses the current anonymous identity API, coalesces concurrent identity reads for one wrapper session, retries a rejected identity read after the host recovers, and gives generated games an explicit native Sandbox wrapper command without local SDK or identity mocks. — Thanks @imjlk!

### Patch changes

- [d8f8578](https://github.com/imjlk/mpgd-kit/commit/d8f8578c9d32c5fdea63d16e7c738387fbf7b7ee) Use the documented Apps in Toss game identity API for AIT game wrappers and accept both the current OpenAPI boolean and legacy string anonymous-key verification response shapes. — Thanks @imjlk!
- Updated dependencies: platform@0.11.0

## 0.11.0 — 2026-08-27

### Minor changes

- [8948cae](https://github.com/imjlk/mpgd-kit/commit/8948caee3600be457c4662ffab9947abfdb60685) Bridge the official Apps in Toss `SafeArea.get()` and `SafeArea.subscribe()` values into shared CSS custom properties, including a transparent-navigation content boundary, and install the bridge in generated AIT wrappers. — Thanks @imjlk!

## 0.10.0 — 2026-08-26

### Changed

- [938e934](https://github.com/imjlk/mpgd-kit/commit/938e934bb53c3d18fda7c50da7e736fe6ccda351) Update generated Apps in Toss games to SDK/CLI 3.1.1 and support the SDK 3
  `navigationBar.withTitle` option in target validation. New starters hide the title and app icon when
  using transparent navigation, mirror the kit XML parser resolution policy, and document both legacy
  and replacement SDK 3 WebView origins. — Thanks @imjlk!

### Added

- [17cbec9](https://github.com/imjlk/mpgd-kit/commit/17cbec9de406aae06949b1c9df832f3ae0446b95) Add provider-neutral inline banner placements and surface lifecycle methods. Apps in Toss hosts now
  initialize and attach Toss banner ads by game-owned surface ID, report rendered/no-fill/failure
  states, and destroy active attachments on unmount. Target configuration, effective artifacts,
  starter validation, and bridge contracts understand optional `bannerAds` capability flags while
  remaining compatible with previously published adapters and target matrices. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.9.0, platform@0.10.0

## 0.9.0 — 2026-08-12

### Added

- [949dc45](https://github.com/imjlk/mpgd-kit/commit/949dc45be7ec60d4961bf26cc8cc0d0bf400c9ee) Add opt-in Apps in Toss IAP authority hooks, partner API contracts, and stable SDK 3 target support. — Thanks @imjlk!
- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.8.0, platform@0.9.0

## 0.8.0 — 2026-07-23

### Added

- [d88309c](https://github.com/imjlk/mpgd-kit/commit/d88309c46dd0df84fc33580eff643fd8c820eab4) Add server-authorized platform promotion rewards and Apps in Toss notification agreement support. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.7.0, platform@0.8.0

## 0.7.0 — 2026-07-22

### Changed

- [31655f0](https://github.com/imjlk/mpgd-kit/commit/31655f03b92ec6d59f43cde08f1d5dca5b9b9436) Migrate Apps in Toss adapters and generated game wrappers to the SDK 3 beta
  contract, including the new configuration file, package-script build flow,
  SDK 3 target metadata, and release CORS/rollback guidance. — Thanks @imjlk!

## 0.6.0 — 2026-07-20

### Added

- [c64f042](https://github.com/imjlk/mpgd-kit/commit/c64f042302af23d676dd49f4168378d053e39b19) Persist AIT sandbox storage through browser reloads while retaining an in-memory fallback when local storage is unavailable. — Thanks @imjlk!

## 0.5.2 — 2026-07-20

### Fixed

- [d40bceb](https://github.com/imjlk/mpgd-kit/commit/d40bcebe0834eba7a5b150c7e9f21f321445dd65) Treat a missing Apps in Toss operational-environment support constant as an unsupported Game
  Center capability instead of failing wrapper startup. Leaderboard submission and opening remain
  disabled until the host can verify the minimum native version. — Thanks @imjlk!

## 0.5.1 — 2026-07-20

### Fixed

- [dd7513b](https://github.com/imjlk/mpgd-kit/commit/dd7513bfb5f6a04b1d8b835b6a60a472b52db1c4) Treat missing Apps in Toss Ads 2.0 support constants as an unsupported capability instead of
  failing the game wrapper during startup. Preload and display requests remain fail-closed until
  both native full-screen ad APIs report support. — Thanks @imjlk!

## 0.5.0 — 2026-07-20

### Added

- [5c39d37](https://github.com/imjlk/mpgd-kit/commit/5c39d376db59231d35740525f5cf85e4c7dd2df0) Add a reusable Apps in Toss production host bridge backed by the official game identity,
  Storage, Ads 2.0, sharing, lifecycle, and Game Center APIs. Rewarded ads load before display and
  forward callback evidence without issuing demo grants, while commerce stays fail-closed until a
  game installs its own verified purchase flow.
  
  Allow game targets to opt out of authoritative game services. Opted-out targets disable IAP and
  ad features in their effective configuration and no longer require a production backend URL,
  while targets that enable authoritative grants keep the public HTTPS backend release gate.
  
  Scaffold each generated game with its own Apps in Toss wrapper, Granite configuration, and
  `@ait-co/devtools` workflow. The wrapper reuses the adapter's exported bundle loader while
  keeping app identity, console state, icons, and review metadata owned by the game repository.
  Expose a shared AIT ad-placement extractor for wrapper builds, preserve configuration parse
  causes, and publish package metadata that the official `.ait` dependency collector can resolve
  from both installed packages and Kit workspaces. — Thanks @imjlk!

## 0.4.4 — 2026-07-17

### Fixed

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!
- [e3fb909](https://github.com/imjlk/mpgd-kit/commit/e3fb90993fa5b33fdbd293413903d77f52686c08) Add a provider-neutral PlatformGateway capability conformance runner, keep target-configured capability reads live, and isolate bridge-owned capability snapshots before exposing them to callers. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.6.1, platform@0.7.0

## 0.4.3 — 2026-07-15

### Patch changes

- Updated dependencies: platform@0.6.0

## 0.4.2 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.6.0, platform@0.5.1

## 0.4.1 — 2026-07-13

### Patch changes

- Updated dependencies: platform@0.5.0

## 0.4.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.5.0, platform@0.4.0

## 0.3.3 — 2026-07-08

### Patch changes

- Updated dependencies: bridge@0.4.0

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: bridge@0.3.2, platform@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: bridge@0.3.1, platform@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: bridge@0.3.0, platform@0.3.0

## 0.2.0 — 2026-07-06

### Patch changes

- Updated dependencies: bridge@0.2.0, platform@0.2.0

## 0.1.0 — 2026-07-04

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!
- [91a0a30](https://github.com/imjlk/mpgd-kit/commit/91a0a30ca43b5d9541ed1a96b723a8d9dff39cc6) Add an AIT sandbox bridge and gateway fallback option so local debug builds can exercise the Apps in Toss adapter path without a production bridge. — Thanks imjlk!

### Added

- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

### Patch changes

- Updated dependencies: bridge@0.1.0, platform@0.1.0

