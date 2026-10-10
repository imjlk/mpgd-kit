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

The starter and generated games select the self-completing AIT sandbox gateway
only for a non-production build whose `BUILD_ID` is exactly `ait-sandbox` (the
value `pnpm dev:ait` sets). Every other AIT build uses the production gateway, so
an ordinary debug build cannot grant purchases or rewards without the backend.

Generated wrappers expose `pnpm ait:wrapper:dev:sandbox`. Unlike the ordinary
browser playtest, this command sets `MPGD_AIT_LOCAL_MOCK=0` and
`VITE_MPGD_AIT_MOCK_IDENTITY=0`; the Sandbox host must provide the native SDK.
Pass game-owned staging endpoints and SKU/authority settings to the process.
Never use the command as evidence that a plain desktop browser supports IAP.

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

## Built-in host bridge recovery

`createAitHostBridge()` from `@mpgd/adapter-ait/host` owns the one-time order
flow when a game passes `iapProducts`, `prepareIap`, `verifyIapProductGrant`
and `readIapEntitlements`. It keeps the server authoritative and adds these
recovery rules:

- **Client purchase key.** `verifyIapProductGrant` always receives the
  order-scoped `idempotencyKey` (`apps-in-toss:purchase:<encoded order id>`)
  as the grant identity. It also receives `clientIdempotencyKey`, the key the
  game passed to `commerce.purchase`, whenever the bridge can link the order to
  that attempt: the grant callback, a direct re-verify, and restore or
  pre-checkout recovery of an order this device started. The link is stored in
  adapter-reserved native storage, so it survives a reload. Use the client key
  to associate the order with a game operation; do not replace the order key
  with it.
- **No second charge.** Before opening a checkout, the bridge reads
  `getPendingOrders()` and reconciles configured SKUs. If an order for the same
  product is still ungranted, or was just granted by this check, the purchase
  returns `failed` without opening a checkout, with `diagnostic.code`
  `AIT_IAP_PENDING_ORDER_UNRESOLVED` or `AIT_IAP_PENDING_ORDER_RECOVERED`.
  Nothing was charged for that request. If the list cannot be read, or it or
  any entry that could belong to a configured SKU is malformed, the result is
  `failed` with `AIT_IAP_PENDING_ORDER_CHECK_FAILED`.
- **One IAP operation at a time.** A purchase holds a single lock from its
  attempt-marker check until its checkout result, and a restore holds it from
  before `prepareIap` until it finishes. While the lock is held, another
  purchase returns `failed` and `commerce.restore` rejects, both with the
  retryable `AIT_IAP_CHECKOUT_IN_PROGRESS`. No other operation can then
  verify, acknowledge or change markers for the same order. A purchase
  releases the lock only after its grant callbacks, direct recovery and order
  link writes have settled.
- **Acknowledgement barrier.** Before every `completeProductGrant()` call, the
  bridge records the order as in flight. The record's `recorded`/`started`
  phase is diagnostic only. If the call times out, the record stays. A
  record is cleared only by a confirmed acknowledgement, or, once the
  provider no longer lists its order, by the verifier confirming the grant
  for that order again. The order's absence alone never clears it, because
  a record write can land late without any dispatch and the list can lag.
  A cleared absent order is reported as settled, so a same-product purchase
  returns `AIT_IAP_PENDING_ORDER_RECOVERED`. Otherwise the record stays an
  unresolved same-product barrier. A timeout, `false` or an error never
  clears a record. A retry while an earlier `completeProductGrant()` for the
  same order is still running joins that call instead of dispatching again.
  If the record cannot be read or written, the order is not acknowledged.
  Records for SKUs that are no longer configured are kept apart from the
  32-order active capacity. At most 32 of them are kept, oldest dropped first,
  so they never block acknowledging products that are still sold.
- **Serialized storage.** Every adapter-reserved IAP storage key (attempt
  markers, order links, the acknowledgement record, the cursor and the
  completed index) is read and written one operation at a time. Each waits
  until earlier calls on that key have actually finished, so a late write can
  never overwrite a newer one and a read never sees an absence that races an
  unfinished write. A call whose turn does not come in time fails closed.
  Once a call on a key outlives a deadline, later calls on that key fail
  closed immediately until it settles, instead of queueing behind it.
  Concurrent `getPendingOrders()` and `getProductItemList()` reads also share
  one native call.
- **Storage growth.** Completed attempt markers are kept indefinitely by
  design. They back idempotency, so replaying an accepted client key returns
  the completed purchase instead of opening another checkout. Each is a
  compact tombstone (`{ v, status, productId, orderId, source? }`), because
  the storage key already names the product and client key, so growth is
  one small record per accepted purchase key. Full-form completed markers
  written earlier remain readable. Every other IAP key is bounded:
  - order links are removed once their order is settled, and kept while it
    is pending or its acknowledgement is ambiguous;
  - the acknowledgement record holds at most 32 orders;
  - the completed index keeps the 64 most recent keys as bookkeeping only;
  - the restore cursor is a single key.
- **Partner grant failure.** When the SDK reports
  `PRODUCT_NOT_GRANTED_BY_PARTNER` for an order the callback saw, the bridge
  verifies that exact order once more (`source: 'pending-order-restore'`),
  marks the client attempt completed and then calls `completeProductGrant()`
  itself, because the pending-order list can lag right after checkout. If the
  check or the marker write fails, the order stays `pending` and
  unacknowledged.
- **Restore.** `commerce.restore` returns `settledPurchases` for orders it
  granted and acknowledged, including `idempotencyKey` when the order is linked
  to a client attempt. It rejects with a coded `PlatformOperationError` when it
  could not do its job (IAP unavailable, preparation rejected, pending orders
  unreadable, or the entitlement read failed with nothing settled). A partial
  restore resolves with `diagnostic`, for example
  `AIT_IAP_PENDING_ORDER_UNRESOLVED`. For a linked order, restore marks the
  client attempt completed before calling `completeProductGrant()`. If the
  link or the marker cannot be read or written, the order stays
  unacknowledged for a later retry, as it does when the linked marker is
  corrupted; only a link that is confirmed absent lets an unlinked order be
  acknowledged. A linked attempt without a marker gets a completed marker.
  Replaying the original client key then returns the completed purchase.
- **Startup recovery.** Call `gateway.commerce.restore()` once the game session
  exists (after the account or identity that `prepareIap` checks is ready).
  A purchase tapped while that restore runs gets
  `AIT_IAP_CHECKOUT_IN_PROGRESS` and can be retried right after it.

Non-completed purchase results carry `diagnostic: { code, retryable,
providerCode? }`. The codes are exported as `aitIapDiagnosticCodes` from
`@mpgd/adapter-ait`, which does not import the Apps in Toss SDK.
`providerCode` comes only from a structured `code` or `errorCode` field, or
from an exact allowlisted SDK code such as `PRODUCT_NOT_GRANTED_BY_PARTNER`;
other message text is never copied. `commerce.getProducts` still
returns an empty list when IAP is not configured or not supported, and rejects
with `AIT_IAP_CATALOG_EMPTY`, `AIT_IAP_CONFIGURED_SKUS_NOT_VISIBLE`,
`AIT_IAP_UNSUPPORTED_APP_VERSION` or `AIT_IAP_CATALOG_UNAVAILABLE` when the
configured catalog cannot be shown. `commerce.getEntitlements` rejects with
`AIT_IAP_ENTITLEMENT_READ_FAILED` when the configured `readIapEntitlements`
fails or times out, instead of reporting no entitlements.

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

When an AIT WebView sends callback evidence to the game authority, use
`fetchAitAuthority()` for the HTTP call. It invokes an injected/native `fetch`
without binding it to a dependency object, which prevents valid requests from
failing in the iOS WebView before reaching the backend. The game still supplies
its authentication, idempotency headers, deadline/signal, and response
validation; a successful HTTP response alone must not grant a product.

```ts
import { fetchAitAuthority } from '@mpgd/adapter-ait/authority-fetch';

const response = await fetchAitAuthority({
  resource: verificationUrl,
  init: {
    method: 'POST',
    headers: authorityHeaders,
    body: JSON.stringify(request),
    signal,
  },
  fetch: dependencies.fetch,
});
```

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

The verifier only grants one-time products. A catalog product with
`type: 'subscription'` is rejected with `APPS_IN_TOSS_SUBSCRIPTION_UNSUPPORTED`
before the order-status authority is called, because a one-time order status
cannot express renewal, expiry, or revocation. This matches the Google Play and
App Store verifiers and does not depend on the adapter hiding `SUBSCRIPTION`
products or on target config leaving `subscriptions` disabled.

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

## Advertising behavior and presentation

The production host exposes `gateway.ads.provider` using `mpgd.ads.v2`.
Availability, preparation, and show requests cross the existing bridge as
`ads.getAvailability`, `ads.prepare`, and `ads.show`; invocation-scoped SDK
observations return through the installed host's `advertising.subscribe` port.
The proxy validates the request response id and the provider, invocation, and
format of show results. Older bridges may omit this optional port.

Create one game-owned `createFullScreenPresentationScope({ execution })` and
wrap the gateway with `createCoordinatedPlatformGateway` from
`@mpgd/game-runtime/ads`, passing `gateway.ads.provider` as `provider`.
Use that coordinated gateway in scenes and service operations so purchases,
rewarded ads, and interstitials share the same full-screen owner. Keep the
scope and the claim recovery observer alive above scene lifetimes.

AIT reports delayed reward eligibility because the SDK does not guarantee that
`userEarnedReward` precedes `dismissed`. Dismissal releases physical ownership;
a later reward event still belongs to the original idempotency key. The SDK
callback envelope is candidate evidence. The v1 facade returns
`rewardGranted: false` and never fabricates a `ledgerEntryId`; game-services
obtains any grant from the independent authority and backend ledger.

Both display-start and maximum-display deadlines end the caller's wait with
pending/unknown presentation. They do not close the native UI, unregister its
terminal callback, or resume the game. A real `dismissed` or `failedToShow`
callback releases only that invocation's native ownership. A recreated host
sharing the same SDK show function remains unavailable while the old native
presentation is uncertain. SDK callback cleanup only unregisters observation,
as documented in the [official showFullScreenAd API](https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/ads/showfullscreenad).

Legacy presentation pause/resume, pagehide/pageshow, and document visibility
are independent lifecycle owners. Native resume cannot make a hidden page
active. Games using the coordinated provider receive presentation control from
the shared scope instead of a second ad-specific lifecycle pause.

`adapters/ait/src/ad-conformance.test.ts` runs seven shared presentation vectors
through fake SDK callbacks and the real host/proxy/runtime: unsupported,
configuration-required, policy-disabled, preparation-ready, timeout-late-close,
full-screen-arbitration, and background-ownership. These tests certify that
presentation subset; they have no ledger grant port and do not certify the
remaining server verification/recovery vectors or a live Toss deployment.

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
subscription-product rejection, post-success purchase rejection, reward retry/replay rejection, explicit-zone
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
