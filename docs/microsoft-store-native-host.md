# Microsoft Store native host bridge

The Microsoft Store Digital Goods API works inside a Store-installed Edge-hosted PWA. It does
not create the User Collections ID needed by an authoritative service to verify and consume a
purchase. A Windows host can create that ID with
`Windows.Services.Store.StoreContext.GetCustomerCollectionsIdAsync` and can expose the remaining
Store operations when a game is hosted in WebView2 instead of the Edge hosted-app model.

`@mpgd/adapter-browser/microsoft-store-native` defines the web half of that host contract. It uses
`window.chrome.webview.postMessage`-compatible messages and adapts the native catalog and purchase
operations to `createMicrosoftStoreCommerceAdapter`. The game still sends purchase evidence to its
authoritative backend; the native callback never grants a product by itself.

## Host requirements

The native host must enforce all of these rules before handling a bridge request:

- Navigate only to the configured HTTPS game origin and reject messages from every other source.
- Keep a fixed allowlist of the parent app and add-on identities. Do not accept an arbitrary Store
  ID or product kind from web content.
- Execute Store UI calls on the owning window's UI thread and initialize `StoreContext` with that
  window before a call that can display UI.
- Never log, persist in plaintext, or attach telemetry to the Entra service ticket or returned User
  Collections ID.
- Return only the fields defined below. Provider diagnostics remain in native logs with secrets
  removed.
- Map a cancelled Store purchase to `not-purchased`; do not turn cancellation into a grant.

## Protocol

Every request contains:

```json
{
  "protocol": "mpgd.microsoft-store.native.v1",
  "requestId": "unique-request-id",
  "method": "catalog.getDetails",
  "payload": {}
}
```

The response repeats `protocol`, `requestId`, and `method`. Success uses
`{ "ok": true, "result": ... }`; failure uses
`{ "ok": false, "errorCode": "SANITIZED_NATIVE_CODE" }`.

Supported methods are:

| Method | Payload | Result |
| --- | --- | --- |
| `catalog.getDetails` | `{ itemIds: string[] }` | `{ items: { itemId, title, description?, price: { currencyCode, formatted } }[] }` |
| `purchase.request` | `{ itemId: string }` | `{ status, purchaseToken? }` |
| `purchase.list` | `{}` | `{ items: { itemId, purchaseToken }[] }` |
| `identity.getCustomerCollectionsId` | `{ serviceTicket, publisherUserId }` | `{ userStoreId }` |

The `status` field in the `purchase.request` response is one of `succeeded`,
`already-purchased`, `not-purchased`, `network-error`, or `server-error`, matching the meaningful
`StorePurchaseStatus` outcomes.

The host obtains product metadata and current ownership from `StoreContext`, using the configured
developer-managed consumable allowlist. Microsoft Digital Goods uses the add-on product ID as its
`purchaseToken`, so the host must return the same allowlisted value for `itemId` and
`purchaseToken`; the bridge rejects a mismatch. This token is not transaction-unique. The backend
must query Microsoft Collections, claim the exact provider purchase idempotently, grant the game
ledger, and consume the entitlement.

## User Collections ID handoff

The game first authenticates its own stable player. Its backend returns a short-lived Entra access
token scoped only to the Store collections-key creation audience. The web client then calls:

```ts
const userStoreId = await bridge.getCustomerCollectionsId({
  serviceTicket,
  publisherUserId: authenticatedPlayerId,
});
```

The native host passes both values to `StoreContext.GetCustomerCollectionsIdAsync`. The web client
returns the result immediately to the trusted account-link service. That service validates the
embedded publisher user ID and client ID and proves the opaque key with Microsoft Collections
before persisting it. The general game API must never expose the stored key again.

This contract does not make a PWABuilder hosted package native. A game that selects this path still
needs a signed WinUI/WebView2 package, Windows acceptance tests, and a Store-installed end-to-end
purchase test before commerce can be enabled.
