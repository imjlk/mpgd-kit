# @mpgd/adapter-browser

Browser preview platform adapter for mpgd games, plus the web-store targets that reuse it as a base:
Microsoft Store PWAs, CrazyGames, and ONE play.

| Entry point | Purpose |
| --- | --- |
| `@mpgd/adapter-browser` | `createBrowserPlatformGateway`: local preview gateway (storage, share, launch intent, lifecycle) |
| `@mpgd/adapter-browser/microsoft-store` | Digital Goods commerce provider for Store-installed PWAs ([guide](../../docs/MICROSOFT_STORE_COMMERCE.md)) |
| `@mpgd/adapter-browser/microsoft-store-native` | WebView2 native host bridge for the Microsoft Store provider ([guide](../../docs/microsoft-store-native-host.md)) |
| `@mpgd/adapter-browser/crazygames` | CrazyGames gateway, interstitial ads only ([guide](../../docs/CRAZYGAMES.md)) |
| `@mpgd/adapter-browser/oneplay` | ONE play H5 gateway, ads and server-gated purchases ([guide](../../docs/ONEPLAY.md)) |

## Commerce

Every gateway here exposes at most one commerce surface: `gateway.commerce`, a commerce v2
`CommerceProvider` from `@mpgd/platform/commerce`. A gateway that sells nothing omits it and reports
`createUnsupportedCommerceCapabilities()` in `getCapabilities().commerce`. Games purchase through
`@mpgd/game-services`, whose reconciler drives the provider; a scene never calls it directly and a
provider result never grants anything on its own.

- **Default browser gateway** (and CrazyGames): no `commerce` provider and `commerce.availability:
  'unsupported'`, so it can never be mistaken for a ledger authority.
- **`createBrowserPlatformGateway({ mockCommerce: true })`**: a local-demo opt-in. `gateway.commerce`
  is a one-product provider (store id `browser-mock`, consumable `COINS_100`, `finish: 'none'`,
  `authority.evidence: 'client-token'`) whose `requestPurchase` answers `purchased` with a mock
  `transactionId` and `token` and `mpgd.browser.mock-purchase.v1` evidence. Rewarded ads resolve
  `rewardGranted: false` with `mpgd.browser.mock-reward.v1` evidence. Neither schema is accepted by
  any backend claim API, so no code path here can grant, even if the opt-in ships by accident.
- **Microsoft Store**: `createMicrosoftStoreCommerceProvider` and `withMicrosoftStoreCommerceProvider`.
  `createMicrosoftStoreCommerceCapabilities(availability)` is the pure capability declaration.
- **ONE play**: `createOnePlayCommerceProvider` (store id `oneplay`), installed by
  `createOnePlayPlatformGateway`. `createOnePlayCommerceCapabilities(input)` is the pure capability
  declaration.

## Migrating from v1

The v1 `CommerceAdapter` surface (`getProducts`, `purchase`, `restore`, `getEntitlements`) and the
boolean capabilities (`nativeIap`, `subscriptionIap`, `providerAvailability.nativeIap`) are removed.

| Removed | Replacement |
| --- | --- |
| `gateway.commerce` as a v1 `CommerceAdapter` (every gateway) | `gateway.commerce` is an optional commerce v2 `CommerceProvider`; omitted where nothing is sold |
| `gateway.commerceV2` | `gateway.commerce` |
| `capabilities.nativeIap`, `capabilities.subscriptionIap`, `providerAvailability.nativeIap` | `capabilities.commerce` (`availability`, `purchase`, `lifecycle`, `authority`) |
| Default browser gateway's failing `commerce` stub (`getProducts` empty, `purchase` failed) | No provider; the unsupported commerce block |
| `mockCommerce` v1 adapter (`getProducts`, `purchase` completed, `getEntitlements` empty) | The `browser-mock` provider (`fetchProducts`, `requestPurchase` answering `purchased`) |
| `createMicrosoftStoreCommerceAdapter(input)` | `createMicrosoftStoreCommerceProvider(input)` |
| `withMicrosoftStoreCommerceAdapter(gateway, adapter, options)` | `withMicrosoftStoreCommerceProvider(gateway, provider, options)` |
| `MicrosoftStoreCommerceAdapter`, `CreateMicrosoftStoreCommerceAdapterInput` | `MicrosoftStoreCommerceProvider`, `CreateMicrosoftStoreCommerceProviderInput` |
| `MicrosoftStorePurchaseAuthority.getEntitlements()` | None; entitlements come from the backend ledger (delete the method) |
| `createOnePlayCommerceAdapter({ sdk, products, server })` | `createOnePlayCommerceProvider({ sdk, products, server })` |
| `OnePlayCommerceServerPort.getEntitlements` and `restore` | None; read the backend ledger, and keep server-record restore a game-owned backend concern |
| CrazyGames and WeChat `commerce` stubs | No provider; the unsupported commerce block |
| v1 `purchase()` results (`completed`, `pending`, `failed`, `cancelled`, `authoritativeGrant`) | `requestPurchase()` outcomes (`purchased`, `launched`, `failed`, `cancelled`) with a `settlement` pointer only for adapter-settled stores |

Games that went through `@mpgd/game-services` need no call-site changes: its client already
purchases through the provider, and with no provider `purchase()` answers `rejected` without opening
any store UI.
