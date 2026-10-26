# OpenIAP native engine for the Capacitor store plugins

`@mpgd/capacitor-storekit` and `@mpgd/capacitor-play-billing` run on the
[OpenIAP](https://github.com/hyodotdev/openiap) Apple and Google native cores
instead of their own StoreKit 2 and Play Billing code. The Capacitor surface,
the payloads, the evidence, and the finish responsibilities are those of the
0.3 plugins. This page records the pinned versions, the contract the swap
keeps, how each call maps onto OpenIAP, where the two engines differ and how
each difference is handled, what was verified, and what still needs a real
store before release.

Scope: single-unit consumable and non-consumable one-time purchases. No
subscriptions, no multi-quantity sales, no new stores, and no server change
(IAPKit or the Commerce Protocol are not used). The game backend still
verifies every receipt and owns every grant.

## Pinned versions and toolchain

| Component | Version | Source |
| --- | --- | --- |
| OpenIAP Apple | `4.0.5` (git tag `4.0.5`, `d1239c9a`) | SwiftPM `.package(url: "https://github.com/hyodotdev/openiap.git", exact: "4.0.5")` |
| OpenIAP Google | `4.0.6` (git tag `google-4.0.6`, `f6372aa2`) | Maven Central `io.github.hyochan.openiap:openiap-google:4.0.6` (Play flavor) |
| OpenIAP Client Protocol | `1.3.0` | carried by both cores (`openiap-versions.json`) |
| Capacitor | 8.5.2 | unchanged |
| iOS | deployment target 15, swift-tools 5.9, Swift 5 language mode | unchanged; OpenIAP Apple declares the same |
| Xcode / Swift used here | Xcode 26.6, Swift 6.3.3 | local verification; CI runs `macos-26` |
| Android | minSdk 24, compile/target 36 | unchanged; OpenIAP Google needs minSdk 23 |
| Play Billing | 9.1.0 | now OpenIAP's `api` dependency; the plugin no longer declares it |
| Kotlin | Gradle plugin 2.2.20 unless the shell sets `kotlin_version` | new; OpenIAP Google needs a 2.1.20+ compiler |
| JVM | Java/Kotlin bytecode 21 | matches `capacitor-android` |
| AGP / Gradle | 8.13.0 / 8.14.3 | the reference shell; unchanged |

These are the newest Apple and Google releases at the time of the change
(`gh release list -R hyodotdev/openiap`, 2026-10-26). No floating `main`,
`latest`, or version range is used. Change a pin only with the checks under
[Verification](#verification).

What the dependency adds to a consumer:

- iOS: SwiftPM clones the whole `hyodotdev/openiap` monorepo (about 240 MB of
  repository cache and a 94 MB checkout on a clean machine) and builds the
  `OpenIAP` target. On iOS below 16.4, creating the OpenIAP module registers
  a `SKPaymentQueue` observer for App Store promoted purchases; it finishes
  nothing.
- Android: `openiap-core`, Play Integrity 1.6.0, `core-common` 2.0.4,
  `androidx.core` 1.18.0, lifecycle 2.10.0, coroutines 1.11.0, Gson 2.14.0,
  and Compose runtime/UI 1.11.4 (OpenIAP's `IapContext`). The merged manifest
  gains `android.permission.INTERNET` and the
  `dev.hyo.openiap.PROVIDER` meta-data entry. In mpgd-games' Nep Nep Nem
  Nep wrapper a minified (R8) release APK grows from 1.65 MB with the 0.3.7
  plugin to 2.11 MB, and R8 keeps the provider factory and its interface
  (see [Verification](#verification)).

## Layers

| Layer | Owns | Files |
| --- | --- | --- |
| Game and shared commerce | logical products, purchase requests, pending state, reconciler, journal | unchanged (`@mpgd/game-services`, `@mpgd/adapter-capacitor`) |
| mpgd plugin TypeScript | `StoreSdk`, `CommerceProvider`, account filters, evidence | unchanged (`src/*.ts`) |
| mpgd native policy | which transactions are reported, the 0.3 payload shapes, the finish gate, error codes | `StoreKitTransactionPolicy.swift`, `PlayBillingPolicy.kt` |
| Store-neutral binding | provider selection and check, connection, the single listener, lifecycle | `OpenIapAppleConnection.swift`, `OpenIapPlayConnection.kt` |
| Capacitor bridge | method parsing, call resolution, events | `CapacitorStoreKitPlugin.swift`, `CapacitorPlayBillingPlugin.kt` |
| OpenIAP core | StoreKit 2 / Play Billing calls | `OpenIapModule` (Apple), `OpenIapStore` (Google) |
| Game backend | receipt verification, account binding, idempotent ledger, Play consume/ack | unchanged |

On iOS the policy and binding live in a `MpgdStoreKitBridge` target with no
Capacitor dependency, so its XCTests run on a Mac host. On Android the policy
is a plain Kotlin object tested on the JVM.

## Contract kept

| Surface | Kept |
| --- | --- |
| Packages, registration names | `@mpgd/capacitor-storekit` / `CapacitorStoreKit`, `@mpgd/capacitor-play-billing` / `CapacitorPlayBilling` |
| iOS methods and event | `getProducts`, `purchase`, `getTransactions`, `sync`, `finishTransaction`, `transactionUpdated` |
| Android methods and event | `getProducts`, `purchase`, `getPurchases`, `purchaseUpdated` (retained until a listener consumes it) |
| TypeScript exports | factories, plugin types, error maps, authority, evidence schemas, product mapping types: no TypeScript source changed |
| Error codes | the 0.3 `STOREKIT_*` and `PLAY_BILLING_*` codes only; no new code |
| Apple ids | transaction id and original transaction id as strings; the StoreKit-verified JWS as `signedTransaction` |
| Google ids | `orderId` when Play assigned one, otherwise absent; the TypeScript SDK keeps the `play-token-sha256:<hex>` key and the token-to-order-id link |
| Evidence | `app-store.signed-transaction.v1`, `google-play.product-purchase.v2` (`{ purchaseToken }`) |
| Account binding | `appAccountToken` (lowercased UUID), `obfuscatedAccountId`; the TypeScript filters for the session account |
| Other fields | product id(s), one-time type, quantity, purchase time, currency/price/offer, pending and revocation state; the legacy Play names `state`, `productIds`, `purchaseTimeMillis` are still decoded by the TypeScript SDK |
| Journal | operation keys, token-to-order-id linking, account scope, encrypted storage, restart recovery: untouched |
| Finish | Google Play `server` (the backend consumes/acknowledges), App Store `client` (after the ledger grant), Apps in Toss `host`, Devvit `none` |

Changes on `main` after the spec's baseline (`b428376e`) and how they bear
on this contract:

- L3a (#443) issues the guest session the bindings are derived from; the
  derivation (`mpgd-commerce-account:<playerId>`) and the native fields are
  unchanged.
- L3c (#445) verifies a purchase discovered without a journal with
  `intent: 'restore'`. On iOS those discoveries include the finished
  durables `getTransactions` lists from the current entitlements; the swap
  keeps that listing (`openiap-engine-swap.test.ts` case 4).
- L2 (#440) and L3b (#444) change only the backend.
- This change adds a second SwiftPM product name, `MpgdCapacitorStorekit`:
  `cap sync ios` links that spelling (Capacitor's `fixName` of the npm
  package name), and mpgd-games carried a pnpm patch for it.

## Call mapping

### iOS

| Plugin call | OpenIAP | mpgd policy on top |
| --- | --- | --- |
| load | `OpenIapModule(factory: OpenIapAppleProviderFactory())`, `initConnection()`, `purchaseUpdatedListener(_, options: dedupeTransactionIOS: false)` | provider must report `apple`; the listener forwards verified one-time purchases as `transactionUpdated` |
| `getProducts` | `fetchProducts(skus, .inApp)` | 1-100 valid ids; consumable and non-consumable only |
| `purchase` | `fetchProducts` (one-time check), `requestPurchase(.inApp, appAccountToken, andDangerouslyFinishTransactionAutomatically: false)` | result must match product and token; `userCancelled` → `cancelled`, `deferredPayment` → `pending`, failures after the sheet → `STOREKIT_PURCHASE_UNCERTAIN` |
| `getTransactions` | `getPendingTransactionsIOS()` + `getAvailablePurchases(onlyIncludeActiveItemsIOS: true)` | unfinished one-time → `unfinished: true`; current non-consumables not already listed → `unfinished: false`; merged by id; never `Transaction.all` |
| `sync` | `syncIOS()` (`AppStore.sync`) | user-initiated only; the reconciler's automatic passes never call it |
| `finishTransaction` | `getPendingTransactionsIOS()`, then `getAvailablePurchases(onlyIncludeActiveItemsIOS: false)`; `finishTransaction(purchase:isConsumable:)` | verified, one-time, not revoked, `appAccountToken` equals the session token; OpenIAP's own `storeId` check still runs |
| revocations | not delivered by OpenIAP 4.0.5 | `RevocationUpdatesShim` (below) |

### Android

| Plugin call | OpenIAP | mpgd policy on top |
| --- | --- | --- |
| load | `OpenIapProvider.factory(context)` (manifest discovery), `OpenIapStore(module)`, purchase update and error listeners | provider must report `play` |
| `getProducts` | `initConnection`, `fetchProducts(skus, InApp)` | skip unfetched placeholders; one-time offers without rental or pre-order details; product skipped when none |
| `purchase` | `fetchProducts`, `getAvailableItems(InApp)`, `requestPurchase(InApp, skus, offerToken, obfuscatedAccountId)` | explicit offer selection (the named one, or the only eligible one); a result whose token Play already reported → `PLAY_BILLING_ALREADY_OWNED`; a matched purchase resolves `purchased`/`pending`; an OpenIAP cancel → `cancelled`; 180 s call timeout → `PLAY_BILLING_TIMEOUT` with a late `purchaseUpdated` terminal event |
| `getPurchases` | `getAvailableItems(InApp)` (`queryPurchasesAsync(INAPP)`) | every purchased or pending in-app purchase, acknowledged ones included |
| events | `OpenIapPurchaseUpdateListener` | `{ status, purchase }`, retained for a late listener |
| finish | never: no `finishTransaction`, `acknowledgePurchaseAndroid`, or `consumePurchaseAndroid` call | the backend finalizer consumes or acknowledges after the grant |

## Differences between the engines and how each is handled

1. **Revocations (blocker in the spec).** OpenIAP Apple's update listener
   skips any transaction with a `revocationDate`
   (`OpenIapStoreKitModule.swift` line 2178 at `4.0.5`). The 0.3 plugin
   forwarded them with `revokedAt`, and `StoreSdk` maps them to
   `state: 'revoked'` so the server re-checks the grant.
   `RevocationUpdatesShim` observes `Transaction.updates` and forwards only
   verified, revoked, one-time transactions in the 0.3 shape. It never
   purchases, lists, or finishes; it is not a second payment engine. Remove
   it once OpenIAP can deliver revocations (upstream request 1).
2. **One-time type.** `PurchaseIOS` has no product type. The plugin reads the
   `type` claim (`Consumable` / `Non-Consumable`) of the JWS StoreKit already
   verified, the same claim the backend verifier checks
   ([`JWSTransactionDecodedPayload.type`](https://developer.apple.com/documentation/appstoreserverapi/type)).
   A missing or subscription claim drops the transaction, as the 0.3 filter
   dropped non-one-time transactions. Upstream request 2.
3. **Unverified or unreadable transactions fail the whole query.** OpenIAP's
   `getPendingTransactionsIOS` and `getAvailablePurchases` throw on the first
   unverified entry (`checkVerified`, line 2335); the 0.3 plugin skipped
   unverified entries and returned the rest. The plugin now rejects
   `getTransactions` (and a finish behind it) with
   `STOREKIT_TRANSACTION_UNVERIFIED`. A verified entry whose JWS has no
   readable `type` claim fails the query the same way
   (`STOREKIT_EVIDENCE_INVALID`) instead of being dropped. This fails closed: the game never reads
   a shortened list as "finished" (its finish recovery reads absence from the
   list), and the reconciler treats a failed read as retryable. The cost:
   while StoreKit cannot verify one transaction on a device (tampering, or a
   device clock StoreKit rejects), verified siblings on that device are not
   recovered either. **Maintainer decision:** accept this, or ask upstream
   for a verified-only read (upstream request 3) before shipping.
4. **Purchase results also reach the listener.** OpenIAP emits the result of
   `requestPurchase` to its update listener (line 607). The same transaction
   now arrives as the `purchase` result and as `transactionUpdated`; the
   reconciler journals it once, verifies once, and finishes once
   (`openiap-engine-swap.test.ts` case 1). Google Play behaved this way
   before.
5. **Replays.** The listener is registered with
   `dedupeTransactionIOS: false`, so every StoreKit replay is forwarded as
   the 0.3 `Transaction.updates` loop did; the reconciler deduplicates.
6. **Finish takes an id.** OpenIAP finishes whatever purchase it is handed
   and treats an unknown one as already finished (line 764). The plugin
   resolves the full verified purchase first and answers `finished: false`
   only when no purchase passes the gate, so finishing an already finished
   durable stays an idempotent `finished: true`. A finished consumable is
   found only where StoreKit still returns it (`Transaction.all` includes
   finished consumables only on iOS 18+ with
   `SKIncludeConsumableInAppPurchaseHistory`); otherwise it answers
   `finished: false` and the game checks the list and the server grant, as
   with the 0.3 plugin, which searched the same history.
7. **Purchase presentation.** On iOS 17+ OpenIAP calls
   `purchase(confirmIn:)` with the active window scene and fails before the
   sheet when there is none (line 2574); a Capacitor app always has one. When
   `AppStore.canMakePayments` is false (Screen Time, MDM) OpenIAP fails before
   the sheet (line 454): `STOREKIT_UNAVAILABLE`.
8. **Ask to Buy** is OpenIAP's `deferredPayment` and stays `pending`, never
   `cancelled`.
9. **Already owned (Google).** OpenIAP resolves `ITEM_ALREADY_OWNED` with the
   owned purchase (line 1993 at `google-4.0.6`) and delivers it to
   listeners. The plugin keeps the 0.3 rejection,
   `PLAY_BILLING_ALREADY_OWNED`, by comparing the result's token with the
   in-app purchases Play reported just before the flow; the owned purchase
   reaches JavaScript through `purchaseUpdated`, and the reconciler grants it
   once (`openiap-engine-swap.test.ts`, Play).
10. **Flow hold (Google).** OpenIAP holds a launched flow up to 15 minutes
    (line 255) and admits one at a time (line 218). The plugin's 180 s call
    timeout stays; after it, a new purchase answers `PLAY_BILLING_BUSY` until
    OpenIAP releases the flow, and the flow's cancel or failure is then sent
    as the late terminal `purchaseUpdated` event. The 0.3 plugin let a new
    purchase start right after its timeout.
11. **Order id (Google).** OpenIAP fills `Purchase.id` with the purchase
    token when Play has no order id (`BillingConverters.kt` line 324);
    `transactionId` stays null (line 341). The plugin reads `transactionId`,
    so the token is never reported as an order id. (The spec expected the
    canonical id to stay empty; the code fills it, and only `transactionId`
    keeps the distinction.)
12. **In-app only (Google).** `OpenIapStore.getAvailablePurchases` also
    queries subscriptions (`Helpers.kt` line 28). The plugin uses the
    provider's `getAvailableItems(InApp)` (line 2180), which the facade does
    not expose, so a subscription never enters the one-time recovery list.
13. **Product details (Google).** OpenIAP caches product details per
    connection for `fetchProducts`; every purchase flow queries them again,
    as Google recommends. A purchase now runs four Billing queries (product,
    owned purchases, OpenIAP's own ownership snapshot, product again).
14. **Connection failures (Google).** OpenIAP's `initConnection` answers
    `false` without the setup response code; the plugin reports
    `PLAY_BILLING_SERVICE_UNAVAILABLE` (the 0.3 plugin mapped the code, for
    example `BILLING_UNAVAILABLE` to `PLAY_BILLING_ERROR`). Both map to an
    unavailable store in TypeScript.
15. **Extra refresh (Google).** `OpenIapStore` re-reads owned purchases
    500 ms after every update (`OpenIapStore.kt` line 157). It only updates
    the facade's state; nothing is delivered or finished.
16. **iOS 15 currency.** OpenIAP reads the product currency from the
    product's price locale below iOS 16; the 0.3 plugin used
    `priceFormatStyle.currencyCode` on every version.
17. **Two update iterators (iOS).** OpenIAP's listener and the revocation
    shim each iterate `Transaction.updates`. StoreKit is expected to deliver
    every update to every iterator; if a device does not, an update the shim
    drops (any non-revoked one) reaches JavaScript only through the next
    `getTransactions`, which the reconciler runs on start and resume. Listed
    under [Not verified](#not-verified-and-release-conditions).
18. **OpenIAP finishes some subscription transactions itself.** The Apple
    core finishes inactive (expired, revoked, or upgraded) auto-renewable
    subscription transactions it meets. The plugins sell no subscriptions, so
    no one-time transaction is affected, but "nothing finishes outside
    `finishTransaction`" holds for one-time purchases only.

None of these changes recovery, account binding, or refund handling of a
verified transaction except item 3, which is listed for a maintainer
decision. No new payment capability (subscriptions, quantity) is enabled.

## Lifecycle

- **Owner.** Each plugin instance creates and owns one OpenIAP module and one
  listener registration; it never uses `OpenIapModule.shared` or another
  plugin's store. `deinit` (iOS) and `handleOnDestroy` (Android) remove the
  listener and end the connection; Android rejects an open purchase and any
  in-flight query with `PLAY_BILLING_INTERRUPTED`.
- **Initialization and reconnection.** `initConnection` runs at load and is
  idempotent; a failure there is not fatal, because every OpenIAP call
  ensures the connection again, and Play Billing auto-reconnects. Android
  releases its purchase slot on every path, failures included, so an error
  never leaves later purchases answering `PLAY_BILLING_BUSY`.
- **Listeners.** One native listener per plugin. The TypeScript SDKs attach
  the Capacitor listener with the first subscriber and detach it with the
  last; native forwarding continues, and Capacitor drops (iOS) or retains
  (Android) events without a listener, as before.
- **Before JavaScript is ready.** iOS does not retain events; a purchase made
  before the listener attaches is recovered by `getTransactions`. Android
  retains `purchaseUpdated` until a listener consumes it.
- **Account switch.** Late events are admitted against the session account at
  delivery time (unchanged TypeScript); another account's transaction is a
  diagnostic, never a grant or a finish.
- **Purchase sheet lifetime.** Neither core exposes a "sheet dismissed"
  signal. The plugins report results only; success, timeout, and app resume
  are not presented as the sheet closing. The game's presentation gate
  (`nativePurchasePresentation.ts`) is unchanged and its open item stays
  open.

## Verification

Kit, branch `claude/openiap-migration` (macOS 26, Xcode 26.6, JDK 22,
Android SDK 36):

| Check | Result |
| --- | --- |
| `pnpm --dir native-plugins/capacitor-storekit check` / `test` | pass, before and after |
| `pnpm --dir native-plugins/capacitor-play-billing check` / `test` | pass, before and after |
| `pnpm --dir adapters/capacitor test` | pass, before and after |
| `pnpm --dir packages/game-services test:recovery` (reconciler and conformance) | pass, before and after |
| `pnpm validate:commerce-alignment`, `validate:capacitor-alignment`, `validate:capacitor-fail-closed` | pass (the fail-closed checks now read the Swift and Kotlin sources) |
| `pnpm smoke:cli-capacitor-shell-starter`, `smoke:native-packed-consumer` | pass |
| `MPGD_STOREKIT_BRIDGE_TESTS=1 swift test` in `native-plugins/capacitor-storekit` | 16 XCTests pass on the Mac host |
| `swift build --target MpgdCapacitorStoreKit --triple arm64-apple-ios15.0-simulator` | pass |
| `./gradlew -PmpgdPlayBillingPluginTest=true :mpgd-capacitor-play-billing:testDebugUnitTest :mpgd-capacitor-play-billing:assembleRelease` (reference shell) | 11 JVM tests pass, release AAR built |
| `pnpm smoke:native-packed-store-plugins ios android` | packed Swift package compiles for the simulator; packed Gradle module assembles a release AAR |

The CI generic-simulator `xcodebuild` step could not run on this machine
(Xcode reports the iOS 26.5 platform component as not installed); the
equivalent SwiftPM simulator build passed, and `xcodebuild -list` shows the
`MpgdCapacitorStoreKit` scheme. CI's `macos-26` job runs the `xcodebuild`
step.

mpgd-games (`80dc56a0`, Nep Nep Nem Nep), same commands for three
dependency sets: the game's own 0.3.7 (patched), npm 0.3.9 (the last
published release before this change; 0.3.10 on `main` only bumps
dependencies), and the candidate tarballs packed from this branch. The
resolved packages were checked to be the candidates (OpenIAP sources present):

| Check | 0.3.7 | 0.3.9 | candidate |
| --- | --- | --- | --- |
| `pnpm --dir games/nepnepnemnep check` | pass | pass | pass |
| game vitest: `iosCheckout`, `androidCheckout`, `aitCheckoutRuntime`, `devvitCheckout`, `nativeCheckoutOwner`, `nativeMonetizationJournal` (59 tests) | pass | pass | pass |
| Worker vitest: `googlePlayCheckout`, `appStoreCheckout` (47 tests) | pass | pass | pass |
| `sync:android` + `:app:assembleDebug` | | | pass; Capacitor registered `dev.mpgd.capacitor.playbilling.CapacitorPlayBillingPlugin`; the APK has the plugin, the OpenIAP factory, and the provider meta-data |
| `:app:assembleRelease` with `minifyEnabled true` (temporary) | | | pass; R8 kept `OpenIapStoreFactory` implementing the (renamed) provider interface |
| `sync:ios` + simulator build of the App target | | | every Swift package (OpenIAP, the bridge, the plugin, `CapApp-SPM` through `MpgdCapacitorStorekit`) compiled and linked; the app link was not reached because storyboard compilation needs the iOS 26.5 platform component missing locally |
| `build:ait`, `smoke:ait`, `build:devvit`, `smoke:devvit` (`MPGD_KIT_PATH` = this branch) | | | pass; neither bundle registers `CapacitorStoreKit` or `CapacitorPlayBilling` or contains OpenIAP, and neither build needs Swift, Gradle, or a store toolchain |

### Regression matrix

| Case | Evidence |
| --- | --- |
| Old engine's unfinished transaction under the new engine | payload equality (Swift and Kotlin tests); `openiap-engine-swap.test.ts` case 3 (iOS journal in `finishing` finishes once), Play token-keyed journal resumes under the same key |
| Purchase result and event both arrive | case 1: one record, one verify, one finish |
| Grant then lost reply / app killed | case 3; game `iosCheckout` and `androidCheckout` suites |
| Pending / Ask to Buy | `deferredPayment` → `pending` (Swift test); existing StoreSdk tests; game suites |
| iOS unfinished consumable and finished durable | `testListedTransactionsKeepThe03Scope` |
| iOS query failure | `testQueryFailuresAreNeverAnEmptyList`; case 2 (no empty list, no `finished: false`) |
| iOS lost finish reply | game `iosCheckout` (list check plus a fresh server grant) |
| iOS revocation | shim; existing StoreSdk revoked-event tests; server re-verification unchanged |
| Google order id assigned later | Play case 1; reconciler test 46 |
| Google consume/ack failure after grant | server-owned, unchanged; Worker `googlePlayCheckout` |
| Late event during an account switch | existing StoreSdk account tests; game `nativeCheckoutOwner` |
| Sales stop or catalog change | existing unmapped/retired SKU tests; game suites |
| Devvit callback before fulfillment, AIT lost callback | game `devvitCheckout`, `aitCheckoutRuntime`; no JavaScript changed |
| Pre-listener purchase, duplicate init | lifecycle above; existing listener attach/detach tests |
| Packaged plugins and AIT/Devvit builds | packed smoke; mpgd-games native and web builds above |

TypeScript fixtures and native unit tests are mock-level evidence. Nothing
here ran a StoreKit or Play sandbox purchase.

## Not verified, and release conditions

These were open before the swap and stay release conditions for the game:

- A real purchase sheet, its presentation lifetime, background/restart,
  account switch, sandbox purchase, restore, and refund on an installed
  iPhone, iPad, and Android build.
- Apple verification from the game's Worker (the Cloudflare → Apple OCSP
  403 path) with online revocation checks kept.
- Google consume/ack retry when the app does not come back after a grant,
  and the refund path (RTDN, Voided Purchases) end to end.
- Store, server, and sales-gate settings for the release.
- A StoreKit Testing (`SKTestSession`) or Play sandbox run of the new engine
  itself: OpenIAP's purchase path needs a window scene, so it needs a host
  app rather than package tests.
- Whether every `Transaction.updates` iterator receives every update on
  devices (difference 17), checked with a delayed Ask to Buy approval and a
  refund while the app runs.
- The maintainer decision on difference 3.

## Rollback

Pin the game and its mobile wrapper back to the last verified plugin
versions (0.3.9 on npm, 0.3.10 once published, which has the same native
code; or 0.3.7 with the game's patch), run `sync:ios` and
`sync:android`, and rebuild the native apps; a web-bundle update alone does
not change the native engine. Journals, evidence schemas, and transaction ids
are the same in both engines, so an older build resumes every open purchase.
Running both engines side by side on the same transactions is not a
supported rollback.

## Upstream

[openiap-upstream-proposal.md](openiap-upstream-proposal.md) drafts the
proposal for a Capacitor binding in OpenIAP and the core changes that would
remove the shim and the workarounds above. Nothing has been filed upstream.
