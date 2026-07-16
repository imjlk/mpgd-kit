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
