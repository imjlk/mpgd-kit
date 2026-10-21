# @mpgd/adapter-capacitor

## 0.12.1 — 2026-10-21

### Fixed

- [c6438977](https://github.com/imjlk/mpgd-kit/commit/c6438977f3be174f4e351597366d935c37950b90) The Capacitor notifications provider no longer treats a swipe-dismiss as an open, waits for Android notification channels before `register()` returns a token, and refuses that token when a push-only Android shell cannot create the catalog channels. Android declares the same remote purposes as the standard FCM registry, including `advertising`, so a standard pairing is not `configuration-required`. A token that arrives while Android channel creation is failing is published once that setup recovers. An iOS local reminder is confirmed by its key, topic, time, route, and topic id, not only its id, and an add still missing after that wait does not fail the schedule or restore an evicted reminder. Android `listLocal` omits a stored row only when it is in the shade, so a Doze-deferred alarm stays cancellable, including when the shade read fails. A newer token wins when overlapping permission corrections would otherwise publish an older one. A settings change that the last permission read missed is corrected on the next token. iOS provisional or ephemeral authorization, when a shell reports it, stays promptable, and Android notifications turned off in settings read as blocked. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/bridge@0.14.2, @mpgd/capacitor-game-services@0.8.1, @mpgd/game-runtime@0.7.5, @mpgd/game-services@0.27.0, @mpgd/platform@0.27.0, @mpgd/target-config@0.23.5

## 0.12.0 — 2026-10-20

### Added

- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) `@mpgd/capacitor-game-services` adds `openNotificationSettings()`, which opens this app's notification settings: `Settings.ACTION_APP_NOTIFICATION_SETTINGS` on Android 8 and later (the app details screen on Android 7) and `UIApplication.openNotificationSettingsURLString` on iOS 16 and later (the app's settings page on iOS 15). It answers `{ opened }` as soon as the screen is launched.
  
  `@mpgd/adapter-capacitor/notifications` adds `openCapacitorNotificationSettings`, the opener to pass as the notifications provider's `openSettings`: with it the provider declares `permission.settings: true`. It throws when the screen did not open; a shell built with an older plugin rejects the call, and the provider then answers `unavailable`. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/bridge@0.14.1, @mpgd/capacitor-game-services@0.8.0, @mpgd/game-runtime@0.7.4, @mpgd/game-services@0.26.0, @mpgd/platform@0.26.0, @mpgd/target-config@0.23.4

## 0.11.1 — 2026-10-19

### Patch changes

- Updated dependencies: bridge@0.14.0, capacitor-game-services@0.7.3, game-runtime@0.7.3, game-services@0.25.1, platform@0.25.0, target-config@0.23.3

## 0.11.0 — 2026-10-19

### Added

- [b0fb0a5e](https://github.com/imjlk/mpgd-kit/commit/b0fb0a5efc861f0c8e17bf650acd1d00d50c23c7) Add the notifications v2 provider for Android and iOS as `@mpgd/adapter-capacitor/notifications`. `@capacitor-firebase/messaging` and `@capacitor/local-notifications` 8.x are optional peers that only this subpath loads, dynamically, and the provider fails closed for whichever the native shell lacks; a push-only shell whose catalog maps an advertising topic is `configuration-required`, because the opt-out action needs the local plugin. It reads the app-scope OS permission (OS `denied` reads `blocked`; `promptLimit` 2 on Android, 1 on iOS), registers FCM tokens (installation-id addresses are reserved), schedules inexact local reminders on per-purpose Android channels (at most 64 pending on iOS, keeping the nearest) without ever letting the plugin prompt, registers the advertising opt-out action, buffers opens until the first subscriber, and resolves `openSettings` once the player is back from the settings screen, or after a timeout.

  Register it with `createCapacitorNotificationServiceProvider` (or `createNotificationServiceProvider`): the gateway then exposes `notificationsV2` over its validated in-process bridge, pauses the game under the permission dialog and the settings screen, serves the v1 `notifications` adapter from the same provider, and reports the `notifications` capability block with `providerAvailability.pushNotifications` equal to its availability. A v1 `pushNotifications` provider cannot be registered next to a notifications v2 service. — Thanks @imjlk!

### Changed

- [b0fb0a5e](https://github.com/imjlk/mpgd-kit/commit/b0fb0a5efc861f0c8e17bf650acd1d00d50c23c7) `createCapacitorPlatformGateway` drops any `notifications` block the native base answer sends. The block now comes only from a registered notifications v2 service. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.13.2, capacitor-game-services@0.7.2, game-runtime@0.7.2, game-services@0.25.0, platform@0.24.0, target-config@0.23.2

## 0.10.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.13.1, capacitor-game-services@0.7.1, game-runtime@0.7.1, game-services@0.24.1, platform@0.23.1, target-config@0.23.1

## 0.10.0 — 2026-10-15

### Minor changes

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
- [0234f853](https://github.com/imjlk/mpgd-kit/commit/0234f853cffff19e181587cef79fd0465144ed61) Game links a native app opens are checked with the shared route rule before
  any router sees them.
  
  - `NativeOpenUrlEvent` gains an optional `route`: for a game link, the path,
    query, and fragment of its URL, normalized with `normalizeRootRelativeRoute`
    from `@mpgd/platform/routes`. The URL's host is not part of it
    (`mygame://level/3` gives `/3`). The `LifecycleAdapter.onGameUrlOpen` and
    `NativeOpenUrlEvent` docs say a router that builds its route from anything
    else in the URL, such as a custom-scheme host, must check it with
    `normalizeRootRelativeRoute`.
  - Query-only or fragment-only hierarchical links preserve a root route:
    `mygame://game?entry=daily` gives `/?entry=daily` and `mygame://game#top`
    gives `/#top`.
  - The Capacitor adapter discards a game link, cold or warm, whose path that
    rule refuses, such as `mygame://game//evil.example/x` or
    `https://game.example/%2F%2Fevil.example/x`. It also discards one with a
    control character or one that does not parse as a URL. A delivered game link
    carries its `route` (`/daily` for `mygame://game/daily`). A link with no path
    to check, such as `mygame://daily`, is delivered without one, and OAuth
    redirects are unchanged. — Thanks @imjlk!
- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: Commerce v2, PR C4: the v1 commerce surface is removed from the
  Capacitor adapter.
  
  - Removed the v1 gateway `commerce` object (`getProducts`, `purchase`,
    `restore`, `getEntitlements`) and the four `commerce.getProducts`,
    `commerce.purchase`, `commerce.restore`, `commerce.getEntitlements` bridge
    methods, including their provider-registry routing, response validation, and
    external-activity hold. `createCommerceProviderBridge` no longer serves them
    through `toCommerceAdapter`: a v1 method answers `UNSUPPORTED_METHOD` (or goes
    to the `fallback` bridge). The `productType` parameter of
    `assertMethodReady` and the `NATIVE_PROVIDER_PRODUCT_UNKNOWN` and
    `NATIVE_PROVIDER_PRODUCT_TYPE_REQUIRED` errors are gone with the
    product-type routing.
  - `gateway.commerceV2` is renamed `gateway.commerce` and is the bridge commerce
    provider (`CommerceProvider`); the property is omitted when no commerce
    provider is registered.
  - `getCapabilities()` no longer reports `nativeIap` or `subscriptionIap`, and
    strips either key when a native shell still sends it. `commerce` is always
    present and fresh on every read: the registered provider's validated block,
    the degraded block (`temporarily-unavailable`) when its bounded read stalls or
    is invalid, or `createUnsupportedCommerceCapabilities()` without a provider
    (a missing or invalid native `commerce` answer is replaced).
  - `CapacitorServiceProvider.features` lists non-commerce features only
    (`PlatformProviderFeature` no longer contains `nativeIap` or
    `subscriptionIap`). A provider with `commerce` serves the six
    `commerce.v2.*` methods, may declare empty `features` and `methods`, and must
    still have a `subscribe` bridge. `createCommerceServiceProvider({ id,
    commerce })` drops its `features` input. `CapacitorProviderCapabilitySnapshot.commerce`
    is no longer optional.
  - Removed `CapacitorCommerceFeature` and `deriveCommerceFeatureStates`.
    `createDegradedCommerceCapabilities` stays.
  - Removed the deprecated `@mpgd/adapter-capacitor/app-store-server` subpath; use
    `createAppleSignedTransactionVerifier` from
    `@mpgd/game-services/app-store-server`. — Thanks @imjlk!

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
- Updated dependencies: bridge@0.13.0, capacitor-game-services@0.7.0, game-runtime@0.7.0, game-services@0.24.0, platform@0.23.0, target-config@0.23.0

## 0.9.3 — 2026-10-12

### Patch changes

- Updated dependencies: game-runtime@0.6.6, game-services@0.23.0

## 0.9.2 — 2026-10-12

### Patch changes

- Updated dependencies: bridge@0.12.3, capacitor-game-services@0.6.5, game-runtime@0.6.5, game-services@0.22.0, platform@0.22.0, target-config@0.22.1

## 0.9.1 — 2026-10-12

### Patch changes

- Updated dependencies: bridge@0.12.2, capacitor-game-services@0.6.4, game-runtime@0.6.4, game-services@0.21.1, platform@0.21.0, target-config@0.22.0

## 0.9.0 — 2026-10-12

### Minor changes

- [b9520179](https://github.com/imjlk/mpgd-kit/commit/b952017944bc6f1978fb922be405d148bf3175c0) Commerce v2, PR B1: the `StoreSdk` provider and registry wiring in
  `@mpgd/adapter-capacitor`, and the transitional `commerceV2` gateway field in
  `@mpgd/platform`.
  
  `@mpgd/adapter-capacitor` adds `StoreSdk`, the in-process surface a store
  plugin exposes (`fetchProducts`, `requestPurchase`, `getAvailablePurchases`,
  optional `finishTransaction`, `restorePurchases`, and `getAvailability`,
  `addListener`, and a static `capabilities` declaration), with its event,
  product, purchase, and error types, `defaultStoreSdkErrorCodeMap`, and
  `normalizeStoreSdkError`. `createStoreCommerceProvider({ sdk, products,
  evidenceSchema, evidencePayload?, accountBinding?, capabilities?, authority,
  mapError? })` returns a `CommerceProvider` from `@mpgd/platform/commerce` that
  maps logical ids to store SKUs, fails closed before the store UI opens, builds
  purchases with the store token and evidence envelope, buffers events until the
  first subscriber, composes fresh capabilities on every read, validates every
  SDK answer, and normalizes every SDK failure into a `CommerceError` with the
  store code kept; it never grants and never sets `settlement`. The provider
  registry accepts a `CapacitorServiceProvider` with a `commerce` field
  (`createCommerceServiceProvider` builds one): the six `commerce.v2.*` bridge
  methods are served through `createCommerceProviderBridge` with the A2 payload
  and result asserts and the `{ protocol: 'mpgd.commerce.v2', sequence, event }`
  event envelope, the four v1 `commerce.*` methods through `toCommerceAdapter`,
  and a provider may not declare both. `createCapacitorPlatformGateway` exposes
  the registered provider as `gateway.commerceV2` (through the validated bridge
  path, with `createBridgeCommerceProvider`) and adds the `commerce` capability
  block from which `nativeIap` and `subscriptionIap` are derived. The
  conformance test runs every store vector against a fake `StoreSdk` directly
  and through the gateway bridge path. Without a v2 provider nothing changes.
  
  Two provider rules follow the RFC "Errors" section: a store failure that
  normalizes to `OUTCOME_UNKNOWN` or `ALREADY_OWNED` answers `launched` (the
  attempt stays recoverable; `recoverableErrorCodes`) and such `purchaseError`
  events are not forwarded, and a `lifecycle.restore` override without
  `sdk.restorePurchases` is rejected at construction. The gateway reads the
  commerce block through the registry's bounded `getCapabilitySnapshot()` (a
  stalled or invalid provider yields `createDegradedCommerceCapabilities()`
  instead of a rejected read) and keeps a `launched` purchase's external
  activity open until the product's event, `launchedPurchaseActivityTimeoutMs`,
  or dispose.
  
  `@mpgd/platform` adds the optional `PlatformGateway.commerceV2?:
  CommerceProvider` field, transitional until C4 removes the v1 adapter. The
  client contract types (`StoreProduct`, `StorePurchase`, `CommerceProvider`,
  and the rest of the RFC "Client contract") now live in the typia-free
  `commerce-contract` module and are re-exported unchanged by
  `@mpgd/platform/commerce`; validators and the committed JSON Schemas are
  identical. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.12.1, capacitor-game-services@0.6.3, game-runtime@0.6.3, game-services@0.21.0, platform@0.20.0, target-config@0.21.3

## 0.8.0 — 2026-10-11

### Minor changes

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

### Patch changes

- Updated dependencies: bridge@0.12.0, capacitor-game-services@0.6.2, game-runtime@0.6.2, game-services@0.20.0, platform@0.19.0, target-config@0.21.2

## 0.7.5 — 2026-10-11

### Patch changes

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
- Updated dependencies: game-runtime@0.6.1, game-services@0.19.1, platform@0.18.0, target-config@0.21.1

## 0.7.4 — 2026-10-10

### Patch changes

- Updated dependencies: game-runtime@0.6.0, target-config@0.21.0

## 0.7.3 — 2026-10-10

### Patch changes

- Updated dependencies: target-config@0.20.0

## 0.7.2 — 2026-10-09

### Patch changes

- Updated dependencies: game-runtime@0.5.0, game-services@0.19.0, platform@0.17.0, target-config@0.19.0

## 0.7.1 — 2026-10-09

### Patch changes

- Updated dependencies: game-runtime@0.4.0, game-services@0.18.1, platform@0.16.0, target-config@0.18.0

## 0.7.0 — 2026-10-09

### Added

- [f3133fdf](https://github.com/imjlk/mpgd-kit/commit/f3133fdf5a628cae49296ed66072cd8c4e18c9e2) Expose the AdMob rewarded provider's versioned advertising surface through the Capacitor gateway. Keep native reward eligibility separate from physical closure, retain terminal observers after caller timeout, preserve original SSV operation bindings, and distinguish pre-display load failure from uncertain open UI. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.11.0, capacitor-game-services@0.6.1, game-runtime@0.3.0, game-services@0.18.0, platform@0.15.0, target-config@0.17.1

## 0.6.2 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.2

## 0.6.1 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.1

## 0.6.0 — 2026-09-28

### Minor changes

- [3f36bc6b](https://github.com/imjlk/mpgd-kit/commit/3f36bc6b5269908681405de6567d63fadadd9653) Add an opt-in AdMob rewarded-ad provider with explicit UMP consent and per-operation server-side verification binding. Route provisional SDK reward evidence to the authoritative game-services claim without setting the platform grant flag. — Thanks @imjlk!
- [bdc67369](https://github.com/imjlk/mpgd-kit/commit/bdc6736975133c809585c31f2578f24bb0a6cba3) Add an opt-in server-only App Store signed transaction verifier backed by Apple's official library. Keep one-time purchase signatures and certificate checks outside the client gateway. — Thanks @imjlk!
- [9c3b6cc0](https://github.com/imjlk/mpgd-kit/commit/9c3b6cc0656ac7b2722cc658b585e6775e9b20b6) Add an opt-in durable monetization operation journal and explicit pending purchase and rewarded-ad outcomes, so games can reconcile server grants and provider finalization without replaying purchase or ad UI. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.17.0, platform@0.14.0, target-config@0.17.0

## 0.5.0 — 2026-09-25

### Minor changes

- [bd7d0125](https://github.com/imjlk/mpgd-kit/commit/bd7d0125fc8201e17f92988c4ad177563e004175) Connect Capacitor app state, Android back navigation, and classified cold/warm
  URL entry to the platform lifecycle contract. Keep OAuth redirects separate
  from game links, own and dispose only registered listeners, and hold game
  execution while optional external provider UI is still active. Include the
  App plugin in generated native projects. — Thanks @imjlk!
- [f6e47baa](https://github.com/imjlk/mpgd-kit/commit/f6e47baa9c84aee3b3ea67bdba192bbeae2ba4af) Add optional Capacitor provider composition with per-method bridge validation and
  fail-closed readiness reporting. Distinguish uninstalled, unconfigured,
  action-required, transient, and available features without changing existing
  purchase result states. Expose subscription and native/remote leaderboard
  availability separately while preserving legacy target configuration defaults.
  Fix the base plugin's ESM-relative export so the published tarball can be
  imported by Node-based consumers and native build tooling.
  Keep generated starter target-availability checks aligned with the new readiness states. — Thanks @imjlk!
- [7a27b7f8](https://github.com/imjlk/mpgd-kit/commit/7a27b7f8b033ca987eefe859a702d0c08eba0800) Expose an optional Capacitor viewport state and change subscription with
  separate safe-area, system-bar, keyboard, and named occupied-surface geometry.
  Resolve one usable CSS-pixel rectangle without double-counting overlapping
  native or CSS insets, and convert provider-owned physical-pixel surfaces at
  the adapter boundary.
  Align newly scaffolded games with the SystemBars CSS safe-area fallback. — Thanks @imjlk!
- [f23df41f](https://github.com/imjlk/mpgd-kit/commit/f23df41fd114b81096450a579f9a2aaead12bd09) Add a scoped Capacitor native JSON HTTP transport for HTTPS GET and POST
  requests, including explicit origin selection, redirect blocking, bounded
  timeouts and JS-side size checks, and public Game Services runtime composition. — Thanks @imjlk!
- [b7ffbf9d](https://github.com/imjlk/mpgd-kit/commit/b7ffbf9d8baedbae894063e89a07509fc96dfd46) Add a separate fail-closed credential storage contract to the Capacitor base
  bridge. Android uses a Keystore-held AES-GCM key with no-backup ciphertext
  files, and iOS uses device-only
  Keychain items; neither falls back to ordinary game JSON storage. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.10.0, capacitor-game-services@0.6.0, game-services@0.16.0, platform@0.13.0, target-config@0.16.0

## 0.4.12 — 2026-09-24

### Patch changes

- [52026ee](https://github.com/imjlk/mpgd-kit/commit/52026eed535a6414a53f88fa8f5db496beac3e68) Use the host's Capacitor core as a peer dependency throughout the native plugin and adapter, and include it in generated game dependencies. Allow compatible Capacitor 8 Swift Package Manager versions instead of pinning the native plugin to 8.5.1. The reference mobile shell now resolves Capacitor 8.5.2 consistently across npm, Android, and iOS. — Thanks @imjlk!
- [a3c5b76](https://github.com/imjlk/mpgd-kit/commit/a3c5b763ddcc5aef76bd98d9080c33f26390a2ff) Stop returning demo purchase, ad reward, interstitial, and leaderboard successes from the reference native plugin when no real provider is installed. Report those capabilities as unavailable on Android and iOS, reject their operations with stable non-retryable codes, and preserve bridge error codes and retry hints in the Capacitor adapter. — Thanks @imjlk!
- Updated dependencies: capacitor-game-services@0.5.4, platform@0.12.2

## 0.4.11 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.9.1, capacitor-game-services@0.5.3, platform@0.12.1

## 0.4.10 — 2026-09-03

### Patch changes

- Updated dependencies: capacitor-game-services@0.5.2

## 0.4.9 — 2026-09-02

### Patch changes

- Updated dependencies: platform@0.12.0

## 0.4.8 — 2026-08-29

### Patch changes

- Updated dependencies: platform@0.11.0

## 0.4.7 — 2026-08-26

### Patch changes

- Updated dependencies: bridge@0.9.0, capacitor-game-services@0.5.1, platform@0.10.0

## 0.4.6 — 2026-08-12

### Patch changes

- Updated dependencies: bridge@0.8.0, capacitor-game-services@0.5.0, platform@0.9.0

## 0.4.5 — 2026-07-23

### Patch changes

- Updated dependencies: bridge@0.7.0, capacitor-game-services@0.4.3, platform@0.8.0

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

- Updated dependencies: bridge@0.6.1, capacitor-game-services@0.4.2, platform@0.7.0

## 0.4.3 — 2026-07-15

### Patch changes

- Updated dependencies: platform@0.6.0

## 0.4.2 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.6.0, capacitor-game-services@0.4.1, platform@0.5.1

## 0.4.1 — 2026-07-13

### Patch changes

- Updated dependencies: platform@0.5.0

## 0.4.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.5.0, capacitor-game-services@0.4.0, platform@0.4.0

## 0.3.3 — 2026-07-08

### Patch changes

- Updated dependencies: bridge@0.4.0, capacitor-game-services@0.3.3

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: bridge@0.3.2, capacitor-game-services@0.3.2, platform@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: bridge@0.3.1, capacitor-game-services@0.3.1, platform@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: bridge@0.3.0, capacitor-game-services@0.3.0, platform@0.3.0

## 0.2.0 — 2026-07-06

### Patch changes

- Updated dependencies: bridge@0.2.0, capacitor-game-services@0.2.0, platform@0.2.0

## 0.1.0 — 2026-07-04

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

### Patch changes

- Updated dependencies: bridge@0.1.0, capacitor-game-services@0.1.0, platform@0.1.0

