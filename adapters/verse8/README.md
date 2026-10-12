# @mpgd/adapter-verse8

Verse8 iframe platform adapter for mpgd games.

| Entry point | Purpose |
| --- | --- |
| `@mpgd/adapter-verse8` | `createVerse8PlatformGateway`, VXShop commerce provider, ads provider, catalog helpers |
| `@mpgd/adapter-verse8/agent8` | Agent8 server helpers: commerce service (`$onItemPurchased`), storage, verified leaderboard |
| `@mpgd/adapter-verse8/server` | Backend-side Verse8 ads evidence verifier |

## Commerce

The gateway has at most one commerce surface, `gateway.commerce`, a commerce v2 `CommerceProvider`
(`createVerse8CommerceProvider`). `createVerse8PlatformGateway({ vxShop: { purchaseEventAuthority:
'agent8-server', products, purchases } })` installs it and reports its block as
`getCapabilities().commerce`; without it the gateway sells nothing, has no `commerce`, and reports
`createUnsupportedCommerceCapabilities()`. The VXShop dialog never grants: the Agent8
`$onItemPurchased` event is the record, and the backend ledger decides. Games purchase through
`@mpgd/game-services`; see the [Verse8 commerce guide](../../docs/VERSE8_COMMERCE.md).

## Migrating from v1

| Removed | Replacement |
| --- | --- |
| v1 `gateway.commerce` (`getProducts`, `purchase`, `restore`, `getEntitlements`, a failing stub without `vxShop`) | `gateway.commerce`, the provider (absent without `vxShop.purchases`) |
| `gateway.commerceV2` | `gateway.commerce` |
| `Verse8CommerceOptions.loadEntitlements` | None; read the backend ledger, or your Agent8 snapshot method in game code |
| `Verse8CommerceOptions.purchases` optional | Required: the provider is the only commerce path |
| `capabilities.nativeIap`, `capabilities.subscriptionIap` | `capabilities.commerce` |
