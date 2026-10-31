# @mpgd/bridge

## 0.19.1 — 2026-11-01

### Patch changes

- Updated dependencies: @mpgd/platform@0.36.0

## 0.19.0 — 2026-11-01

### Added

- [aef7e004](https://github.com/imjlk/mpgd-kit/commit/aef7e004aeae912979ae34ba56d47efbf5a26578) The shared notifications bridge handlers (`createNotificationsV2BridgeHandler`, `createNotificationsBackendBridgeHandler`) read a thrown value defensively. A thrown `Proxy` whose `getPrototypeOf` trap throws no longer rejects the request when `onError` is set: a class check that throws counts as no match. Each field of a thrown value is read once, and a field whose read throws counts as missing, so a readable notifications code and retryable flag still cross when the message getter throws, instead of falling back to a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`. A value whose `toString` throws crosses as `<method> failed: a failure that cannot be read`. An `unexpectedFailureMessage` callback that throws, or answers a value that is not a string, is reported through `onError`, and the failure crosses as `<method> failed.` with its code and retryable flag.
  
  The main entry exports the helpers it reads them with, so adapters share one implementation: `readThrownField(value, key)` (a field, or `undefined` when the read throws), `isThrownInstance(value, Class)` (`false` when the check throws), and `thrownMessage(value)` (the `message`, else the text, else `a failure that cannot be read`). None of them throws. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/platform@0.35.1

## 0.18.1 — 2026-10-30

### Patch changes

- Updated dependencies: @mpgd/platform@0.35.0

## 0.18.0 — 2026-10-29

### Added

- [b73b129d](https://github.com/imjlk/mpgd-kit/commit/b73b129d35097331dc6d8de0363191c9cf110dd2) Purchase presentation facts get their own bridge event protocol, `mpgd.commerce.presentation.v1`. `@mpgd/platform/commerce` adds `commercePresentationProtocol`, `CommercePresentationEvent`, `CommercePresentationEventEnvelope`, their typia asserts, and their JSON Schemas; `@mpgd/bridge` adds `BridgeCommercePresentationEvent` to `BridgeEvent`, `bridgeCommercePresentationEventProtocol`, and a `createBridgeEventSource` overload. It is not a `CommerceEvent` type, so a consumer built before it skips the envelopes as another protocol's.
  
  `PlatformPurchasePresentationEvent` gains an optional `reason` (`timeout`, `interrupted`, `disposed`) for a `closed` fact no native observation proved, and the `CommerceProvider.presentation` contract now states that a provider answers every `requestPurchase` with facts: `not-started` before the answer when no surface opened, otherwise `open` and exactly one `closed`.
  
  `@mpgd/platform` also exports the pure helpers a provider or a wrapper uses for these facts: `createPurchasePresentationChannel` (publishes numbered facts, isolating a failing listener), `createPurchasePresentationRelay` (relays a source's facts, drops a superseded one, numbers them again, and reports `not-started` for a purchase the wrapper answered before its source ran), and `createPurchasePresentationSequenceGuard` (bounded memory: ended keys are kept in a list of the most recent 1024). — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/platform@0.34.0

## 0.17.0 — 2026-10-28

### Changed

- [e984b9fe](https://github.com/imjlk/mpgd-kit/commit/e984b9fede2a1aabe9bb820e27debe31570fb170) oRPC moves from 2.0.0-beta.14 to exactly `2.0.0-beta.46` (`@orpc/client`, `@orpc/contract`, and `@orpc/server`, all pinned with no range). Three wire changes come with it:
  
  - **oRPC error bodies drop the `inferable` field** (oRPC 2.0.0-beta.34). A bridge client and server on different oRPC versions see each other's errors as malformed responses. The bridge client and server ship in the same Devvit app build, so the bridge carries no compatibility shim: keep `@mpgd/adapter-devvit` and the Devvit server on the same kit release. Bridge method errors and request-validation failures travel inside the bridge response envelope and are unaffected; only internal server errors (500) and oRPC transport errors (413, 400 for an undecodable body) use the oRPC error body.
  - **RPC routes accept only POST, PUT, PATCH, and DELETE.** A GET now gets the unmatched result: 404 from `createBridgeRpcFetchHandler`, `false` from `createBridgeRpcNodeHandler`. The bridge client always POSTs.
  - **`Infinity` gets its own meta marker** in the encoding.
  
  `createBridgeRpcNodeHandler`'s `maxBodySize` is now enforced by oRPC's `RequestLimitHandlerPlugin`, and oversized bodies still answer 413 `PAYLOAD_TOO_LARGE`. `BridgeRpcEndpoint` is now spelled out as the same URL-path template type that oRPC 2.0.0-beta.46 stopped exporting as `StandardUrl`.
  
  This is a minor release because the error body and GET behaviour change on the wire. — Thanks @imjlk!
- [d684308f](https://github.com/imjlk/mpgd-kit/commit/d684308f4eff54e2ea772bed8dcda4b1ea528630) The runtime `typia` dependency moves from 13.0.2 to 15.2.1, and the shipped validators are rebuilt with typia 15 through ttsc 0.34.2. A game that runs its own typia transform over these packages' types needs typia 15.2 or later. typia 15's `date-time` and `date` formats refuse a day the month does not have and a space for `T`, and its length tags count code points. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/platform@0.33.0

## 0.16.4 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/platform@0.32.0

## 0.16.3 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/platform@0.31.0

## 0.16.2 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/platform@0.30.0

## 0.16.1 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/platform@0.29.0

## 0.16.0 — 2026-10-25

### Added

- [dd51d8e9](https://github.com/imjlk/mpgd-kit/commit/dd51d8e9a6d994b1c2cefcd5adaf90e304953a6d) Notifications backend bridge methods: the notifications runtime's backend calls (`NotificationRuntimeBackend`) for a backend that a host serves over its own bridge, such as the Devvit server. `@mpgd/platform/notifications` adds the nine `notifications.backend.*` method shapes (`NotificationBackendBridgeMethods`, `notificationBackendBridgeMethods`), their typia validators (`assertNotificationBackendBridge*Payload` and `*Result`; the repository publishes their JSON Schemas under `docs/specs/notifications/schemas`), and `NotificationBackendReminderSetStatus`, which `NotificationRuntimeReminderSetStatus` now names. Every call but `getSession` carries `expectedPlayer`, only as a cross-check: the host acts for its own authenticated player and refuses a call for another.
  
  `@mpgd/bridge` adds the methods to `BridgeMethod` as `BridgeNotificationsBackendMethod` (`bridgeNotificationsBackendMethods`, `isBridgeNotificationsBackendMethod`), apart from the nine provider methods, and `createNotificationsBackendUnavailableBridgeError`, which answers `NOTIFICATIONS_CONFIGURATION_REQUIRED`. `@mpgd/bridge/notifications` adds `assertBridgeNotificationsBackendPayload`, `assertBridgeNotificationsBackendResult`, `notificationsBackendBridgeHostCodes`, and `createNotificationsBackendBridgeHandler`, which serves the methods from the host's backend for its own session: a request without a player answers `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with host code `NOTIFICATIONS_SIGNED_OUT`, one whose `expectedPlayer` is another player the same code with `NOTIFICATIONS_SESSION_CHANGED`, and a backend failure that is not a notifications failure crosses with a fixed message.
  
  Changed for outside callers:
  
  - `@mpgd/bridge`: `BridgeMethod` gains the nine `notifications.backend.*` methods. A `switch` over `BridgeMethod` that names every member (an exhaustive check with `never`) no longer compiles until it handles them or has a default; a `Record<BridgeMethod, …>` needs entries for them.
  - `@mpgd/platform/notifications-conformance`: `NotificationConformanceBackend.authenticate` now returns `NotificationConformanceSession | Promise<NotificationConformanceSession>`, and the runner awaits it. Code that calls `authenticate` on a `NotificationConformanceBackend` and uses the result directly now awaits it. Implementations that answer synchronously still compile, and `NotificationConformanceFakeBackend.authenticate` still answers synchronously. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/platform@0.28.0

## 0.15.0 — 2026-10-21

### Added

- [b918119c](https://github.com/imjlk/mpgd-kit/commit/b918119c26437b13d6ca4a7e57a3104b81fe0687) `@mpgd/bridge/notifications` adds `createNotificationsV2BridgeHandler({ provider })`, the host side of the nine `notifications.v2.*` bridge methods that the Apps in Toss host, the Capacitor in-process bridge, and the Devvit server bridge now share. It checks each payload (`NOTIFICATIONS_INVALID_INPUT`) and answer (`NOTIFICATIONS_CONFIGURATION_REQUIRED`), answers `NOTIFICATIONS_UNSUPPORTED` for a method the provider lacks (`openSettings` answers `unavailable`, and `register` answers no address under `registerOptional`), maps failures fail-closed (reading errors by shape too, so a provider built against another copy of `@mpgd/platform` keeps its codes) with a readable host code named in the message, which `readBridgeNotificationsHostCode` reads back, and numbers the provider's events per handler from 0. `label`, `unexpectedFailureMessage`, and `onError` keep host-specific wording and server-side logging. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/platform@0.27.2

## 0.14.3 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/platform@0.27.1

## 0.14.2 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/platform@0.27.0

## 0.14.1 — 2026-10-20

### Patch changes

- Updated dependencies: @mpgd/platform@0.26.0

## 0.14.0 — 2026-10-19

### Minor changes

- [96d8add4](https://github.com/imjlk/mpgd-kit/commit/96d8add43a4eff1f790b4cc8514a8839f7f7608c) Add optional recovery-only promotion calls that read persisted or authority-confirmed receipts without authorizing or starting a provider payment. Preserve pending markers even when the resolver permits a retry; a fresh explicit grant remains separate. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.25.0

## 0.13.2 — 2026-10-19

### Patch changes

- Updated dependencies: platform@0.24.0

## 0.13.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.23.1

## 0.13.0 — 2026-10-15

### Minor changes

- [d8486b02](https://github.com/imjlk/mpgd-kit/commit/d8486b0279dd6b1e6d83e4bef192e62413aa1636) Notifications v2, PR N3: the bridge methods, the event union, and the
  fail-closed answer.
  
  - `BridgeMethod` gains the nine `notifications.v2.*` methods
    (`getCapabilities`, `getPermission`, `requestPermission`,
    `revokePermission`, `register`, `scheduleLocal`, `cancelLocal`, `listLocal`,
    and `openSettings`), exported as `bridgeNotificationsV2Methods` and kept
    equal to `notificationBridgeMethods` from `@mpgd/platform/notifications`.
    `isBridgeNotificationsV2Method` tells them apart.
  - The new `@mpgd/bridge/notifications` entry exports
    `assertBridgeNotificationsV2Payload(method, payload)` and
    `assertBridgeNotificationsV2Result(method, data)`, which validate a
    method's payload and answer with the `@mpgd/platform/notifications`
    validators, so unknown keys, timestamps without an offset, and routes that
    are not root-relative are rejected. It also exports the types that name the
    methods and shapes, `BridgeNotificationsV2Method`,
    `BridgeNotificationsV2Payload`, and `BridgeNotificationsV2Result`, which the
    main entry exports too. The main entry loads no notifications code, so
    bundles that only use the bridge do not grow.
  - `createNotificationsV2UnavailableBridgeError` answers a notifications v2
    request with `NOTIFICATIONS_V2_UNAVAILABLE`
    (`notificationsV2UnavailableBridgeErrorCode`), which is not retryable. The
    Cloudflare Pages host answers every notifications v2 method with it.
  - `BridgeEvent` is now a union discriminated by `protocol`: the commerce v2
    envelope (`BridgeCommerceEvent`) and
    `{ protocol: 'mpgd.notifications.v2', sequence, event }`
    (`BridgeNotificationsEvent`). Code that read `event.event` as a commerce
    event now narrows on `event.protocol` first, or types a commerce-only
    channel with `BridgeCommerceEvent`. `bridgeCommerceEventProtocol` and
    `bridgeNotificationsEventProtocol` name the protocols; `bridgeEventProtocol`
    stays the commerce protocol and is deprecated.
  - `assertBridgeEvent` follows the union: it returns `BridgeEvent` rather than
    the commerce envelope and accepts notifications envelopes. Because it
    validates the union, a rejected input can report a different `path` and
    `expected` than before; a caller that wants the commerce envelope and its
    errors validates with `assertCommerceEventEnvelope` from
    `@mpgd/platform/commerce`. An `endpoint-changed` registration must name a
    `timeZone` that `Intl` knows, as a `register` answer must. It builds its
    validator on the first call, so a bundle that never validates a bridge
    event leaves the validator out.
  - `createBridgeEventSource(protocol, stream)` is the host side of one
    protocol's events for one bridge session. It subscribes to the stream for
    the first listener, so events a provider buffered reach that listener, and
    numbers the events from 0 for the session. An event emitted during a
    delivery is delivered after it. A listener that throws, or returns a
    promise that rejects, is reported with `console.warn` and does not stop the
    others. The last listener leaving during a delivery detaches the stream once
    the delivery ends, reporting a failed detach the same way. If the stream's
    `subscribe` throws, every subscription made during that call is dropped;
    such a `subscribe` must not keep the listener. Its overloads pair each
    protocol with its own events. `BridgeEventStream` types the stream,
    `BridgeEventProtocol` names the protocols, and `BridgeEventOf<protocol>`
    names a protocol's events. — Thanks @imjlk!
- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: commerce v2, PR C4 removes the commerce v1 bridge methods. The six
  `commerce.v2.*` methods (`bridgeCommerceV2Methods`) are the whole commerce
  bridge.
  
  - `BridgeMethod` no longer contains `commerce.getProducts`,
    `commerce.purchase`, `commerce.restore`, or `commerce.getEntitlements`:
    `assertBridgeRequest` rejects them, `isBridgeCommerceV2Method` is `false` for
    them, and a transport that dispatches on the method answers
    `UNSUPPORTED_METHOD`. Use `commerce.v2.fetchProducts`,
    `commerce.v2.requestPurchase`, `commerce.v2.restorePurchases`, and
    `commerce.v2.getAvailablePurchases`; entitlements come from the backend
    ledger, not from a bridge method.
  - The Cloudflare Pages host bridge (`@mpgd/bridge/cloudflare-pages`) stops
    answering the four v1 methods. Its `runtime.getCapabilities` no longer sends
    `nativeIap` and now carries `commerce: createUnsupportedCommerceCapabilities()`,
    since the Pages host sells nothing; its `commerce.v2.*` answers stay the
    non-retryable `COMMERCE_V2_UNAVAILABLE` error.
  - The `commerce.v2.*` wire names, the `mpgd.commerce.v2` protocol constant,
    `BridgeCommerceV2Method`, `isBridgeCommerceV2Method`,
    `createCommerceV2UnavailableBridgeError`, and the
    `COMMERCE_V2_UNAVAILABLE` code are unchanged: they name the protocol version,
    not the removed gateway property. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.23.0

## 0.12.3 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.22.0

## 0.12.2 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.21.0

## 0.12.1 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.20.0

## 0.12.0 — 2026-10-11

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

- Updated dependencies: platform@0.19.0

## 0.11.0 — 2026-10-09

### Added

- [3e560af5](https://github.com/imjlk/mpgd-kit/commit/3e560af5b3f9e15ee561a51682828337fd614e22) Expose Apps in Toss advertising through a versioned proxy/host bridge with SDK-scoped native observations. Separate reward eligibility from closure and ledger grants, retain late callbacks after deadlines, coordinate the shared native SDK, and preserve background lifecycle ownership. — Thanks @imjlk!

## 0.10.0 — 2026-09-25

### Minor changes

- [b7ffbf9d](https://github.com/imjlk/mpgd-kit/commit/b7ffbf9d8baedbae894063e89a07509fc96dfd46) Add a separate fail-closed credential storage contract to the Capacitor base
  bridge. Android uses a Keystore-held AES-GCM key with no-backup ciphertext
  files, and iOS uses device-only
  Keychain items; neither falls back to ordinary game JSON storage. — Thanks @imjlk!

## 0.9.1 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

## 0.9.0 — 2026-08-26

### Added

- [17cbec9](https://github.com/imjlk/mpgd-kit/commit/17cbec9de406aae06949b1c9df832f3ae0446b95) Add provider-neutral inline banner placements and surface lifecycle methods. Apps in Toss hosts now
  initialize and attach Toss banner ads by game-owned surface ID, report rendered/no-fill/failure
  states, and destroy active attachments on unmount. Target configuration, effective artifacts,
  starter validation, and bridge contracts understand optional `bannerAds` capability flags while
  remaining compatible with previously published adapters and target matrices. — Thanks @imjlk!

## 0.8.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

## 0.7.0 — 2026-07-23

### Added

- [d88309c](https://github.com/imjlk/mpgd-kit/commit/d88309c46dd0df84fc33580eff643fd8c820eab4) Add server-authorized platform promotion rewards and Apps in Toss notification agreement support. — Thanks @imjlk!

## 0.6.1 — 2026-07-17

### Fixed

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!

## 0.6.0 — 2026-07-14

### Added

- [2f06373](https://github.com/imjlk/mpgd-kit/commit/2f063737d518a19d93de0781bf44582c0a0bc78b) Add an opt-in official Devvit Vite build strategy for generated Phaser games,
  upgrade Devvit packages to 0.13.7, expose a direct oRPC Node HTTP bridge
  adapter, and remove the generated target's Express-based request conversion. — Thanks @imjlk!

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

## 0.5.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

## 0.4.0 — 2026-07-08

### Added

- [11e5573](https://github.com/imjlk/mpgd-kit/commit/11e5573be744d61348cb0e502fc60e26bf34eec8) Add a Cloudflare Pages advanced-mode host helper for bridge JSON, bridge oRPC,
  optional game-services service binding proxy, and static asset fallback, plus
  generated Phaser game legal/support/terms HTML sources with `mpgd legal
  build/check` and a TypeScript Pages host that bundles to `_worker.js`. — Thanks @imjlk!

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

## 0.2.0 — 2026-07-06

### Added

- [02d8cfd](https://github.com/imjlk/mpgd-kit/commit/02d8cfd5e7669e29f7c99754fb98773aa807bc4c) Add Devvit oRPC bridge transport. — Thanks @imjlk!

## 0.1.0 — 2026-07-04

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

