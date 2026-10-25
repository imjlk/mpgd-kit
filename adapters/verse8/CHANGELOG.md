# @mpgd/adapter-verse8

## 0.7.9 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/catalog@0.10.8, @mpgd/game-runtime@0.8.2, @mpgd/game-services@0.28.1, @mpgd/platform@0.28.0

## 0.7.8 — 2026-10-24

### Patch changes

- Updated dependencies: game-runtime@0.8.1, game-services@0.28.0

## 0.7.7 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/catalog@0.10.7, @mpgd/game-runtime@0.8.0, @mpgd/game-services@0.27.2, @mpgd/platform@0.27.2

## 0.7.6 — 2026-10-21

### Patch changes

- [c29bde83](https://github.com/imjlk/mpgd-kit/commit/c29bde8313d1a2bf3e202ba7785695397411bfa0) Keep Verse8 purchase follow-up re-reads until every outstanding unsettled purchase signal has been settled. A signal that reports no new purchase id, including the id-less default dialog close, increments that count and opens or extends one follow-up window at `verse8PurchaseFollowUpDelaysMs`. Each purchase id newly reported by the immediate re-read or a follow-up read settles one outstanding signal. A signal that names a new purchase id settles that signal and does not consume an earlier slot or schedule re-reads. Timers cancel only when the count reaches 0, the window's attempts elapse, or the last listener unsubscribes. An id the bound has already emitted is not emitted again. The provider does not grant; it only re-reads the purchase source. — Thanks @imjlk!
- Updated dependencies: @mpgd/catalog@0.10.6, @mpgd/game-runtime@0.7.6, @mpgd/game-services@0.27.1, @mpgd/platform@0.27.1

## 0.7.5 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/catalog@0.10.5, @mpgd/game-runtime@0.7.5, @mpgd/game-services@0.27.0, @mpgd/platform@0.27.0

## 0.7.4 — 2026-10-20

### Patch changes

- Updated dependencies: @mpgd/catalog@0.10.4, @mpgd/game-runtime@0.7.4, @mpgd/game-services@0.26.0, @mpgd/platform@0.26.0

## 0.7.3 — 2026-10-19

### Patch changes

- Updated dependencies: catalog@0.10.3, game-runtime@0.7.3, game-services@0.25.1, platform@0.25.0

## 0.7.2 — 2026-10-19

### Patch changes

- Updated dependencies: catalog@0.10.2, game-runtime@0.7.2, game-services@0.25.0, platform@0.24.0

## 0.7.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.10.1, game-runtime@0.7.1, game-services@0.24.1, platform@0.23.1

## 0.7.0 — 2026-10-15

### Minor changes

- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: commerce v2, PR C4 removes the commerce v1 surfaces from the Verse8
  adapter. The commerce v2 provider (`createVerse8CommerceProvider`) is the only
  commerce path.
  
  - `createVerse8PlatformGateway()` no longer builds the v1 `gateway.commerce`
    adapter (`getProducts`, `purchase`, `restore`, `getEntitlements`, a failing
    stub when `vxShop` was absent). The provider that
    `createVerse8PlatformGateway({ vxShop: { purchases } })` builds is now
    `gateway.commerce` (it was `gateway.commerceV2`); without `vxShop`, the
    `agent8-server` acknowledgement, a product, or a purchase source the gateway
    sells nothing, has no `commerce`, and reports
    `createUnsupportedCommerceCapabilities()`.
  - `Verse8CommerceOptions.loadEntitlements` is removed (only the v1 adapter read
    it), and `Verse8CommerceOptions.purchases` is now required, so a `vxShop`
    configured for v1 only fails to compile instead of silently selling nothing.
    The Agent8 service keeps its own server-side reads (`getEntitlements`,
    `getSnapshot`, `listPurchases`); the backend ledger the service writes (the
    `ledger` option) is the commerce record.
  - `gateway.getCapabilities()` no longer reports `nativeIap` or `subscriptionIap`;
    `commerce` is always present: the provider's block when `vxShop.purchases` is
    configured, otherwise the unsupported block (a fresh object on every read). — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.10.0, game-runtime@0.7.0, game-services@0.24.0, platform@0.23.0

## 0.6.1 — 2026-10-12

### Patch changes

- Updated dependencies: game-runtime@0.6.6, game-services@0.23.0

## 0.6.0 — 2026-10-12

### Minor changes

- [8c870580](https://github.com/imjlk/mpgd-kit/commit/8c87058002249260d63dbffe8a305417aa1db6ad) Commerce v2, PR C2: the Agent8 commerce service writes the server-push ledger
  grant the backend lookup reads.
  
  `createVerse8Agent8CommerceService` accepts `ledger?: GameServicesStore`,
  `ledgerTarget?` (default `verse8`), and `resolvePlayerId?`. With a ledger,
  every `$onItemPurchased` grant is also recorded there through
  `createServerPushLedgerGrant` from `@mpgd/game-services` (target `verse8`,
  store `verse8`, the purchase id as the platform transaction id, the event's
  `quantity` scaling the grant and recorded in the payload, key
  `store:verse8:<purchaseId>`, and `ledgerDeploymentTarget` when the backend
  binds `verse8` to a deployment target), after the Agent8 user state committed
  and idempotently on redelivery, so a verify request carrying
  `verse8.agent8-event.v1` evidence answers `granted` once the event ran and
  `pending` before it; a redelivery for a product that left the catalog before
  the ledger write landed throws instead of acknowledging the event. Without a
  ledger the service is unchanged. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.9.3, game-runtime@0.6.5, game-services@0.22.0, platform@0.22.0

## 0.5.0 — 2026-10-12

### Minor changes

- [fe0efad2](https://github.com/imjlk/mpgd-kit/commit/fe0efad281a9cd396f6e9b7cef8494cff9fc529b) Commerce v2, PR B6: the Verse8 provider on the server-push lookup.
  
  Not yet usable in production before C2: the backend lookup verifier for
  `verse8.agent8-event.v1` is C2 work, so today a verify request for a Verse8
  purchase is refused by `@mpgd/game-services` (no verifier for the schema,
  `verse8` not a store target) instead of answering `pending`, and no journal
  record can reach `granted`. `vxShop.purchases` is opt-in; without it nothing
  changes.
  
  `@mpgd/adapter-verse8` adds `createVerse8CommerceProvider({ products, client,
  purchases, store?, init?, canOpenShop?, onPurchasesChanged? })`, a
  `CommerceProvider` with `store: 'verse8'` and the RFC profile (consumable and
  durable one-time products, no subscription, no quantity, no available-purchase
  list, `lifecycle.finish: 'none'`, `authority.evidence: 'server-push'`,
  `accountBinding: 'host'`, pending, restore, events). It drives the same VXShop
  client as the v1 adapter and never grants: the Agent8 server's reserved
  `$onItemPurchased` event writes the record, and the backend's lookup verifier
  answers `pending` until it exists.
  
  - `requestPurchase` refreshes VXShop, checks the live item, and opens the
    dialog with `buyItem`, answering `launched`; outside the Verse8 iframe it
    fails with `CONFIGURATION_REQUIRED` (`VERSE8_SHOP_UNAVAILABLE`), an unlisted,
    unpurchasable, or limit-reached item with `ITEM_UNAVAILABLE`
    (`VERSE8_PRODUCT_NOT_LISTED`, `VERSE8_PRODUCT_NOT_PURCHASABLE`,
    `VERSE8_PURCHASE_LIMIT_REACHED`), and a failed refresh with a retryable
    `STORE_UNAVAILABLE`.
  - `getAvailablePurchases` is empty; `restorePurchases` re-reads the
    `purchases` source (`Verse8PurchaseSource`) and emits `purchaseUpdated` once
    per recorded purchase not reported before (the Agent8 purchase id as
    `transactionId` and `token`, `verse8.agent8-event.v1` evidence
    `{ purchaseId, productId, quantity }`, a `host-identity` binding). The
    `onPurchasesChanged` signal does the same and may carry the purchases it
    knows; by default it is the VXShop dialog closing after a purchase
    (`VXShop.onClose`, now an optional member of `Verse8VXShopClient`), observed
    while a listener exists. The first listener triggers a re-read (a restart,
    or a gap without listeners, finds the purchases recorded meanwhile), a
    signal nothing was recorded for yet is followed by re-reads at
    `verse8PurchaseFollowUpDelaysMs` (up to about nine minutes, ending at the
    first read that finds a new record, since the Agent8 event may land after
    the dialog closed), and the newest `maximumVerse8ReportedPurchases` records
    are the ones reported. A catalog without a consumable or durable product is
    `configuration-required`. Events before the first listener are buffered.
  - `createVerse8CommerceCapabilities`, `createVerse8StorePurchase`,
    `createVerse8Agent8EventEvidence`, and `assertVerse8Agent8EventEvidence` (the
    server-side validation of `verse8.agent8-event.v1`) are exported from the
    main entry and from `./agent8`.
  
  `createVerse8Agent8CommerceService` adds `listPurchases(account, context)`,
  the purchases `$onItemPurchased` recorded for an account, oldest first
  (`Verse8RecordedPurchase`), for a game-owned authenticated Agent8 method to
  expose as the provider's purchase source.
  
  `createVerse8PlatformGateway` takes `vxShop.purchases` and
  `vxShop.onPurchasesChanged`; with `purchases` configured it exposes the
  provider as `commerceV2` and adds the `commerce` capability block with
  `nativeIap` and `subscriptionIap` derived from it. Without it the gateway is
  unchanged, and the v1 adapter keeps its behaviour either way.
  
  Conformance: `adapters/verse8/src/verse8-commerce-provider.conformance.test.ts`
  runs the RFC vectors through `runCommerceConformanceVectors` with a fake VXShop
  and Agent8 record, directly and through the gateway; `server-push-settlement`
  passes with its fixture expectations, and `event-before-listener`,
  `purchase-client-finish`, `restart-before-verify`, and `revoked-after-grant`
  run with finish-none expectations derived for the `verse8` id. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.9.2, game-runtime@0.6.4, game-services@0.21.1, platform@0.21.0

## 0.4.6 — 2026-10-12

### Patch changes

- Updated dependencies: catalog@0.9.1, game-runtime@0.6.3, game-services@0.21.0, platform@0.20.0

## 0.4.5 — 2026-10-11

### Patch changes

- [a4fa5b14](https://github.com/imjlk/mpgd-kit/commit/a4fa5b14440e94c775baaf574dece7abaa0092b7) `@mpgd/platform` adds the commerce v2 contract module as the new `./commerce`
  and `./commerce-vectors` subpaths: the client contract types (`StoreProduct`,
  `StorePurchase`, `RequestPurchaseInput`, `CommerceEvent`, `CommerceProvider`,
  `CommerceCapabilities`, `ActiveSubscription`, credit wallet types), the bridge
  v2 payload shapes and event envelope, `CommerceError` with normalized codes,
  the purchase lifecycle state machine, typia validators that reject unknown
  keys, `createDerivedPurchaseIdempotencyKey`, the bounded pre-listener event
  buffer, `assertRequestPurchaseSupported`, the v1 `toCommerceAdapter` wrapper
  (which never grants), and the conformance vector format. `PlatformCapabilities`
  gains an optional `commerce` block that the capability conformance runner
  checks for fresh objects, exact keys, and agreement with `nativeIap` and
  `subscriptionIap`. This is additive: no reference provider implements v2 yet,
  and the protocol version stays `2.0.0-draft.1`. The package now depends on
  `typia`.
  
  `@mpgd/catalog` opens `ProductGrant.currency` and `AdReward.currency` to any
  non-empty string validated against a new optional `ProductCatalog.currencies`
  list (non-empty, unique, trimmed); when absent the catalog accepts `coin` and
  `gem` as before. `assertProductCatalog` and `validate:catalog` reject a currency
  grant that names an undeclared currency, `validate:ads` cross-checks reward
  currencies against the catalog, and `resolveCatalogCurrencies` and
  `defaultCatalogCurrencies` are exported. The kit adds no wallet currency
  literal.
  
  `@mpgd/adapter-verse8` keeps its `coin` and `gem` balance map and now fails a
  currency grant for any other catalog currency with a clear error instead of
  writing an untracked balance.
  
  `@mpgd/game-services` accepts any currency the product catalog declares: the
  ledger grant validator no longer hard-codes `coin` and `gem` (it requires a
  trimmed non-empty code), and `createGameServicesBackend` rejects a catalog
  product grant or placement reward whose currency the catalog does not declare,
  so an undeclared currency fails at startup instead of at the first grant. — Thanks @imjlk!
- Updated dependencies: catalog@0.9.0, game-runtime@0.6.2, game-services@0.20.0, platform@0.19.0

## 0.4.4 — 2026-10-11

### Patch changes

- Updated dependencies: catalog@0.8.1, game-runtime@0.6.1, game-services@0.19.1, platform@0.18.0

## 0.4.3 — 2026-10-10

### Patch changes

- Updated dependencies: game-runtime@0.6.0

## 0.4.2 — 2026-10-09

### Patch changes

- Updated dependencies: catalog@0.8.0, game-runtime@0.5.0, game-services@0.19.0, platform@0.17.0

## 0.4.1 — 2026-10-09

### Patch changes

- Updated dependencies: catalog@0.7.8, game-runtime@0.4.0, game-services@0.18.1, platform@0.16.0

## 0.4.0 — 2026-10-09

### Added

- [ae650009](https://github.com/imjlk/mpgd-kit/commit/ae65000999f0b97bbeebafd856bc8995bb890edd) Expose Verse8 advertising through the versioned behavior contract with original SDK request identity and scoped host presentation observations. Require reliable host closure for rewarded display, keep timed-out presentation occupied until a real terminal fact, and return only ungranted server-verifiable evidence. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.7.7, game-runtime@0.3.0, game-services@0.18.0, platform@0.15.0

## 0.3.12 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.2

## 0.3.11 — 2026-10-04

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
- Updated dependencies: game-services@0.17.1

## 0.3.10 — 2026-09-28

### Patch changes

- Updated dependencies: catalog@0.7.6, game-services@0.17.0, platform@0.14.0

## 0.3.9 — 2026-09-25

### Patch changes

- Updated dependencies: catalog@0.7.5, game-services@0.16.0, platform@0.13.0

## 0.3.8 — 2026-09-24

### Patch changes

- Updated dependencies: catalog@0.7.4, game-services@0.15.3, platform@0.12.2

## 0.3.7 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.7.3, game-services@0.15.2, platform@0.12.1

## 0.3.6 — 2026-09-13

### Patch changes

- Updated dependencies: game-services@0.15.1

## 0.3.5 — 2026-09-13

### Patch changes

- Updated dependencies: game-services@0.15.0

## 0.3.4 — 2026-09-02

### Patch changes

- Updated dependencies: catalog@0.7.2, game-services@0.14.0, platform@0.12.0

## 0.3.3 — 2026-08-29

### Patch changes

- Updated dependencies: catalog@0.7.1, game-services@0.13.1, platform@0.11.0

## 0.3.2 — 2026-08-27

### Patch changes

- Updated dependencies: game-services@0.13.0

## 0.3.1 — 2026-08-26

### Patch changes

- Updated dependencies: catalog@0.7.0, game-services@0.12.1, platform@0.10.0

## 0.3.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.6.0, game-services@0.12.0, platform@0.9.0

## 0.2.3 — 2026-08-04

### Changed

- [6ae2720](https://github.com/imjlk/mpgd-kit/commit/6ae27206b4aaae601c7feaa4ca7946b7cad5c654) Allow safe game-owned `kind: "web"` target names in build, smoke, and matrix CLI workflows while preserving the existing browser and web aliases. Support additive game-owned target-config policies at build time and runtime, monetization identifiers, authoritative purchase and reward verification for custom deployments, verified non-installable browser artifacts, and bounded static web artifact overlays for custom browser deployments while reserving platform-specific PWA policy for its canonical target. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.5.2, game-services@0.11.1

## 0.2.2 — 2026-07-23

### Patch changes

- Updated dependencies: catalog@0.5.1, game-services@0.11.0, platform@0.8.0

## 0.2.1 — 2026-07-17

### Patch changes

- Updated dependencies: game-services@0.10.0

## 0.2.0 — 2026-07-17

### Added

- [f3ea335](https://github.com/imjlk/mpgd-kit/commit/f3ea335773e7e0812a65866800789cac0d85a34b) Add opt-in Verse8 Agent8 authenticated-encrypted cloud storage and a server-verified leaderboard provider with authenticated participant scoping, game-specific verification, server-secret-keyed persistence markers, and bounded opaque cursor pagination while keeping the generic native leaderboard disabled. — Thanks @imjlk!
- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Fixed

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!
- [4307985](https://github.com/imjlk/mpgd-kit/commit/4307985f02743278703cb87abb835ed14a92d5d9) Add validated generic consumable resource product grants, preserve them through current and legacy authoritative ledger transactions, and keep unsupported resource products out of Verse8 shops and effective target configurations. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!

### Patch changes

- Updated dependencies: catalog@0.5.0, game-services@0.9.0, platform@0.7.0

