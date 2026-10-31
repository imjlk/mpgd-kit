# @mpgd/catalog

## 0.15.1 — 2026-11-01

### Patch changes

- Updated dependencies: @mpgd/platform@0.35.1

## 0.15.0 — 2026-10-31

### Added

- [1ee9b22e](https://github.com/imjlk/mpgd-kit/commit/1ee9b22e8816b820ef481a225382011988bda921) The store presence file's `appStore` section takes `copyright` (the version's copyright line) and `review` (App Review contact, notes, and a demo account named by environment variables, never by value), read by `mpgd store release`. `assertStorePresence` checks the contact email and phone (with its country code), the 4,000-character notes limit, and that `demoAccount.nameEnv` and `passwordEnv` are distinct environment variable names. New exports: `AppStorePresenceReview`, `AppStorePresenceReviewContact` and `AppStorePresenceDemoAccount`. — Thanks @imjlk!

## 0.14.2 — 2026-10-30

### Patch changes

- Updated dependencies: @mpgd/platform@0.35.0

## 0.14.1 — 2026-10-29

### Patch changes

- Updated dependencies: @mpgd/platform@0.34.0

## 0.14.0 — 2026-10-28

### Changed

- [d684308f](https://github.com/imjlk/mpgd-kit/commit/d684308f4eff54e2ea772bed8dcda4b1ea528630) The runtime `typia` dependency moves from 13.0.2 to 15.2.1, and the shipped validators are rebuilt with typia 15 through ttsc 0.34.2. A game that runs its own typia transform over `@mpgd/catalog` types now needs typia 15.2 or later, because typia 15's tag records emit runtime helpers that typia 13 does not have. `MinLength` counts code points instead of UTF-16 units. A store-presence `name` (minimum 2) or `email` (minimum 3) that reaches its minimum only through a single astral character, such as one emoji, is now refused. Topic-copy errors keep their `expected (string & MinLength<1>)` text. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/platform@0.33.0

## 0.13.0 — 2026-10-27

### Added

- [07efee2c](https://github.com/imjlk/mpgd-kit/commit/07efee2c8c8f9048de864ee7fe9e923c4c50c1db) New store presence file schema for the app's own store page (`StorePresence`, validated by `assertStorePresence(input)`): per Google Play language the title (30), short description (80), full description (4,000), YouTube promo video and graphics (icon, feature graphic, phone, 7-inch and 10-inch tablet screenshots), Play contact details, and per App Store locale the name (2-30), subtitle (30), description, keywords (100 bytes), promotional text, what's new, support, marketing and privacy policy URLs and screenshot sets for the 6.9", 6.5" and 6.3" iPhone and 13" iPad displays. A screenshot set is a list (add what the store lacks) or `{ files, complete: true }` (make the store match). `readStoreImageInfo(bytes)` reads a PNG or JPEG header (format, pixel size, alpha) without decoding, and `assertStorePresenceImage(slot, info, byteLength, label)` checks one image against the store's size, format and alpha rules. Existing files are unchanged. — Thanks @imjlk!

## 0.12.0 — 2026-10-27

### Added

- [dad46c97](https://github.com/imjlk/mpgd-kit/commit/dad46c97ac14592d86fb2024f06015aceb17f14d) The store listing file accepts `appStore.availability` (`territories` as ISO 3166-1 alpha-3 codes, `availableInNewTerritories`) for the territories a new App Store in-app purchase is sold in; duplicate territories are rejected. — Thanks @imjlk!
- [0bb03c08](https://github.com/imjlk/mpgd-kit/commit/0bb03c08d2764c383feb91c18d9573c434617ec7) New store listing file for one-time products (`StoreListingCatalog`, validated by `assertStoreListingCatalog(input, catalog)`): per logical product, the localized title and description, a Google Play tax-exclusive base price with optional per-region prices (tax inclusive: the price players pay in that region), purchase option ID and tax category, and for the App Store the base-territory customer price, manual territory prices, reference name, review note, review screenshot and Family Sharing. It is a separate file from `catalog.json` (game clients bundle the catalog; review notes and prices must not ship), every key must name a catalog product, and subscriptions are rejected. `resolveStoreListingLocalizations(entry, store)` returns a store's own localizations or the shared ones. Existing catalogs are unchanged. — Thanks @imjlk!

## 0.11.3 — 2026-10-27

### Patch changes

- Updated dependencies: @mpgd/platform@0.32.0

## 0.11.2 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/platform@0.31.0

## 0.11.1 — 2026-10-26

### Patch changes

- Updated dependencies: @mpgd/platform@0.30.0

## 0.11.0 — 2026-10-26

### Changed

- [6ce27613](https://github.com/imjlk/mpgd-kit/commit/6ce27613a430cde2cf13ffd7bac4e842f29cb296) `validateNotificationTopicCatalog` accepts an advertising topic mapped to `android` when the deployment sets `shellRendersAdvertising: true`, the switch for a shell that renders advertising pushes with the opt-out action (AR1). Without it the mapping is still refused, now with a message that names the switch. — Thanks @imjlk!

### Patch changes

- Updated dependencies: @mpgd/platform@0.29.0

## 0.10.8 — 2026-10-25

### Patch changes

- Updated dependencies: @mpgd/platform@0.28.0

## 0.10.7 — 2026-10-21

### Patch changes

- Updated dependencies: @mpgd/platform@0.27.2

## 0.10.6 — 2026-10-21

### Patch changes

- [78eb3235](https://github.com/imjlk/mpgd-kit/commit/78eb32359aa474cf38124da4c465ccac826750bf) `assertProductCatalog` and `assertAdPlacements` reject a repeated logical product or placement id. Platform-id collisions were already rejected; a second entry with the same id was kept by the first `find()` and could hide a different grant or SKU.
  
  Currency grant amounts and ad reward amounts must be finite, greater than zero, and a safe integer. A continue reward is a count of continues, not a fraction. Resource grant amounts are unchanged. — Thanks @imjlk!
- Updated dependencies: @mpgd/platform@0.27.1

## 0.10.5 — 2026-10-21

### Patch changes

- [c6438977](https://github.com/imjlk/mpgd-kit/commit/c6438977f3be174f4e351597366d935c37950b90) An advertising topic must not map to `android` until the shell renders the opt-out action. `validateNotificationTopicCatalog` reports that mapping, and a notifications service will not start on a catalog that has it. iOS advertising mappings are unchanged. The Android client still declares `advertising` so it pairs with the standard FCM registry. — Thanks @imjlk!
- Updated dependencies: @mpgd/platform@0.27.0

## 0.10.4 — 2026-10-20

### Patch changes

- Updated dependencies: @mpgd/platform@0.26.0

## 0.10.3 — 2026-10-19

### Patch changes

- Updated dependencies: platform@0.25.0

## 0.10.2 — 2026-10-19

### Patch changes

- Updated dependencies: platform@0.24.0

## 0.10.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.23.1

## 0.10.0 — 2026-10-15

### Minor changes

- [0234f853](https://github.com/imjlk/mpgd-kit/commit/0234f853cffff19e181587cef79fd0465144ed61) `isRootRelativeNotificationRoute` now accepts a route only when it is at most
  2,048 characters and `normalizeRootRelativeRoute(route) === route`, the rule
  share links and v1 notification deep links follow, instead of its own copy.
  Topic `route` and `optOutRoute` in a catalog, a local reminder's `route`, and
  the route a router opens all follow it.
  
  Root-relative normalization uses string operations, so catalog and notification
  policy validation works in runtimes without the DOM `URL` constructor.
  
  - A route that is not already in its normalized form is refused, and the
    catalog issue and the thrown error name that form. Examples are `/é`
    (`/%C3%A9`), `/a b` (`/a%20b`), a backslash in the path, and an empty `?` or
    `#` (`/a?`). A local reminder whose route is built at run time, such as
    `/?name=Ada Lovelace`, now throws until the game writes it in that form
    (`/?name=Ada%20Lovelace`).
  - Escapes that stay on the game's origin once decoded are no longer refused,
    because no client can read them as another host. Examples are
    `/levels/%252e%252e`, `/a/%2E%2E%2Fb`, `/a/%09b`, a malformed escape such as
    `/50%`, and a backslash in the query or fragment. A route a client could read
    as another host is still refused. — Thanks @imjlk!
- [0f3614e2](https://github.com/imjlk/mpgd-kit/commit/0f3614e2180c0c11e2ce89798b29ae8e4f1c528a) `@mpgd/catalog` gives the topic catalog's `notices.copy` a title and a body
  per notice variant for each locale (`consent-result.advertising.granted`,
  `consent-result.advertising.withdrawn`, `consent-result.night.granted`,
  `consent-result.night.withdrawn`, `reconfirmation.advertising`, and
  `reconfirmation.night`, with optional `consent-result.advertising.refused`
  and `consent-result.night.refused`, which fall back to the withdrawal's
  text), filled only with `{{consentDate}}`, which each variant uses. The text
  carries the rest of what the decree requires: the sender's name, and the
  processing result for a result notice (art. 62-2) or how to keep or withdraw
  the consent for a re-confirmation (art. 62-3(2)). The notice topic keeps only
  the delivery settings, and a backend takes the whole `notices` block,
  `{ topic, copy }`, as its one notice setting.
  `validateNotificationTopicCatalog` reports a notice topic that declares
  `copy` or the `local` channel, carries a title or body in a mapping, even one
  alone, or maps to a provider that sends a host template or its mapping's own
  text; and, by the platform's `notificationNoticeCopyIssues`, a missing
  `notices.copy`, or one without the default locale; a locale without one of
  the six required variants, an unknown variant, a blank title or body, a
  variant without `{{consentDate}}`, any other placeholder, and a brace outside
  one. Under the Korean rules it reports an advertising topic mapped to a
  provider that sends its mapping's own text, which cannot carry the notice
  topic, once, at that mapping. Issue paths spell locale and variant keys in
  brackets, shape issues name the public types, and an undefined
  `notices.copy` entry, topic `copy` entry, or target mapping is an issue
  rather than an exception. The free-form text rule does not ask the notice
  topic for copy. A catalog that gave its notice topic its own copy moves that
  text into `notices.copy`, one entry per variant; no released version had
  notice topics, since they arrive in this same release. — Thanks @imjlk!
- [5889d88a](https://github.com/imjlk/mpgd-kit/commit/5889d88a16b45e8b304ca509723d4913da39bfcd) `@mpgd/catalog` adds the notification topic catalog:
  `NotificationTopicCatalog` types (`version`, `defaultLocale`, an optional
  `notices` block, `{ topic, copy }`, which names the topic consent notices go
  out through and gives their copy, and topics with `id`, `purpose`,
  `channels`, `route`, `optOutRoute`, `copy` per locale, optional `frequency`,
  `quietHours`, and `deferrable`, and open-keyed `targets` mappings),
  `validateNotificationTopicCatalog` and `assertNotificationTopicCatalog`, which
  report every issue with its path: routes that stay on the game's origin and
  never resolve to a protocol-relative path, an `optOutRoute` and no `local`
  channel for advertising topics, the default locale in every `copy`, matched
  without regard to case, a notice topic that is a declared remote `service`
  topic, and, for targets with a provider registry entry, each mapping field's
  rule (required, length, accepted values such as the Apps in Toss `agreement`,
  and patterns such as the Devvit `link`, read with the `u` flag; a pattern that
  does not compile is an issue, not an exception), no agreement only for
  `service` templates and never on a per-send provider, a topic with the remote
  channel only on providers whose purposes include its purpose, advertising only
  on providers that deliver it as free-form content (with an expiry and the
  opt-out action under the Korean rules), and the text a free-form provider
  shows. Given the deployment settings, a catalog with an advertising topic
  needs `advertisingRules`, and under the Korean rules the notice topic and an
  advertising sender and opt-out line that the policy gate can use: no blank
  contact, name, or opt-out line. It also re-exports
  `isRootRelativeNotificationRoute` from `@mpgd/platform/notifications` and adds
  `resolveNotificationTopicsForTarget`. The root `pnpm validate:notifications
  [catalog] [deployment]` checks a catalog file against the reference Android,
  iOS, Apps in Toss, and Devvit targets and the deployment settings file. The
  kit ships no topic catalog of its own; the starter topics' purposes are still
  undecided. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.23.0

## 0.9.3 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.22.0

## 0.9.2 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.21.0

## 0.9.1 — 2026-10-12

### Patch changes

- Updated dependencies: platform@0.20.0

## 0.9.0 — 2026-10-11

### Minor changes

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

### Patch changes

- Updated dependencies: platform@0.19.0

## 0.8.1 — 2026-10-11

### Patch changes

- Updated dependencies: platform@0.18.0

## 0.8.0 — 2026-10-09

### Added

- [8cd3e3f8](https://github.com/imjlk/mpgd-kit/commit/8cd3e3f81d49235bd537a02ac97ac157f6b40f5b) Add ONE play rewarded advertisements with authenticated server request issuance, raw-byte HMAC SSV verification, durable callback bindings and backend ledger recovery. Keep client callbacks as correlation evidence and quarantine uncertain native presentations. Allow explicit same-format physical placement sharing for selected catalog targets. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.17.0

## 0.7.8 — 2026-10-09

### Patch changes

- [2d35eb0e](https://github.com/imjlk/mpgd-kit/commit/2d35eb0ecd89eef1058e4b9983eb284f7ba38adc) Add a CrazyGames web target and the browser adapter's `/crazygames` entry point with official v3 SDK initialization, loading/gameplay reporting, and interstitial ads using the shared presentation contract. Basic Launch keeps monetization disabled; Full Launch enables configured interstitial placements. Rewarded ads and purchases remain unavailable pending independent backend verification. Generated starters enter free play directly and retain scene, lifecycle, and native presentation ownership through game-owned gameplay scopes. — Thanks @imjlk!
- Updated dependencies: platform@0.16.0

## 0.7.7 — 2026-10-09

### Patch changes

- Updated dependencies: platform@0.15.0

## 0.7.6 — 2026-09-28

### Patch changes

- Updated dependencies: platform@0.14.0

## 0.7.5 — 2026-09-25

### Patch changes

- Updated dependencies: platform@0.13.0

## 0.7.4 — 2026-09-24

### Patch changes

- Updated dependencies: platform@0.12.2

## 0.7.3 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.12.1

## 0.7.2 — 2026-09-02

### Patch changes

- Updated dependencies: platform@0.12.0

## 0.7.1 — 2026-08-29

### Patch changes

- Updated dependencies: platform@0.11.0

## 0.7.0 — 2026-08-26

### Added

- [17cbec9](https://github.com/imjlk/mpgd-kit/commit/17cbec9de406aae06949b1c9df832f3ae0446b95) Add provider-neutral inline banner placements and surface lifecycle methods. Apps in Toss hosts now
  initialize and attach Toss banner ads by game-owned surface ID, report rendered/no-fill/failure
  states, and destroy active attachments on unmount. Target configuration, effective artifacts,
  starter validation, and bridge contracts understand optional `bannerAds` capability flags while
  remaining compatible with previously published adapters and target matrices. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.10.0

## 0.6.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.9.0

## 0.5.2 — 2026-08-04

### Changed

- [6ae2720](https://github.com/imjlk/mpgd-kit/commit/6ae27206b4aaae601c7feaa4ca7946b7cad5c654) Allow safe game-owned `kind: "web"` target names in build, smoke, and matrix CLI workflows while preserving the existing browser and web aliases. Support additive game-owned target-config policies at build time and runtime, monetization identifiers, authoritative purchase and reward verification for custom deployments, verified non-installable browser artifacts, and bounded static web artifact overlays for custom browser deployments while reserving platform-specific PWA policy for its canonical target. — Thanks @imjlk!

## 0.5.1 — 2026-07-23

### Patch changes

- Updated dependencies: platform@0.8.0

## 0.5.0 — 2026-07-17

### Added

- [4307985](https://github.com/imjlk/mpgd-kit/commit/4307985f02743278703cb87abb835ed14a92d5d9) Add validated generic consumable resource product grants, preserve them through current and legacy authoritative ledger transactions, and keep unsupported resource products out of Verse8 shops and effective target configurations. — Thanks @imjlk!
- [760cdec](https://github.com/imjlk/mpgd-kit/commit/760cdecb3f419a65d1a392b8758d7b73cac7ab5f) Add a fail-closed Verse8 VXShop client boundary and an Agent8 server helper that applies catalog grants once under a per-account lock without trusting client purchase callbacks or metadata. — Thanks @imjlk!
- [eab89e5](https://github.com/imjlk/mpgd-kit/commit/eab89e540d20deb423089aec639881376b419d65) Add Verse8 rewarded and interstitial ad support with versioned client evidence, consume-once server verification, target-specific Worker routing, and ledger-authoritative rewards. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.7.0

## 0.4.0 — 2026-07-15

### Added

- [6888e52](https://github.com/imjlk/mpgd-kit/commit/6888e52724788139fadb425459d92b5ed409cc4c) Allow game-owned Reddit product SKUs in product catalogs, mark Devvit IAP as
  target-supported, and gate commerce calls on the runtime IAP capability until
  a payments adapter is installed. Devvit artifact smoke checks validate payment
  endpoints and require products.json SKUs to match the effective game catalog. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.6.0

## 0.3.5 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

### Patch changes

- Updated dependencies: platform@0.5.1

## 0.3.4 — 2026-07-13

### Patch changes

- Updated dependencies: platform@0.5.0

## 0.3.3 — 2026-07-11

### Changed

- [84b3f83](https://github.com/imjlk/mpgd-kit/commit/84b3f836041c5c3513f3b2bf8b2c5414adfded0a) Allow games to define their own logical product and ad placement identifiers while preserving the starter identifiers as suggested literals. — Thanks @imjlk!

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
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

### Patch changes

- Updated dependencies: platform@0.1.0

