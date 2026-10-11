# Verse8 VXShop and Agent8 Commerce

Verse8 commerce has two deliberately separate halves:

- The iframe client opens VXShop and returns `pending`.
- Agent8 Game Server receives the reserved `$onItemPurchased` event and applies
  the catalog grant exactly once.

Never treat `VXShop.onClose`, a client callback, client metadata, or a
client-created transaction ID as purchase evidence. VXShop product IDs must be
registered in the Verse8 dashboard and must exactly match the corresponding
`platformProductIds.verse8` values in the game-owned catalog.

VXShop requires a launched or private-launched Verse8 game, CPP membership,
and an Agent8 Game Server. See the current [Verse8 documentation](https://docs.verse8.io/)
before enabling production commerce.

## Agent8 server boundary

Install the official server builder only in the Agent8 server project. Do not
add it to a pure mpgd package or import it from Phaser scenes.

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "gameserver-node build",
    "test": "gameserver-node test",
    "dev": "gameserver-node dev"
  },
  "dependencies": {
    "@mpgd/adapter-verse8": "^0.2.0",
    "@mpgd/catalog": "^0.5.0"
  },
  "devDependencies": {
    "@agent8/gameserver-node": "0.1.13"
  }
}
```

Wire the adapter helper only to the platform-provided Agent8 globals:

```ts
import type { ProductCatalog } from '@mpgd/catalog';
import catalogJson from '@mpgd/catalog/catalog.json';
import {
  createVerse8Agent8CommerceService,
  type Verse8Agent8PurchaseEvent,
} from '@mpgd/adapter-verse8/agent8';

const commerce = createVerse8Agent8CommerceService({
  catalog: catalogJson as ProductCatalog,
});

const context = {
  getUserState: (account: string) => $global.getUserState(account),
  updateUserState: (account: string, state: Readonly<Record<string, unknown>>) =>
    $global.updateUserState(account, state),
  lock: <T>(key: string, callback: () => T | Promise<T>) => $lock(key, callback),
};

export class Server {
  // `$onItemPurchased` is a reserved Verse8 system event. Do not expose the
  // grant helper through another remotely callable method.
  async $onItemPurchased(event: Verse8Agent8PurchaseEvent) {
    return commerce.handleItemPurchased(event, context);
  }

  // This method only reads the authenticated sender's server-owned state.
  async getMpgdCommerceSnapshot() {
    return commerce.getSnapshot($sender.account, context);
  }
}
```

The helper applies these controls:

- maps the platform product to a catalog grant and ignores event metadata;
- validates positive safe-integer purchase IDs and quantities;
- serializes purchases per account with `$lock`;
- writes the grant and purchase-ID-indexed permanent marker in one user-state update;
- returns the stored result for an identical retry;
- rejects purchase-ID collisions and malformed stored state.

Currency balances live under the configurable `mpgdVerse8Commerce` user-state
namespace. If a game uses a different economy model, migrate that namespace or
keep this helper disabled until an equally atomic game-owned grant path exists.

## Iframe client boundary

The default Phaser starter intentionally does not install the React-based
Agent8 browser SDK. Provide a game-owned remote client at the app/adapter
boundary, then configure the gateway:

```ts
import {
  createVerse8CommerceProducts,
  createVerse8PlatformGateway,
} from '@mpgd/adapter-verse8';
import type { ProductCatalog } from '@mpgd/catalog';
import catalogJson from '@mpgd/catalog/catalog.json';

const gateway = createVerse8PlatformGateway({
  vxShop: {
    purchaseEventAuthority: 'agent8-server',
    products: createVerse8CommerceProducts(catalogJson as ProductCatalog),
    async loadEntitlements() {
      const snapshot = await gameOwnedAgent8Client.call('getMpgdCommerceSnapshot');
      return snapshot.entitlements;
    },
  },
});
```

The `nativeIap` capability remains false until this explicit configuration is
present. `purchase()` opens VXShop only inside an iframe, checks the live shop
item, and returns `pending` without an entitlement or transaction ID. The
GameServices client forwards that pending state but never sends Verse8
purchases to its external store verifier; Agent8 remains the sole purchase
authority.

Use `getMpgdCommerceSnapshot` (or an equivalent authenticated read method) to
refresh server-owned balances and entitlements after the platform purchase
event has arrived. Do not poll `VXShop.onClose` as proof of completion.

## Commerce v2 provider

> **Not yet usable in production before C2.** The backend side of the
> server-push lookup (a verifier registered for `verse8.agent8-event.v1` that
> answers `granted` once the Agent8 record exists and `pending` otherwise) is
> C2 work. Today `@mpgd/game-services` registers no verifier for that schema
> and `GameServicesStoreTarget` does not accept the `verse8` target, so a
> verify request for a Verse8 purchase is refused instead of answering
> `pending`; a journal record would end rejected, not granted. Configure
> `vxShop.purchases` only once the backend can answer.

`createVerse8CommerceProvider(input)` from `@mpgd/adapter-verse8` is the
commerce v2 `CommerceProvider` (RFC:
[docs/specs/commerce/commerce-v2-rfc.md](specs/commerce/commerce-v2-rfc.md))
with `store: 'verse8'`. It drives the same VXShop client as the v1 adapter
(`products`, `client`, `init`, `canOpenShop`) and takes a `purchases` source:
the purchases the Agent8 server recorded, read through a game-owned
authenticated method. `createVerse8Agent8CommerceService` now exposes
`listPurchases(account, context)` for that read; expose it for the sender's
own account only, like `getMpgdCommerceSnapshot` above:

```ts
export class Server {
  async $onItemPurchased(event: Verse8Agent8PurchaseEvent) {
    return commerce.handleItemPurchased(event, context);
  }

  async listMpgdPurchases() {
    return commerce.listPurchases($sender.account, context);
  }
}
```

```ts
const gateway = createVerse8PlatformGateway({
  vxShop: {
    purchaseEventAuthority: 'agent8-server',
    products: createVerse8CommerceProducts(catalogJson as ProductCatalog),
    loadEntitlements: () => gameOwnedAgent8Client.call('getMpgdCommerceSnapshot')
      .then((snapshot) => snapshot.entitlements),
    purchases: {
      listPurchases: () => gameOwnedAgent8Client.call('listMpgdPurchases'),
    },
  },
});
```

With `purchases` configured the gateway exposes the provider as `commerceV2`
and adds the `commerce` capability block to `getCapabilities()` (with
`nativeIap` and `subscriptionIap` derived from it); without it only the v1
adapter is offered, exactly as before.

Capability block (`createVerse8CommerceCapabilities`), the RFC profile row:

- `purchase`: consumable and durable; no subscription, no quantity (VXShop
  buys one unit per dialog).
- `catalog`: products, no offers, no localized price (VX amounts).
- `lifecycle`: no `availablePurchases` (VXShop lists nothing a client could
  finish; the Agent8 record is the only list), `pending`, `restore`,
  `events`, `finish: 'none'`. The Agent8 event settles on the server, so the
  provider has no `finishTransaction`; a `granted` journal record moves
  straight to `finished`. `pending` is the server-side pending of a
  server-push store: the backend's lookup verifier answers `pending` until
  the Agent8 event wrote the record.
- `authority`: `evidence: 'server-push'`, `accountBinding: 'host'` (the
  account comes from the Agent8 event, never from the iframe).
- `availability`: `available` with products, `configuration-required`
  without.

Methods:

- `fetchProducts` refreshes VXShop and lists the configured products it
  offers, priced in VX (`storeSku` is the VXShop product id).
- `requestPurchase` refreshes the shop, checks the live item, and opens the
  dialog with `buyItem`; the answer is always `launched` because the dialog
  reports no result the client could trust. Outside the Verse8 iframe it
  fails with `CONFIGURATION_REQUIRED` (`VERSE8_SHOP_UNAVAILABLE`); an
  unlisted, unpurchasable, or limit-reached item with `ITEM_UNAVAILABLE`
  (`VERSE8_PRODUCT_NOT_LISTED`, `VERSE8_PRODUCT_NOT_PURCHASABLE`,
  `VERSE8_PURCHASE_LIMIT_REACHED`); a failed refresh with a retryable
  `STORE_UNAVAILABLE`. An unconfigured product fails before the dialog opens;
  a quantity above one is rejected by `assertRequestPurchaseSupported`.
- `getAvailablePurchases` is empty.
- `restorePurchases` re-reads the purchase source and emits `purchaseUpdated`
  once per recorded purchase not reported before: the Agent8 purchase id is
  `transactionId` and `token`, the evidence is `verse8.agent8-event.v1`
  `{ purchaseId, productId, quantity }`, and the account binding is
  `host-identity`. The `onPurchasesChanged` signal does the same and may carry
  the purchases it already knows (`Verse8PurchasesChange`); by default it is
  the VXShop dialog closing after a purchase (`VXShop.onClose` with
  `purchased: true`), which is a signal to re-read the server and never
  evidence. The signal is observed while a listener exists; the first
  listener triggers a re-read, so purchases recorded before it (or before a
  restart) are found then. A signal nothing was recorded for yet is followed
  by re-reads at `verse8PurchaseFollowUpDelaysMs` (1 s to 5 min, about nine
  minutes in all) until one finds a new record; after that window the
  reconciler's `restorePurchases` and the next signal are the readers. The
  provider emits no `purchaseError`.

The backend side of the lookup is the server-push verifier the RFC describes
for C2: a verify request carrying `verse8.agent8-event.v1` evidence
(`assertVerse8Agent8EventEvidence` validates the envelope) is `granted` when
the Agent8 record for that purchase id exists and `pending` otherwise. The
client never grants: the reconciler moves a purchase to `granted` only on
that answer.

`adapters/verse8/src/verse8-commerce-provider.conformance.test.ts` runs the
RFC vectors through `runCommerceConformanceVectors` with a fake VXShop and
Agent8 record, directly and through the gateway. `server-push-settlement`
passes with its fixture expectations; `event-before-listener`,
`purchase-client-finish`, `restart-before-verify`, and `revoked-after-grant`
run with expectations derived for the `verse8` id. `finish-failure-retry` is
skipped by the runner, `cancelled-and-failed` (no later `store.error` event)
and `purchase-pending-then-purchased` (store-side pending) are listed as not
applicable, and `adapter-settled` and the wallet vectors belong to other
profiles.
