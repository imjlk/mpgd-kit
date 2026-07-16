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

Apps in Toss SDK 1.1.3 and later requires product-grant completion. The current
`getPendingOrders()` support table requires WebView/RN SDK 1.4.8 and Toss app
iOS 5.231.0 or Android 5.235.0. Use those newer minimums when shipping the
pending-order recovery flow below.

1. Before calling `IAP.createOneTimePurchaseOrder()`, create an async boolean
   callback with `createAppsInTossProductGrantCallback()`.
2. The SDK invokes that callback as `processProductGrant({ orderId })`. It
   creates an `apps-in-toss.iap.callback.v1` envelope and awaits the
   game-services purchase endpoint before returning `true` or `false`.
3. The injected `AppsInTossPurchaseAuthority` uses the partner-server order
   status API. Its adapter must associate the lookup with the authenticated
   Toss login user and return that server-authenticated game player identity.
4. The verifier matches order id, player id, platform SKU, status, and status
   timestamp. Only `PURCHASED` and `PAYMENT_COMPLETED` are grantable.
5. The game-services ledger records the catalog grant with
   `apps-in-toss:purchase:<encoded-order-id>` as its authority identity.
6. Return `true` from `processProductGrant` only after the backend reports
   `verified: true`.

The SDK documents a 30-second product-grant window. The helper uses a 25-second
deadline by default, aborts the verification request, and returns `false` on
timeout. Its `purchaseVerification` port must carry the provided `AbortSignal`
through the transport and server-side ledger deadline so an aborted request
cannot commit a late grant. `timeoutMs` may only shorten the 25-second default.

The generic `createGameServicesClient().purchase()` flow verifies after
`gateway.commerce.purchase()` returns, so it cannot satisfy this callback
timing by itself. Wire the callback-specific API directly into the AIT SDK:

```ts
import { IAP } from '@apps-in-toss/web-framework';
import {
  createAppsInTossProductGrantCallback,
} from '@mpgd/game-services/apps-in-toss-evidence-verification';

const processProductGrant = createAppsInTossProductGrantCallback({
  purchaseVerification: abortAwarePurchaseVerification,
  playerId,
  productId: 'COINS_100',
  platformSku: 'ait.production.coins-100',
});

let cleanup = () => {};
cleanup = IAP.createOneTimePurchaseOrder({
  options: {
    sku: 'ait.production.coins-100',
    processProductGrant,
  },
  onEvent: () => cleanup(),
  onError: () => cleanup(),
});
```

`abortAwarePurchaseVerification` can wrap an HTTP-backed purchase endpoint, but
it must pass the port's `signal` into the request and enforce the same deadline
before its authoritative ledger commit. It must not contain mTLS credentials in
the client. The helper derives its idempotency key from the order id, so the same
order remains replay-safe across restarts.

For a grant-server failure, return `false`. At the next launch, read
`getPendingOrders()`, submit each order with
`verifyAppsInTossProductGrant({ source: 'pending-order-restore', ... })`, and call
`completeProductGrant()` only after the backend accepts the ledger grant.
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

The order-status API documents offset-free `statusDeterminedAt` values as KST.
The verifier parses that exact calendar form as UTC+09:00 and also accepts
explicit UTC/offset timestamps; malformed dates and calendar overflows fail
closed instead of relying on deployment-local `Date.parse()` behavior.

## Rewarded-ad flow

`userEarnedReward` is client evidence, not grant authority. The wrapper can use
`createAppsInTossRewardCallbackEvidence()` to correlate the callback with an
id created by the game before `showFullScreenAd()` and the configured placement.
The official event only contains `unitType` and `unitAmount`, so the contract
does not require a nonexistent Toss impression id. The production backend must
inject an `AppsInTossRewardAuthority` that independently confirms:

- a stable consume-once authority event id;
- the game-issued correlation id;
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

The AIT target must wire the purchase callback and reward envelope at its SDK
boundary; the generic gateway does not synthesize either from a completed
result. Authority adapters, authenticated session exchange, mTLS agent,
secrets, and endpoints are game/deployment responsibilities. The public
contract remains deterministic and transport-neutral.

## Conformance and sandbox

Run the credential-free contract suite locally and in CI:

```sh
pnpm smoke:apps-in-toss-production-evidence
```

It covers callback-only rejection, in-callback backend grants, purchase success
and idempotent retry, server-grant failure followed by pending-order restoration,
deterministic KST timestamp parsing, authoritative player/SKU/status matching,
reward retry/replay rejection, authority errors, and reward player/placement
matching. No failure path writes a ledger grant.

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
