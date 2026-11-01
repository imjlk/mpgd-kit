# @mpgd/adapter-browser

## 0.12.6 — 2026-11-01

### Patch changes

- Updated dependencies: @mpgd/platform@0.36.0

## 0.12.5 — 2026-11-01

### Patch changes

- Updated dependencies: @mpgd/platform@0.35.1

## 0.12.4 — 2026-10-30

### Patch changes

- Updated dependencies: @mpgd/platform@0.35.0

## 0.12.3 — 2026-10-29

### Patch changes

- Updated dependencies: @mpgd/platform@0.34.0

## 0.12.2 — 2026-10-28

### Patch changes

- Updated dependencies: @mpgd/platform@0.33.0

## 0.12.1 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/platform@0.32.0

## 0.12.0 — 2026-10-26

### Minor changes

- [1d2d74e0](https://github.com/imjlk/mpgd-kit/commit/1d2d74e058e6fae18e7d5b4d1850b29a94c6165e) Optional review providers distinguish opaque native requests from explicit store-page navigation. Add an opt-in target integration, persisted visit/play/cooldown policy, AIT Review.request, Capawesome AppReview for explicitly selected mobile stores, and Microsoft/registered ONE store or Verse8 listing helpers. Unsupported hosts have no prompt or storage activity; no outcome claims that a review was displayed or submitted. Import review adapters by subpath so unused SDKs stay out of browser and inline bundles. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/platform@0.31.0

## 0.11.10 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/platform@0.30.0

## 0.11.9 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/platform@0.29.0

## 0.11.8 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/platform@0.28.0

## 0.11.7 — 2026-10-21

### Patch changes

- [3f519a74](https://github.com/imjlk/mpgd-kit/commit/3f519a74a3eaf7aeec7a35d208ed951ff61ff8df) Echo a coordinator's purchase presentation attempt on ONE play checkout facts. Ordinary checkouts are unchanged, and the echoed fact does not grant. — Thanks @imjlk!
- Updated dependencies: @mpgd/platform@0.27.2

## 0.11.6 — 2026-10-21

### Fixed

- [7f75e0a1](https://github.com/imjlk/mpgd-kit/commit/7f75e0a189cb00072cb9d87f8c654f8c784b07af) Browser launch and inbound-share parameters now use the same caps as the Apps in Toss host: nested `queryParams` longer than 4096 characters are ignored, at most 32 nested entries are read, and each forwarded key and value is limited to 256 characters. `puzzleId` and `challengeToken` that contain an ASCII control character are dropped instead of being copied into launch or inbound-share state. Direct search parameters still win over nested ones.
  
  `leaderboard.submitScore()` returns `{ submitted: false }`. The browser gateway does not install a native leaderboard (`nativeLeaderboard` is false), matching WeChat, Verse8, ONE play, and CrazyGames. Callers that treated `submitted: true` as proof a score was sent, including a game-services record on a browser or Microsoft Store gateway that still uses this leaderboard, no longer record a score that was never submitted. — Thanks @imjlk!

### Patch changes

- [1bdf381a](https://github.com/imjlk/mpgd-kit/commit/1bdf381a8ffd165dd138f3d93af869ce385eeb84) Stop a failed or hung ONE play or CrazyGames ad from wedging fullscreen occupancy and checkout for the page lifetime.
  
  ONE play `showRewardedAsync` and `showInterstitialAsync` are bounded, including a synchronous throw from the show call. A rejection before an ad pause (`reason: "ad"`) releases the shared owner and does not grant; a background or payment pause is not evidence the ad opened. A show that never settles resolves pending with `rewardGranted: false`. If that call later settles, or the recovery bound expires with no terminal SDK result, the provider emits `closed` or `failed` so the runtime can release its fullscreen lease, still without `reward-earned` or a client grant. Dispose clears only the occupancy this gateway created, so another live gateway sharing the SDK keeps its ad or checkout lock. A checkout waiting on intent issuance does not open a payment sheet after that release. A settled unknown SDK reason still quarantines until a terminal result, the recovery bound, or dispose. A back handler that returns `true` or a thenable, including a Promise from another frame, consumes the synchronous ONE SDK back event so the host does not exit before the decision.
  
  CrazyGames `requestAd` is bounded the same way as the AIT and Verse8 ad providers. A missed `adFinished` / `adError` resolves pending and quarantines as action-required until a later terminal callback. A synchronous throw does not guess that the ad closed. A proven not-started `adError` still releases immediately. Timeouts never grant. — Thanks @imjlk!
- Updated dependencies: @mpgd/platform@0.27.1

## 0.11.5 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/platform@0.27.0

## 0.11.4 — 2026-10-20

### Patch changes

- Updated dependencies: @mpgd/platform@0.26.0

## 0.11.3 — 2026-10-19

### Patch changes

- Updated dependencies: platform@0.25.0

## 0.11.2 — 2026-10-19

### Patch changes

- Updated dependencies: platform@0.24.0

## 0.11.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.23.1

## 0.11.0 — 2026-10-15

### Minor changes

- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: commerce v2, PR C4: the browser adapter drops the v1 commerce
  surface and the boolean capabilities. Every gateway now exposes at most one
  commerce surface, `gateway.commerce`, a commerce v2 `CommerceProvider`; a
  gateway that sells nothing omits it and reports the unsupported commerce block.
  
  Removed, with the replacement:
  
  - The v1 `CommerceAdapter` on every gateway. `createBrowserPlatformGateway()`
    (and the CrazyGames gateway) now has no `commerce` provider and reports
    `createUnsupportedCommerceCapabilities()` (`commerce.availability:
    'unsupported'`) instead of a failing `getProducts` / `purchase` stub.
    `createBrowserPlatformGateway({ mockCommerce: true })` keeps its documented
    invariant (no code path can grant) but is now a small commerce v2 provider:
    store id `browser-mock` (`browserMockCommerceStoreId`), one consumable
    `COINS_100`, `finish: 'none'`, `authority.evidence: 'client-token'`; its
    `requestPurchase` answers `purchased` with a mock `transactionId` and `token`
    and `mpgd.browser.mock-purchase.v1` evidence, with no `settlement`.
  - `createMicrosoftStoreCommerceAdapter`, `withMicrosoftStoreCommerceAdapter`,
    `MicrosoftStoreCommerceAdapter`, and `CreateMicrosoftStoreCommerceAdapterInput`
    from `@mpgd/adapter-browser/microsoft-store`. Use
    `createMicrosoftStoreCommerceProvider` and
    `withMicrosoftStoreCommerceProvider` (same input; the wrapper now sets
    `gateway.commerce` and the `commerce` capability block only, with no
    `nativeIap` or `subscriptionIap`) and
    `CreateMicrosoftStoreCommerceProviderInput`.
    `MicrosoftStorePurchaseAuthority.getEntitlements()` is removed: entitlements
    come from the backend ledger, so delete that method from your authority.
    New: `createMicrosoftStoreCommerceCapabilities(availability)`, the pure
    capability declaration the provider returns.
  - `createOnePlayCommerceAdapter` from `@mpgd/adapter-browser/oneplay`. Use
    `createOnePlayCommerceProvider({ sdk?, products?, server? })` (store id
    `oneplay`: `purchased` with `oneplay.managed-purchase.v1` evidence, `cancelled`
    for a user cancel, `failed` for the SDK's hard failures, `launched` for an
    unknown, transport, or timeout outcome; `presentation` facts and the
    single-flight rule are unchanged). `OnePlayCommerceServerPort.getEntitlements`
    and `restore` are removed: read the backend ledger, and keep server-record
    restore a game-owned backend concern. `createOnePlayPlatformGateway` always
    installs the provider as `gateway.commerce`. New:
    `createOnePlayCommerceCapabilities(input)`, `onePlayCommerceStoreId`,
    `onePlayManagedPurchaseEvidenceSchema`, and `OnePlayCommerceProvider`.
  - The gateways no longer report `nativeIap`, `subscriptionIap`, or
    `providerAvailability.nativeIap`; read `capabilities.commerce`
    (`availability`, `purchase`, `lifecycle`, `authority`).
  
  See `adapters/browser/README.md` ("Migrating from v1"),
  `docs/MICROSOFT_STORE_COMMERCE.md`, and `docs/ONEPLAY.md`.
  
  ONE play retries pre-checkout network failures with the original bound identity, and already-owned responses remain open for server reconciliation while releasing the closed native surface. — Thanks @imjlk!
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
- [0234f853](https://github.com/imjlk/mpgd-kit/commit/0234f853cffff19e181587cef79fd0465144ed61) The web share clipboard fallback copies a link a paste can open. A
  root-relative share link, such as `/daily`, used to be copied as is
  (`Join me\n/daily`). It is now resolved against the explicit game page URL
  (`locationHref`) first, then `document.baseURI` or the ambient location. Without
  an HTTP(S) page to resolve it against, the share answers `unavailable`. Web Share
  still receives the normalized route unchanged. Web sharing now reads its intent
  through `withShareIntentCheck` from `@mpgd/platform/routes`, with the same rule
  as before.
  
  Clipboard bases carrying a username or password are rejected, so resolving a
  root-relative link cannot copy URL credentials into a shared link. — Thanks @imjlk!

### Patch changes

- [8de63811](https://github.com/imjlk/mpgd-kit/commit/8de6381120ab6c7393cec3d6ec65190d3b63873d) Ship reusable C# Microsoft Store native bridge sources and a public locator.
  Game-owned callbacks provide login and commerce policy; common helpers validate
  the protocol and typed results, dispatch on the window UI thread, and cancel
  queued operations and suppress stale responses after navigation or closure.
  Align native catalog display-text validation with localized joiners, emoji and
  RTL price marks while preserving strict identifiers and rejecting unsafe controls. — Thanks @imjlk!
- Updated dependencies: platform@0.23.0

## 0.10.2 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.22.0

## 0.10.1 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.21.0

## 0.10.0 — 2026-10-12

### Minor changes

- [58b313ce](https://github.com/imjlk/mpgd-kit/commit/58b313ce587ac2129a6306a17a069aae1e6cedb4) Commerce v2, PR B4: the Microsoft Store commerce provider.
  
  `@mpgd/adapter-browser/microsoft-store` adds
  `createMicrosoftStoreCommerceProvider(input)`, a `CommerceProvider` with
  `store: 'microsoft-store'` over the same Digital Goods engine as the v1
  `createMicrosoftStoreCommerceAdapter`, which keeps its behaviour and input
  unchanged. The capability block follows the RFC profile: consumable only,
  products with localized prices, `availablePurchases`, `restore`, `events`,
  `finish: 'server'` (no `finishTransaction`; the backend consume finalizer
  finishes), `pending: false` (Microsoft has no store-side pending state; scoped
  recovery records are listed as `purchased`), and `authority: { evidence:
  'adapter-settled', accountBinding: 'required' }`. `fetchProducts` maps
  `getDetails()` to `StoreProduct`; `requestPurchase` runs the
  `claimRecoveryOwnership` → Payment Request → `verifyAndGrant` flow and answers
  `purchased` with `settlement: { ledgerEntryId }` on a grant, `launched` while
  the authority answer is open or the Store has not listed the purchase,
  `cancelled` for a dismissed sheet, and `failed` with the client outcome code as
  `storeCode` (`MICROSOFT_STORE_*`, `microsoftStoreCommerceErrorCodeMap`)
  otherwise; `getAvailablePurchases` lists `listPurchases()` items plus scoped
  recovery records with `settlement` on purchases granted this session for the
  same checkout key and player scope; `restorePurchases` replays recovery without
  the v1 entitlement read and emits `purchaseUpdated` and `purchaseError` events,
  buffered before the first subscriber; a buffered settlement is delivered only
  to the player scope that restored it. A throwing availability probe degrades
  `getCapabilities` to `temporarily-unavailable` and surfaces as a retryable
  `STORE_UNAVAILABLE` from the other operations. `StorePurchase.transactionId`
  and `token` are the Digital Goods `purchaseToken`, which the server boundary
  already matches. The provider never grants: `settlement` is the authority's
  ledger pointer.
  
  `withMicrosoftStoreCommerceProvider(gateway, provider, options)` installs the
  provider as `commerceV2`, serves v1 `commerce` through `toCommerceAdapter`,
  adds the `commerce` capability block with `nativeIap`/`subscriptionIap` derived
  from it, and replaces ads with the unavailable adapter like
  `withMicrosoftStoreCommerceAdapter`. A gateway that migrates to this wiring
  sees the wrapper's v1 surface instead of the v1 adapter's: `getEntitlements()`
  and `restore().restoredEntitlements` are empty (entitlements come from the
  ledger), `restore()` returns `settledPurchases` and rejects when Digital Goods
  fails instead of resolving empty, and a checkout whose Store identity is bound
  to another player is `failed` (`ACCOUNT_BINDING_REQUIRED`) instead of
  `pending`. `withMicrosoftStoreCommerceAdapter` and the v1 adapter are
  unchanged. The `adapter-settled` conformance vector passes directly and through
  the gateway.
  
  `@mpgd/game-services`: the client grants a completed purchase with
  `authoritativeGrant` without a second verification when the gateway's
  `commerceV2` provider declares `authority.evidence: 'adapter-settled'`
  (`findAdapterSettledGrant`; the declaration is read once per provider instance
  and cached, a failed read is retried on the next checkout), and the ledger
  entry is taken from `authoritativeGrant.ledgerEntryId`. Gateways without
  `commerceV2` keep the target-name rule;
  `isAuthoritativeMicrosoftStoreCompletion` is deprecated for removal in C4. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.20.0

## 0.9.2 — 2026-10-11

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
- Updated dependencies: platform@0.19.0

## 0.9.1 — 2026-10-11

### Patch changes

- Updated dependencies: platform@0.18.0

## 0.9.0 — 2026-10-09

### Added

- [8cd3e3f8](https://github.com/imjlk/mpgd-kit/commit/8cd3e3f81d49235bd537a02ac97ac157f6b40f5b) Add ONE play rewarded advertisements with authenticated server request issuance, raw-byte HMAC SSV verification, durable callback bindings and backend ledger recovery. Keep client callbacks as correlation evidence and quarantine uncertain native presentations. Allow explicit same-format physical placement sharing for selected catalog targets. — Thanks @imjlk!
- [537c6168](https://github.com/imjlk/mpgd-kit/commit/537c6168a902332e6c62ab0585d2cdfac946e51a) Add the ONE play H5 Web SDK target and browser adapter subpath, asynchronous host loading acknowledgements, synchronous exit checkpoints, platform asserted identity, audio/safe-area integration, and interstitial presentation handling that keeps uncertain native outcomes quarantined. Include target build, hosting headers, generated starter wiring and explicit server authority gates for subsequent monetization integrations. — Thanks @imjlk!
- [a483af3f](https://github.com/imjlk/mpgd-kit/commit/a483af3fb7f789a9edc71cc513e7c122d0b1e4b6) Add ONE play managed purchases with authenticated checkout intents, independent API V7 verification, ledger-before-consume or acknowledge finalization, signed PNS recovery and authoritative cancellation hooks. Map partial product detail batches and expose trusted native checkout presentation facts through the shared commerce contract and runtime. Keep subscriptions unsupported and server integrations required. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.17.0

## 0.8.0 — 2026-10-09

### Minor changes

- [2d35eb0e](https://github.com/imjlk/mpgd-kit/commit/2d35eb0ecd89eef1058e4b9983eb284f7ba38adc) Add a CrazyGames web target and the browser adapter's `/crazygames` entry point with official v3 SDK initialization, loading/gameplay reporting, and interstitial ads using the shared presentation contract. Basic Launch keeps monetization disabled; Full Launch enables configured interstitial placements. Rewarded ads and purchases remain unavailable pending independent backend verification. Generated starters enter free play directly and retain scene, lifecycle, and native presentation ownership through game-owned gameplay scopes. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.16.0

## 0.7.9 — 2026-10-09

### Patch changes

- Updated dependencies: platform@0.15.0

## 0.7.8 — 2026-10-04

### Patch changes

- [c3e9f87c](https://github.com/imjlk/mpgd-kit/commit/c3e9f87cd7dc4f7c4ebcfbe6a1458b4977d363d1) Stop client adapters from returning grant-shaped rewarded-ad results.
  
  - `@mpgd/adapter-verse8`: a Verse8 `rewarded` SDK callback now resolves to
    `status: 'completed', rewardGranted: false` with the `verse8.ads.reward.v1`
    evidence envelope and no `ledgerEntryId`. The Verse8 `requestId` is an
    impression id, not a ledger entry; only the backend verifier may grant.
  - `@mpgd/adapter-browser`: `createBrowserPlatformGateway()` never returns a
    grant on any code path. By default commerce and ads report unavailable and
    `purchase()` fails closed. The new `mockCommerce: true` option adds a
    local-demo sample catalog with evidence-only results: `purchase()` resolves
    `status: 'completed'` with a mock `transactionId`, empty `entitlementIds`,
    no `authoritativeGrant`, and `mpgd.browser.mock-purchase.v1` evidence;
    `showRewarded()` resolves `status: 'completed', rewardGranted: false` with
    no `ledgerEntryId` and `mpgd.browser.mock-reward.v1` evidence. Neither
    schema is accepted by backend claim APIs. The schema strings are exported as
    `browserMockPurchaseEvidenceSchema` and `browserMockRewardEvidenceSchema`.
    `withMicrosoftStoreCommerceAdapter` now replaces the base `ads` surface with
    an unavailable adapter and reports ad capabilities as false.
    `createUnavailableAdAdapter` is exported for custom gateways.
  - `@mpgd/game-services`: `createGameServicesClient` forwards allow-listed
    client reward evidence (AdMob and Verse8) to `claimAdReward`, deriving
    `platformImpressionId` from the Verse8 evidence `requestId`. New exports:
    `isClientRewardEvidence`, `isVerse8ClientRewardEvidence`,
    `resolveRewardPlatformImpressionId`, `clientRewardEvidenceSchemas`,
    `verse8ClientRewardEvidenceSchema`. Recoverable monetization clients bind
    journaled Verse8 claims to the evidence-derived impression id. — Thanks @imjlk!

## 0.7.7 — 2026-09-28

### Patch changes

- Updated dependencies: platform@0.14.0

## 0.7.6 — 2026-09-25

### Patch changes

- Updated dependencies: platform@0.13.0

## 0.7.5 — 2026-09-24

### Patch changes

- Updated dependencies: platform@0.12.2

## 0.7.4 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.12.1

## 0.7.3 — 2026-09-02

### Patch changes

- Updated dependencies: platform@0.12.0

## 0.7.2 — 2026-08-29

### Patch changes

- Updated dependencies: platform@0.11.0

## 0.7.1 — 2026-08-26

### Patch changes

- Updated dependencies: platform@0.10.0

## 0.7.0 — 2026-08-21

### Minor changes

- [842fc11](https://github.com/imjlk/mpgd-kit/commit/842fc1190d92692cf503233d9f916ea49d9b050c) Add a bounded WebView2 message bridge for native Microsoft Store player sign-in, catalog,
  purchase, and ownership operations. Native StoreContext hosts can now reuse the browser commerce
  adapter without granting purchases from client callbacks. The sign-in contract keeps the Microsoft
  ID token, publisher ticket, and User Collections ID inside the trusted native host and returns only
  a short-lived game-scoped session to web content. — Thanks @imjlk!

## 0.6.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!
### Patch changes

- Updated dependencies: platform@0.9.0

## 0.5.1 — 2026-07-23

### Patch changes

- Updated dependencies: platform@0.8.0

## 0.5.0 — 2026-07-17

### Added

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.7.0

## 0.4.3 — 2026-07-15

### Patch changes

- Updated dependencies: platform@0.6.0

## 0.4.2 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.5.1

## 0.4.1 — 2026-07-13

### Patch changes

- Updated dependencies: platform@0.5.0

## 0.4.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.4.0

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: platform@0.3.2

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: platform@0.3.1

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: platform@0.3.0

## 0.2.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

### Patch changes

- Updated dependencies: platform@0.2.0

## 0.1.0 — 2026-07-04

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks imjlk!
- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Add target-managed localization support through localized content capabilities, target runtime snapshots, a shared Paraglide-backed message package, demo locale resolution, and mock platform capability responses. — Thanks imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

### Patch changes

- Updated dependencies: platform@0.1.0
