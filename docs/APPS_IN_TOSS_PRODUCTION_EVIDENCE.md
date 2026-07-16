# Apps in Toss Production Evidence

`@mpgd/game-services/apps-in-toss-evidence-verification` connects Apps in Toss
purchase and rewarded-ad callback evidence to the existing authoritative
game-services verifier and replay-safe entitlement ledger.

The boundary does not import an Apps in Toss SDK or perform network requests.
The target wrapper collects versioned correlation evidence; the partner backend
injects server authorities. If the matching authority is absent, throws, returns
pending, or does not match the order/player/SKU or reward/player/placement, no
ledger grant is written.

## Purchase flow

Apps in Toss SDK 1.1.3 and later requires product-grant completion, and SDK
1.2.2 and later supports pending-order restoration. The recommended flow is:

1. `processProductGrant({ orderId })` creates an
   `apps-in-toss.iap.callback.v1` envelope with
   `createAppsInTossPurchaseCallbackEvidence()`.
2. The client sends the logical product, order id, authenticated player, and
   envelope to the game-services purchase endpoint.
3. The injected `AppsInTossPurchaseAuthority` uses the partner-server order
   status API. Its adapter must associate the lookup with the authenticated
   Toss login user and return that server-authenticated game player identity.
4. The verifier matches order id, player id, platform SKU, status, and status
   timestamp. Only `PURCHASED` and `PAYMENT_COMPLETED` are grantable.
5. The game-services ledger records the catalog grant with
   `apps-in-toss:purchase:<encoded-order-id>` as its authority identity.
6. Return `true` from `processProductGrant` only after the backend reports
   `verified: true`.

For a grant-server failure, return `false`. At the next launch, read
`getPendingOrders()`, submit each order with source `pending-order-restore`, and
call `completeProductGrant()` only after the backend accepts the ledger grant.
If completion itself fails, the same request can be retried: the ledger returns
the prior grant without duplicating it, after which completion can be attempted
again.

The authority maps order states as follows:

| Order state | Verifier decision |
| --- | --- |
| `PURCHASED`, `PAYMENT_COMPLETED` | verified after all identity matches |
| `ORDER_IN_PROGRESS`, `ERROR` | pending; retry without granting |
| `FAILED`, `REFUNDED`, `NOT_FOUND`, `MINIAPP_MISMATCH` | rejected |

The official order-status API base is `https://apps-in-toss-api.toss.im`; the
partner-server call requires mTLS, and status lookup requires Toss login
integration. Keep the mTLS certificate/private key, login tokens, user-key
mapping, base URL overrides, and transport configuration in the deployment
runtime. Do not commit them or include them in client bundles.

## Rewarded-ad flow

`userEarnedReward` is client evidence, not grant authority. The wrapper can use
`createAppsInTossRewardCallbackEvidence()` to correlate the callback with an
impression and configured placement, but the production backend must inject an
`AppsInTossRewardAuthority` that independently confirms:

- a stable consume-once authority event id;
- impression id;
- authenticated player id;
- configured platform placement id;
- verification timestamp.

Apps in Toss documents the client reward event but does not document a general
partner-server rewarded-ad callback endpoint. The package therefore does not
invent one. Games can adapt their approved server provider or existing
first-party reward authority to the port. Without that authority, reward claims
fail closed.

## Server assembly

```ts
import {
  createAppsInTossProductionEvidenceVerifier,
  createGameServicesBackend,
} from '@mpgd/game-services';

const backend = createGameServicesBackend({
  catalog,
  placements,
  store,
  evidenceVerifier: createAppsInTossProductionEvidenceVerifier({
    purchaseAuthority,
    rewardAuthority,
  }),
});
```

The authority adapters, authenticated session exchange, mTLS agent, secrets,
and endpoints are game/deployment responsibilities. The public contract remains
deterministic and transport-neutral.

## Conformance and sandbox

Run the credential-free contract suite locally and in CI:

```sh
pnpm smoke:apps-in-toss-production-evidence
```

It covers callback-only rejection, purchase success and idempotent retry,
server-grant failure followed by pending-order restoration, authoritative
player/SKU/status matching, reward retry/replay rejection, authority errors,
and reward player/placement matching. No failure path writes a ledger grant.

Before release, also run the Apps in Toss sandbox scenarios on a real test app:

1. purchase success through backend grant and SDK product-grant completion;
2. payment success with partner-server grant failure, relaunch restoration, and
   later `completeProductGrant()`;
3. cancellation, network error, internal error, authority timeout, and retry;
4. rewarded-ad callback with authority success, pending, rejection, replay, and
   authority outage.

Official references:

- [Apps in Toss in-app purchase](https://developers-apps-in-toss.toss.im/bedrock/reference/framework/%EC%9D%B8%EC%95%B1%20%EA%B2%B0%EC%A0%9C/IAP.html)
- [Apps in Toss integrated ads](https://developers-apps-in-toss.toss.im/bedrock/reference/framework/%EA%B4%91%EA%B3%A0/IntegratedAd.html)
- [Apps in Toss login](https://developers-apps-in-toss.toss.im/login/intro.html)
