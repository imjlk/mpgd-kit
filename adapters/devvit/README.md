# @mpgd/adapter-devvit

Reddit Devvit Web platform adapter for mpgd games.

| Entry point | Purpose |
| --- | --- |
| `@mpgd/adapter-devvit` | `createDevvitPlatformGateway`, the oRPC bridge and sandbox bridge, the commerce provider and catalog helpers |
| `@mpgd/adapter-devvit/payments` | `normalizeDevvitCommerceProducts` and the checkout types |
| `@mpgd/adapter-devvit/server` | `createDevvitCommerceV2BridgeHandler`, payment-order normalizers, durable post operations, Redis stores |
| `@mpgd/adapter-devvit/web` | Webview helpers, including `createDevvitWebPaymentsClient()` over `purchase()` from `@devvit/web/client` |
| `@mpgd/adapter-devvit/surface`, `/view-mode` | Inline and expanded view-mode helpers |

## Commerce

The gateway has at most one commerce surface, `gateway.commerce`, a commerce v2 `CommerceProvider`
(`createDevvitCommerceProvider`). `createDevvitPlatformGateway({ commerce: { products, client } })`
installs it and reports its block as `getCapabilities().commerce`; without the option the gateway
sells nothing, has no `commerce`, and reports `createUnsupportedCommerceCapabilities()`. Reddit
settles a purchase on the server, so only the backend ledger the fulfillment handler writes grants
anything. Games purchase through `@mpgd/game-services`; see the
[Devvit commerce guide](../../docs/DEVVIT_COMMERCE.md).

## Migrating from v1

| Removed | Replacement |
| --- | --- |
| `createDevvitCommerceAdapter`, `withDevvitCommerceAdapter`, `CreateDevvitCommerceAdapterInput` | `createDevvitPlatformGateway({ commerce })` or `createDevvitCommerceProvider` |
| v1 `gateway.commerce` (`getProducts`, `purchase`, `restore`, `getEntitlements`) | `gateway.commerce`, the provider (absent when nothing is sold) |
| `gateway.commerceV2` | `gateway.commerce` |
| `DevvitPaymentsClient.getEntitlements()` | The backend ledger (`listActiveEntitlementTransactions` on the server); the client is only `purchase(sku)` |
| `capabilities.nativeIap`, `capabilities.subscriptionIap` | `capabilities.commerce` |
| Bridge methods `commerce.getProducts`, `commerce.purchase`, `commerce.restore`, `commerce.getEntitlements` | `UNSUPPORTED_METHOD`; the six `commerce.v2.*` methods |
