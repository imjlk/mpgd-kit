# @mpgd/adapter-devvit

## 0.10.0 — 2026-10-12

### Minor changes

- [fe0efad2](https://github.com/imjlk/mpgd-kit/commit/fe0efad281a9cd396f6e9b7cef8494cff9fc529b) Commerce v2, PR B6: the Devvit provider on the server-push lookup.
  
  Not yet usable in production before C2: the backend lookup verifier for
  `devvit.order.v1` is C2 work, so today a verify request for a Devvit purchase
  is refused by `@mpgd/game-services` (no verifier for the schema, `reddit` not
  a store target) instead of answering `pending`, and no journal record can
  reach `granted`. The gateway `commerce` option is opt-in; without it nothing
  changes.
  
  `@mpgd/adapter-devvit` adds `createDevvitCommerceProvider({ products, client,
  orders, store?, onOrdersChanged?, onCheckoutError? })`, a `CommerceProvider`
  with `store: 'devvit'` and the RFC profile (consumable and durable one-time
  products, no subscription, no quantity, `lifecycle.finish: 'none'`,
  `authority.evidence: 'server-push'`, `accountBinding: 'host'`, available
  purchases, pending, restore, events). It runs over the v1
  `DevvitPaymentsClient` checkout and never grants: Reddit's fulfillment handler
  writes the ledger on the server, and the backend's lookup verifier answers
  `pending` until that entry exists.
  
  - `requestPurchase` opens the Reddit checkout. A `completed` result carrying
    the order id answers `purchased` with the order id as `transactionId` and
    `token`, `devvit.order.v1` evidence `{ orderId, sku, source: 'checkout' }`
    and a `host-identity` binding; a result without an order id, or `pending`,
    is `launched`, and so is a `purchase()` call that rejects (a missing
    response does not prove a missing order); `cancelled` is `USER_CANCELLED`;
    `failed` keeps the platform code as `storeCode` (`DevvitCheckoutResult.error`,
    new and optional), with `OUTCOME_UNKNOWN` and `ALREADY_OWNED` classes kept
    open as `launched`.
  - `getAvailablePurchases` lists the paid orders whose delivery Reddit has not
    acknowledged, read from the `orders` source (`DevvitOrderSource`, whose
    entries carry a `delivered` flag), bounded by `maximumDevvitAvailableOrders`;
    `restorePurchases` and the first listener re-read it and emit
    `purchaseUpdated` once per order not reported before, delivered orders
    included (so a checkout result lost to a restart still reaches the
    reconciler), as the `onOrdersChanged` signal does (orders it carries are
    reported first). An unconfigured catalog, or one without a consumable or
    durable product, is `configuration-required`.
  - `createDevvitCommerceCapabilities`, `createDevvitStorePurchase`,
    `createDevvitOrderEvidence`, and `assertDevvitOrderEvidence` (the server-side
    validation of `devvit.order.v1`) are exported for registries and tests;
    `normalizeDevvitCommerceProducts` is exported from `./payments`.
  
  `@mpgd/adapter-devvit/server` adds `createDevvitCommerceV2BridgeHandler({
  payments, products, store?, warn? })`, which serves the six `commerce.v2.*`
  bridge methods over the Devvit `payments` plugin (`PaymentsClient` of
  `@devvit/payments/server` fits `DevvitServerPaymentsLike`): `PAID` and
  `DELIVERED` orders of configured SKUs as purchases (evidence `status` says
  which; pages of 64 newest first, stopping after two pages without one or at
  eight pages), configured
  products from `getProducts` priced in Reddit Gold, the profile capabilities,
  `restorePurchases` as `{ restored: false }`, `requestPurchase` refused with
  `DEVVIT_COMMERCE_CHECKOUT_CLIENT_ONLY` (the checkout is a webview effect), and
  `finishTransaction` refused with `COMMERCE_V2_METHOD_UNSUPPORTED`. Payloads and
  results are validated with the `@mpgd/platform/commerce` asserts; a plugin
  failure is the retryable `DEVVIT_PAYMENTS_UNAVAILABLE`.
  
  `createDevvitPlatformGateway` takes an optional `commerce` option
  (`DevvitGatewayCommerceOptions`) that installs the provider as `commerceV2`
  over the gateway's bridge (`createDevvitBridgeOrderSource`:
  `commerce.v2.getAvailablePurchases` and `commerce.v2.getCapabilities`; a
  `COMMERCE_V2_UNAVAILABLE` answer is `configuration-required` and a
  `CONFIGURATION_REQUIRED` list error, a transport failure a retryable
  `NETWORK` error) and adds the
  `commerce` capability block with `nativeIap` and `subscriptionIap` derived from
  it. Without the option the gateway is unchanged. The sandbox bridge keeps
  answering commerce v2 with `COMMERCE_V2_UNAVAILABLE`.
  
  Conformance: `adapters/devvit/src/devvit-commerce-provider.conformance.test.ts`
  runs the RFC vectors through `runCommerceConformanceVectors` with a fake
  Reddit, directly and through the server bridge handler and gateway path;
  `server-push-settlement` passes with its fixture expectations, and
  `event-before-listener`, `purchase-client-finish`, `restart-before-verify`, and
  `revoked-after-grant` run with finish-none expectations derived for the
  `devvit` id. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.12.2, game-services@0.21.1, platform@0.21.0

## 0.9.20 — 2026-10-12

### Patch changes

- Updated dependencies: bridge@0.12.1, game-services@0.21.0, platform@0.20.0

## 0.9.19 — 2026-10-11

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
- Updated dependencies: bridge@0.12.0, game-services@0.20.0, platform@0.19.0

## 0.9.18 — 2026-10-11

### Patch changes

- Updated dependencies: game-services@0.19.1, platform@0.18.0

## 0.9.17 — 2026-10-09

### Patch changes

- Updated dependencies: game-services@0.19.0, platform@0.17.0

## 0.9.16 — 2026-10-09

### Patch changes

- Updated dependencies: game-services@0.18.1, platform@0.16.0

## 0.9.15 — 2026-10-09

### Patch changes

- Updated dependencies: bridge@0.11.0, game-services@0.18.0, platform@0.15.0

## 0.9.14 — 2026-10-04

### Patch changes

- [c6e760b6](https://github.com/imjlk/mpgd-kit/commit/c6e760b6ae70d8ed1728bc3265869c5bc100ee77) Accept Devvit payment handler orders without `userId` again. Devvit's `PaymentHandlerRequest` (`@devvit/payments` 0.14) carries only `id`, `status`, `createdAt`, `updatedAt`, `products` and `metadata`, and Devvit runs the handler in the purchasing user's request context. Since 0.9.13, `normalizeDevvitFulfillmentOrder` and `normalizeDevvitRefundOrder` rejected every real order with `order.userId must be a string`, so no Reddit purchase could be fulfilled or refunded. The authenticated context player is again the binding. An order that does carry a `userId` must still be a string that matches it. — Thanks @imjlk!
- Updated dependencies: game-services@0.17.2

## 0.9.13 — 2026-10-04

### Patch changes

- [686ea3ab](https://github.com/imjlk/mpgd-kit/commit/686ea3ab494b30d1ffd81fe0d2132e43239d940c) Require `userId` on Devvit payment orders in `normalizeDevvitFulfillmentOrder` and `normalizeDevvitRefundOrder`. Orders that omit the purchasing user are now rejected instead of being stamped with the authenticated context player, so the order-to-player binding is always enforced before fulfillment or refund. — Thanks @imjlk!
- [686ea3ab](https://github.com/imjlk/mpgd-kit/commit/686ea3ab494b30d1ffd81fe0d2132e43239d940c) Bound per-player cloud-save keys in generated Devvit targets. The `phaser-game` template now ships `apps/target-devvit/src/server/bridge.ts`, mirroring the kit wrapper: `storage.save` tracks each player's distinct keys in a `<game-name>:save-keys:<user>` hash, enforces `maxStorageKeysPerPlayer` inside a WATCH/MULTI/EXEC transaction, and rejects saves past the cap with `DEVVIT_STORAGE_KEY_LIMIT`, so one authenticated Reddit account can no longer exhaust the installation's shared Redis quota.
  
  Detect aborted Devvit Redis transactions correctly. `@devvit/redis` `TxClient.exec()` never resolves `null` for a WATCH conflict; it returns an empty array. The template bridge and the kit wrapper now treat an EXEC result with fewer entries than the queued commands as contention and retry instead of reporting an unwritten save as persisted. `createDevvitRedisPostOperationStore` applies the same rule: in addition to `null`, any EXEC result shorter than the number of queued mutations is retried as contention. — Thanks @imjlk!
- Updated dependencies: game-services@0.17.1

## 0.9.12 — 2026-09-28

### Patch changes

- Updated dependencies: game-services@0.17.0, platform@0.14.0

## 0.9.11 — 2026-09-25

### Patch changes

- Updated dependencies: bridge@0.10.0, game-services@0.16.0, platform@0.13.0

## 0.9.10 — 2026-09-24

### Patch changes

- Updated dependencies: game-services@0.15.3, platform@0.12.2

## 0.9.9 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.9.1, game-services@0.15.2, platform@0.12.1

## 0.9.8 — 2026-09-13

### Patch changes

- Updated dependencies: game-services@0.15.1

## 0.9.7 — 2026-09-13

### Patch changes

- Updated dependencies: game-services@0.15.0

## 0.9.6 — 2026-09-02

### Patch changes

- Updated dependencies: game-services@0.14.0, platform@0.12.0

## 0.9.5 — 2026-08-29

### Patch changes

- Updated dependencies: game-services@0.13.1, platform@0.11.0

## 0.9.4 — 2026-08-27

### Patch changes

- Updated dependencies: game-services@0.13.0

## 0.9.3 — 2026-08-27

### Patch changes

- [4e92350](https://github.com/imjlk/mpgd-kit/commit/4e92350c4cf29d71c2a73aa164f814ef8ecd1c50) Add a preview-only Devvit view-mode contract and make generated games load Phaser only from the Expanded Mode entry by default. The existing inline-gameplay contract remains available as an explicit opt-in. — Thanks @imjlk!

## 0.9.2 — 2026-08-26

### Changed

- [d49be5b](https://github.com/imjlk/mpgd-kit/commit/d49be5b890f0a7058487f5763d2acc0433ac2b39) Align the Devvit adapter, generated target, and starter template on Devvit 0.14.1. Generated targets pin Vite 7.3.6 for compatibility with the current Devvit Vite plugin. — Thanks @imjlk!

## 0.9.1 — 2026-08-26

### Patch changes

- Updated dependencies: bridge@0.9.0, game-services@0.12.1, platform@0.10.0

## 0.9.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.8.0, game-services@0.12.0, platform@0.9.0

## 0.8.6 — 2026-08-04

### Patch changes

- Updated dependencies: game-services@0.11.1

## 0.8.5 — 2026-07-23

### Patch changes

- Updated dependencies: bridge@0.7.0, game-services@0.11.0, platform@0.8.0

## 0.8.4 — 2026-07-17

### Patch changes

- Updated dependencies: game-services@0.10.0

## 0.8.3 — 2026-07-17

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

- Updated dependencies: bridge@0.6.1, game-services@0.9.0, platform@0.7.0

## 0.8.2 — 2026-07-15

### Patch changes

- Updated dependencies: game-services@0.8.2

## 0.8.1 — 2026-07-15

### Fixed

- [ae8ffdb](https://github.com/imjlk/mpgd-kit/commit/ae8ffdb449db4fc05e41bc9d4e2b2af149d4339c) Prevent the Devvit commerce installer from bypassing target-config IAP gating by
  failing closed when invoked after target availability has already been applied. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.8.1

## 0.8.0 — 2026-07-15

### Added

- [7d1108e](https://github.com/imjlk/mpgd-kit/commit/7d1108ef1d81262b5a707af6f7e57289b6c5f2b3) Add conservatively indexed durable Devvit post operations and scope-bound cursor
  pagination for bounded recovery workers. Stable registry membership is created
  before durable state and retained across every transition, preventing live work
  from disappearing through partial cross-key updates. Discovery remains read-only
  and keeps attempted and terminal outcomes fail-closed instead of restoring submit
  permission. Exact operation reads and transitions lazily backfill stable registry
  membership for durable records created before indexed discovery was enabled.
  Best-effort read backfills use the stored descriptor even on conflicts and never
  mask an already-readable durable result, while state mutations still require
  registry membership first. — Thanks @imjlk!
- [8248bcf](https://github.com/imjlk/mpgd-kit/commit/8248bcfed031669cf70b13996bb8ad2bf9bc0063) Add Devvit payment order normalization, a commerce adapter that keeps checkout
  results separate from authoritative server entitlement reads, and a gateway
  installer that advertises IAP only when that adapter is configured. — Thanks @imjlk!
- [cddcba8](https://github.com/imjlk/mpgd-kit/commit/cddcba899e912b28e18fdca3b1520cbda992ccd7) Add an official-terminology Devvit view mode API with a concurrency-safe,
  retryable inline mode gameplay loader. Generated Phaser starters now keep their
  initial launch screen lightweight, start gameplay inside the post after an
  explicit click, and retain the separate expanded mode game entry. — Thanks @imjlk!

### Fixed

- [e4a89d7](https://github.com/imjlk/mpgd-kit/commit/e4a89d7d7788e7b103a17bbefc5389534c1e7b32) Stop advertising a native Devvit leaderboard and disable the generic client
  score submission path in both the shared target and generated starters. Devvit
  games continue to use the server-only verified leaderboard provider from
  authoritative completion handlers. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.8.0, platform@0.6.0

## 0.7.0 — 2026-07-14

### Changed

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Add bounded immutable numeric metrics to verified attempts and ranked entries,
  preserving them across memory, Devvit Redis, Cloudflare D1, and authenticated
  snapshot transports without changing score-based ranking behavior. — Thanks @imjlk!

### Removed

- [82b9458](https://github.com/imjlk/mpgd-kit/commit/82b94580f3c6021e05a10a06b655ffd968ce43b7) Upgrade generated Devvit targets to the stable 0.13.8 toolchain and remove the
  deprecated JSON fetch bridge API, JSON route, pre-namespace storage fallback,
  and split build strategy so Devvit targets use oRPC and the official Vite plugin
  exclusively. — Thanks @imjlk!

### Patch changes

- Updated dependencies: game-services@0.7.0

## 0.6.0 — 2026-07-14

### Changed

- [2f06373](https://github.com/imjlk/mpgd-kit/commit/2f063737d518a19d93de0781bf44582c0a0bc78b) Add an opt-in official Devvit Vite build strategy for generated Phaser games,
  upgrade Devvit packages to 0.13.7, expose a direct oRPC Node HTTP bridge
  adapter, and remove the generated target's Express-based request conversion. — Thanks @imjlk!
- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Added

- [960a114](https://github.com/imjlk/mpgd-kit/commit/960a114db3a7999e0b0541f46026e5d1a297fb93) Add a durable Redis verified-leaderboard provider for Devvit servers with
  atomic idempotency, deterministic ranking, and opaque cursor pagination. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.6.0, game-services@0.6.0, platform@0.5.1

## 0.5.0 — 2026-07-13

### Added

- [5a4f259](https://github.com/imjlk/mpgd-kit/commit/5a4f259ff196db50f5bd53cbd4e9f91bae9b2bd5) Add a duplicate-safe, ambiguity-safe Devvit custom-post operation coordinator and include its Redis-backed server wrapper in generated starters. — Thanks @imjlk!
- [2f51b58](https://github.com/imjlk/mpgd-kit/commit/2f51b580aa5057d0d18e1820b1ed5b9d50d86d7e) Add reusable Devvit web-surface routing and generate physically separate lightweight inline and expanded Phaser entries. — Thanks @imjlk!

### Changed

- [81b1bab](https://github.com/imjlk/mpgd-kit/commit/81b1bab1be4e9234187cc1db673d9b724f80d728) Distinguish a presented share surface from confirmed share completion and expose a conservative Devvit share-sheet wrapper. — Thanks @imjlk!

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

### Added

- [02d8cfd](https://github.com/imjlk/mpgd-kit/commit/02d8cfd5e7669e29f7c99754fb98773aa807bc4c) Add Devvit oRPC bridge transport. — Thanks @imjlk!

### Patch changes

- Updated dependencies: bridge@0.2.0, platform@0.2.0

## 0.1.0 - Unreleased

### Added

- Add the initial Reddit Devvit Web platform adapter.
