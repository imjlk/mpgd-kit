---
npm/@mpgd/cli: minor
npm/@mpgd/create-game: minor
---

Commerce v2, PR C3: generated games wire every store provider from the
catalog, and `mpgd target init capacitor --providers` installs the native
store plugins.

- Template wiring. `src/platform/buildGateways/capacitorAndroid.ts` registers
  `createCapacitorPlayBillingServiceProvider` and `capacitorIos.ts` registers
  `createCapacitorStoreKitServiceProvider` for the one-time catalog products
  with an `android` or `ios` SKU (`src/platform/commerceProducts.ts`), bound
  through the reference `src/platform/commerceAccountBinding.ts` (Play: the
  hex SHA-256 of `mpgd-commerce-account:<playerId>`; StoreKit: the same
  digest as a version 5 UUID; a guest binds nothing). A shell built without
  the native plugin still runs and the store answers
  `configuration-required`. `reddit.ts` passes `commerce` to the Devvit
  gateway from the catalog's `reddit` SKUs, `verse8.ts` passes
  `vxShop.purchases` from the game's Agent8 client (`verse8Agent8Client.ts`,
  absent by default, so VXShop stays off), and `microsoftStore.ts` uses
  `withMicrosoftStoreCommerceProvider` with the catalog's consumables. The
  Apps in Toss wrapper installs `iapProducts` from the catalog, and the
  Devvit server serves `createDevvitCommerceV2BridgeHandler` only when
  `devvit.json` sets `permissions.payments` and `payments.endpoints.fulfillOrder`
  and the catalog names a Reddit SKU (the shipped `devvit.json` keeps it off). New games depend on
  `@mpgd/capacitor-play-billing` and `@mpgd/capacitor-storekit`.
- Game services. `createStarterGameServices` runs the commerce v2 reconciler
  over `createStorageMonetizationOperationStore`
  (`src/platform/monetizationJournal.ts`), the reference durable journal over
  `gateway.storage` (serialized compare-and-swap, `listRecoverable`,
  `listGranted`, `findByTransaction`, terminal records kept for 30 days and
  at most 100, an unreadable document never replaced), unless the game
  passes its own `operationStore`, and hands the catalog kinds and SKUs to
  the reconciler as `commerceProducts`. With a journal always present,
  versioned rewarded display is no longer policy-disabled by default;
  grants still come only from the backend ledger.
- `mpgd target init capacitor --providers play-billing,storekit` pins one
  exact plugin version in the game-owned shell and the game (the game's
  installed copy, else the version this CLI ships with), lets `cap add` or
  `cap sync` register it, records it under `providers` in
  `mpgd.native-shell.json`, and replaces an unwired template gateway with the
  wired one (writing `commerceProducts.ts` and `commerceAccountBinding.ts`
  when missing); a game-owned gateway is never rewritten and gets a warning.
  It refuses a store id without its native target, a declared but
  uninstalled plugin, a shell pinned to another version than the game, and
  an installed plugin whose kit peers the game does not satisfy. The dry run
  lists every file it would write and the plugins it would install. Other
  provider ids stay selection metadata, and `--providers` is now refused
  with a clear message for every target other than `capacitor`.
