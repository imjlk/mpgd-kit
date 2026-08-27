# Apps in Toss Production Evidence

`@mpgd/game-services/apps-in-toss-evidence-verification` connects Apps in Toss
purchase and rewarded-ad callback evidence to the existing authoritative
game-services verifier and replay-safe entitlement ledger.

The boundary does not import an Apps in Toss SDK or perform network requests.
The target wrapper collects versioned correlation evidence; the partner backend
injects server authorities. If the matching authority is absent, throws, returns
pending, or does not match the order/player/SKU or reward/player/placement, no
ledger grant is written.

## Test environments and commerce diagnostics

Apps in Toss does not expose a client flag that turns a production checkout
into a test checkout. The host environment selects the behavior:

- Use the current Sandbox app, keep its developer login active, and expose the
  console products to test one-time IAP without a real charge. Only products
  whose console visibility is enabled are returned by `getProductItemList()`.
- Use the uploaded bundle's `intoss-private://` QR scheme for the final Toss-app
  integration check. The QR origin and production origin are separate browser
  origins and must both be covered by the backend's exact CORS policy.
- Sandbox identity APIs return mock data. A production backend must not treat a
  client-provided mock key as a verified production identity. If a game needs a
  sandbox-only authority, isolate it to a staging backend and keep production
  grants fail-closed.

`@mpgd/adapter-ait` preserves bridge rejection metadata as a
`PlatformOperationError`. Game UI can report a safe code without importing the
Apps in Toss SDK or parsing a localized provider message:

```ts
import { readPlatformOperationFailure } from '@mpgd/platform';

try {
  const products = await gateway.commerce.getProducts();
  // Render only provider-returned products and prices.
} catch (error) {
  const failure = readPlatformOperationFailure(error);
  reportCommerceDiagnostic(
    failure?.code ?? 'COMMERCE_CATALOG_FAILED',
    failure?.retryable ?? true,
  );
}
```

Share one session-scoped AIT identity provider between platform bootstrap,
promotion, IAP preparation, verification, and entitlement reads. The helper
coalesces concurrent native reads and evicts a rejected read so a resumed
mobile host can retry:

```ts
import {
  createAitHostBridge,
  createAitSessionIdentityProvider,
} from '@mpgd/adapter-ait/host';
import { User } from '@apps-in-toss/web-framework';

const identityProvider = createAitSessionIdentityProvider(
  () => User.getAnonymousKey(),
);

const bridge = createAitHostBridge({
  dependencies: { identityProvider },
  // Reuse identityProvider from prepareIap/verifyIapProductGrant closures too.
});
```

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
   status API and returns the server-authenticated game player identity bound
   to the order. Supply `tossUserKey` when the game already uses Toss Login.
   Otherwise, verify the platform anonymous key on the server and atomically
   bind the order id to that game player through a consume-once order authority.
4. The verifier matches order id, player id, platform SKU, status, and status
   timestamp. Only `PURCHASED` and `PAYMENT_COMPLETED` are grantable.
5. The game-services ledger records the catalog grant with
   `apps-in-toss:purchase:<encoded-order-id>` as its authority identity.
6. Return `true` from `processProductGrant` only after the backend reports
   `verified: true`.

Only `process-product-grant` and `pending-order-restore` evidence sources are
grantable. The SDK success event occurs after the product-grant callback and is
therefore never accepted as an authority path.

The SDK documents a 30-second product-grant window. The helper uses a 25-second
deadline by default, aborts the verification request, and returns `false` on
timeout. Its `purchaseVerification` port must carry the provided `AbortSignal`
through the transport and server-side ledger deadline so an aborted request
cannot commit a late grant. `timeoutMs` may only shorten the 25-second default.
Provide `onVerificationError` to route fail-closed backend responses, transport
errors, and deadline failures to deployment diagnostics while the SDK callback
still returns `false`.

The SDK callback supplies only `orderId`. Its `purchasedAt` request field is
therefore the callback/grant-attempt observation time provided by `now`, not an
authoritative financial timestamp. Use the purchase authority's normalized
`statusDeterminedAt` for reconciliation and other time-sensitive decisions.

The generic `createGameServicesClient().purchase()` flow verifies after
`gateway.commerce.purchase()` returns, so it cannot satisfy this callback
timing by itself. Wire the callback-specific API directly into the AIT SDK:

```ts
import { IAP } from '@apps-in-toss/web-framework';
import {
  createAppsInTossProductGrantCallback,
  createAppsInTossProductGrantVerificationPort,
} from '@mpgd/game-services/apps-in-toss-evidence-verification';

const abortAwarePurchaseVerification = createAppsInTossProductGrantVerificationPort(
  ({ request, signal, timeoutMs }) => {
    return callbackSpecificPurchaseTransport.verifyPurchase(request, {
      signal,
      timeoutMs,
    });
  },
);

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

The nominal port factory deliberately rejects the legacy one-argument
`backend.purchases` API. `callbackSpecificPurchaseTransport` may call an
HTTP-backed purchase endpoint, but it must pass both `signal` and `timeoutMs`
through the request and enforce the deadline before its authoritative ledger
commit. It must not contain mTLS credentials in the client. The helper derives
its idempotency key from the order id, so the same order remains replay-safe
across restarts.

For a grant-server failure, return `false`. At the next launch, read
`getPendingOrders()`, submit each order with
`verifyAppsInTossProductGrant({ source: 'pending-order-restore', signal,
timeoutMs, ... })`, and call
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
partner-server call requires mTLS, and the mini app must have Toss Login
integration configured before the status API is available. The request's
`x-toss-user-key` header is optional: include it to restrict the lookup to a
linked Toss user, or omit it for an order-id-only lookup. In the latter flow,
the game backend must still authenticate the platform-anonymous player, match
the returned order id/SKU/status, and atomically reserve the order id globally
before writing that player's ledger grant. Keep mTLS credentials, optional
login tokens/user-key mappings, base URL overrides, and transport configuration
in the deployment runtime. Do not commit them or include them in client bundles.

`@mpgd/game-services/apps-in-toss-partner-api` provides the shared server-only
transport for the documented anonymous-key verification and functional-message
endpoints. It accepts a fetch-compatible mTLS binding instead of certificate
bytes, so a Cloudflare Worker can pass its certificate binding directly:

```ts
import { createAppsInTossPartnerApiClient } from '@mpgd/game-services/apps-in-toss-partner-api';

interface Env {
  readonly AIT_MTLS: Fetcher;
  readonly AIT_VERIFICATION_RATE_LIMIT: RateLimit;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // This is an internal route. Authenticate and authorize the calling game
    // backend before accepting any caller-supplied identity assertion.
    const caller = await authenticateInternalGameBackend(request);
    if (caller === null) {
      return new Response(null, { status: 401 });
    }
    const quota = await env.AIT_VERIFICATION_RATE_LIMIT.limit({ key: caller.id });
    if (!quota.success) {
      return new Response(null, { status: 429 });
    }

    const partnerApi = createAppsInTossPartnerApiClient({ mtls: env.AIT_MTLS });
    const anonymousKey = request.headers.get('x-ait-anonymous-key') ?? '';
    const verified = await partnerApi.verifyAnonymousKey({ anonymousKey });
    return Response.json({ verified });
  },
};
```

The authentication and rate-limit checks above are deliberately placed before
the mTLS client call. Do not expose anonymous-key verification as a public
validation oracle: unauthorized or throttled requests must never consume
Partner API traffic. `authenticateInternalGameBackend()` is game-owned and must
validate a server credential or an equivalently strong authenticated session;
it is not a client-supplied header equality check.

Bind the certificate in deployment configuration with a Wrangler
`mtls_certificates` entry. The binding's `certificate_id` is deployment state;
do not copy a PEM, private key, or certificate id into the browser bundle. Local
Workers runtimes do not emulate the mTLS handshake, so inject a fake fetcher in
unit tests and run a staging call with the real binding before release.

The order-status API documents offset-free `statusDeterminedAt` values as KST.
The verifier parses that exact calendar form as UTC+09:00 and also accepts
explicit UTC/offset timestamps; malformed dates and calendar overflows fail
closed instead of relying on deployment-local `Date.parse()` behavior.

## Rewarded-ad flow

`userEarnedReward` is client evidence, not grant authority. The wrapper can use
`createAppsInTossRewardCallbackEvidence()` to correlate the callback with an
identifier created by the game before `showFullScreenAd()` and the configured
placement. Copy that same identifier into
`ClaimAdRewardRequest.platformImpressionId`; the verifier requires the request,
evidence envelope, and authority result to agree. For AIT this field carries a
game-issued correlation identifier, not a Toss-issued impression identifier.
The official event only contains `unitType` and `unitAmount`, so the contract
does not require a nonexistent Toss impression id. The production backend must
inject an `AppsInTossRewardAuthority` that independently confirms:

- a stable consume-once authority event id;
- the game-issued correlation id;
- authenticated player id;
- configured platform placement id;
- verification timestamp with an explicit UTC or numeric offset.

Unlike the documented order-status timestamp, a game-owned reward authority
has no Apps in Toss KST default. Offset-free reward timestamps fail closed so
deployment locale cannot shift audit and reconciliation times.

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

## Functional messages

The target adapter can request notification agreement through the AIT client
SDK. Delivery remains a server operation. Anonymous keys can be checked with
`verifyAnonymousKey()`. Toss-user keys, however, are trusted only when they came
from an authenticated Toss login and the backend's protected anonymous-to-user
key mapping; `verifyAnonymousKey()` does not validate Toss-user keys, and
`sendFunctionalMessage()` must never be treated as validation for an arbitrary
`toss-user` key. After establishing the recipient through the appropriate
authenticated path, adapt `sendFunctionalMessage()` to a durable
`NotificationDeliveryProvider`; keep template-set codes and template context on
the server and retain the delivery ledger's idempotency guarantees. Agreement
does not prove that an arbitrary recipient key is valid, and a valid key does
not replace the user's notification agreement.

## Conformance and sandbox

Run the credential-free contract suite locally and in CI:

```sh
pnpm smoke:apps-in-toss-production-evidence
```

It covers callback-only rejection, in-callback backend grants, purchase success
and idempotent retry, server-grant failure followed by pending-order restoration,
deterministic KST timestamp parsing, authoritative player/SKU/status matching,
post-success purchase rejection, reward retry/replay rejection, explicit-zone
reward timestamp validation, authority errors, and reward player/placement
matching. No failed verification or rejection path writes a ledger grant;
product completion can still fail after a durable grant and must then be retried.

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
- [Apps in Toss user key](https://developers-apps-in-toss.toss.im/user-hash-key/develop.md)
- [Apps in Toss smart message](https://developers-apps-in-toss.toss.im/smart-message/develop.md)
