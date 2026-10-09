# ONE play

ONE play runs a hosted HTML5 game inside the ONE store app's WebView and hosting iframe. Build with `pnpm build:oneplay`, then run `pnpm smoke:target oneplay`. A generated game uses `pnpm exec mpgd target build oneplay --kit-path <kit> --targets-file ./mpgd.targets.json` and the corresponding `target smoke` command.

## Adapter boundary

Use `createOnePlayPlatformGateway` from `@mpgd/adapter-browser/oneplay`. The adapter loads the official v1.1.0 ESM SDK, registers lifecycle listeners before initialization and initializes before inspecting feature support. SDK imports and bridge actions stay outside scenes. The SDK is created before game construction; `BootScene` reports resource progress and awaits `gameRuntime.completeLoading()` before opening play. A rejected start keeps simulation, gameplay input and audio blocked and can be retried.

`playerId` is a game-specific pseudonym: the gateway reports `platform-anonymous` / `platform-asserted`, never a verified login. Authenticate game-services requests with a game-owned server session. SDK identity alone cannot authorize access to another player's saves or ledger.

The adapter supplies locale, ringer mute policy and initial safe-area insets. Host mute uses a separate execution block, so changing an in-game setting cannot override it. Pause/resume events are retained across initialization. Exit listeners are synchronous checkpoints: save through `storage.saveSync` in less than 500 ms. The starter checkpoints its local run state; server saves must happen at earlier checkpoints. Storage is partitioned by platform player ID and is local, not cloud storage. Back handlers must return exactly `true` synchronously; async handlers cannot consume the ONE play back event. Dispose the gateway lifecycle when the owning document is torn down.

## Ads

The default target disables monetization until game-owned configuration is ready. Request a ONEconsole placement ID for each format, add the ID to the game's ad catalog under `platformPlacementIds.oneplay`, then enable the corresponding target feature and monetization policy. The SDK supports rewarded and interstitial formats; banners are unsupported.

Interstitials map logical placements to issued IDs. Invocation replay cannot reopen SDK UI, and native fullscreen ownership is shared across gateway instances. `no_fill` never grants a reward. A timeout, transport failure or unknown result keeps the presentation uncertain and prevents another native request for the lifetime of that SDK instance. Do not clear ownership because of `resume`: v1.1.0 synthesizes that event in a `finally` block even on timeout, while the public guide allows late native display. Reload the document to recover an unresolved native UI; do not retry automatically.

Rewarded grants and purchases require independent server verification. `authoritativeGameServices: true` is a policy opt-in, not proof or authentication. Missing server integrations must remain unavailable. Reward request IDs are issued by the server and bound to its authenticated session. The backend ledger credits rewards only after independent signed SSV verification. Purchases use authenticated checkout intents and independent API V7 verification, with ledger grants preceding consume or acknowledge.

## Rewarded server integration

ONEconsole provides one physical placement ID per format. If multiple logical reward placements share it, opt in with `sharedPlatformPlacementTargets: ['oneplay']` on `AdPlacements`. The catalog still rejects cross-format sharing, product ID collisions and sharing on targets without the opt-in. Each server request remains bound to one logical placement and its configured reward.

Use the server-only `@mpgd/game-services/oneplay-reward` entrypoint:

1. Implement `OnePlayRewardStore` in durable storage. Atomically enforce a unique `(applicationId, deploymentTarget, playerId, idempotencyKey)` claim and a unique `(applicationId, requestId)` request; persist the first authenticated receipt immutably. Retain receipts with ledger/recovery records. In-memory storage is only suitable for tests.
2. Call `createOnePlayRewardRequestIssuer(...).issue()` from an authenticated route. Derive `playerId` from the server session, never from the SDK player ID or request body. The issuer resolves the physical ID from the server catalog and keeps a repeated claim bound to its original logical placement. Wire `OnePlayGatewayOptions.rewardRequests.issueRequest` to this route. The issuer supplies a random request ID and a 24-hour callback window with five minutes of server clock tolerance; use a new claim key for a genuinely new presentation.
3. Register `createOnePlayAdRewardVerifier(...)` through `createAdRewardEvidenceVerifierRegistry` in your backend evidence verifier. Configure the same application ID, deployment target, secret and store in the SSV receiver. The API key stays exclusively on the server.
4. Read the SSV HTTP request as original bytes, with an 8 KiB transport limit. Pass `x-API-KEY`, `x-TIMESTAMP` and `x-SIGNATURE` into `createOnePlaySsvReceiver(...).receive()`. Verification checks a five-minute timestamp window and HMAC-SHA256 over `timestamp + "\n" + rawBody`; parsing and reserializing the JSON before verification breaks the signature. Use a trusted server clock. A forged, stale or unissued request cannot grant.
5. Pass your configured backend to the receiver for an immediate `adRewards.claimAdReward` call after durable receipt persistence. This uses the ordinary ledger and verifier, including replay protection, and works if the app has closed. Return HTTP 2xx only after durable acceptance; on transient persistence or ledger failures, allow ONE play to retry. An independently rejected callback should receive a non-2xx response. Without the optional backend, your own recovery job must reconcile accepted receipts through that same API.

Client `rewarded` and `outcome-unknown` envelopes both carry correlation only. The SDK result always has `rewardGranted: false`; a verifier returns pending until its independently received SSV exists. Configure durable monetization recovery in game-services to keep pending claims across app restarts. Late claims verify against the trusted original receipt time, so a valid callback does not become stale merely because the client retries later. Replaying a callback or claim cannot duplicate a grant.

## Managed purchases and PNS

Configure logical products with `platformProductIds.oneplay`, their consumable/non-consumable type and a server-owned grant. The generated and private ONE play build gateway maps those IDs and accepts `rewardRequests` / `commerceServer` ports. Wire the game-owned authenticated ports when constructing that gateway; setting a target policy flag or environment URL alone does not supply them. The default sample leaves monetization disabled. Subscriptions are unsupported by this H5 integration.

`OnePlayCommerceServerPort.issueIntent` calls an authenticated server route; `getEntitlements` and optional `restore` read/reconcile the backend ledger. The SDK has no purchase-list/restore API. SDK product-detail support is independent of purchase support. Product lookup batches at most 20 IDs and accepts partial or reordered results. `ProductInfo.price.formatted` preserves the SDK price text and includes its currency code; do not parse that text for arithmetic. A successful SDK checkout returns tokens as evidence with empty entitlements and no `authoritativeGrant`. Reusing a checkout key cannot open another SDK payment UI.

Use the server-only `@mpgd/game-services/oneplay-purchase-client`, `oneplay-purchase` and `oneplay-pns` entrypoints:

1. Construct `createOnePlayPurchaseClient` with ONEconsole's client ID/secret, explicit `SANDBOX` or `COMMERCIAL` and the appropriate `MKT_ONE` / `MKT_GLB` market. The client uses the official fixed API V7 origins, bounded responses, abortable requests, cached OAuth tokens and sanitized errors. Keep credentials and purchase tokens off public logs and frontend bundles. Sandbox and commercial clients, intent stores and ledger deployments must remain separate.
2. Implement `OnePlayCheckoutIntentStore` durably. Atomically enforce unique claim identity `(clientId, environment, marketCode, deploymentTarget, playerId, idempotencyKey)` and unique payload `(clientId, environment, marketCode, developerPayload)`. `createOnePlayCheckoutIntentIssuer` resolves the server catalog and generates an opaque payload of at most 200 UTF-8 bytes. Derive the player ID from an authenticated session. The 24-hour window applies to the independently verified purchase time, with five minutes of provider/server clock tolerance on both bounds, allowing delayed reconciliation after checkout.
3. Configure `createOnePlayPurchaseBoundary` as both the backend's purchase evidence verifier and `purchaseGrantFinalizer`. Verification queries the purchase token, matches server-issued intent, owner, deployment, product, purchase ID, single-item quantity and purchase state. Cancelled, consumed, unbound, wrong-environment and subscription purchases cannot create new grants. Replay identity hashes application/environment/market/token. Finalization rechecks that context against the durable ledger evidence before consuming a consumable or acknowledging a non-consumable. A transient finalization failure leaves a committed grant pending; retry the same intent through the backend instead of charging again. Consume implies acknowledgement; finish within ONE store's three-day acknowledgement deadline.
4. Configure `createOnePlayPnsReceiver` with the license public key, the same client/boundary/backend and an authoritative `onCancelled` hook. It accepts PNS 3.1.0 / 3.1.0D, verifies RSA SHA512 over compact UTF-8 JSON without `signature`, validates client/environment/market and independently re-queries the purchase API. Completed PNS can recover a checkout with no client callback through the same purchase ledger. A signed notification alone cannot grant or revoke. A contradictory API state returns pending.
5. Implement `onCancelled` as a durable, idempotent refund/revocation transaction keyed by the inspected purchase's `verificationId`. Record a cancellation fence even if its grant has not arrived yet. Enforce that fence atomically in the game-owned `GameServicesStore.recordEntitlementGrant` transaction as well as revoking an existing matching grant, so a concurrent or late completion cannot credit a cancelled purchase. Match owner/product context, update the authoritative balance or entitlement, and expose refunded outcomes through server restore/read APIs. This library provides the verified cancellation hook, not a game-specific refund policy or an HTTP route. Keep cancellation processing and subsequent reads ordered in the game's server so stale client results cannot restore a revoked entitlement.

PNS can be delayed or lost. Keep an authenticated purchase recovery route and a durable reconciliation queue with securely retained tokens/intent references; periodically re-query unresolved or refund-eligible purchases and use the same boundary and ledger paths. Do not rely only on notifications. Accept PNS with HTTP 2xx only after durable processing; pending results or transient ledger/revocation failures require a non-2xx retry response. Client monetization journals must encrypt and access-control token evidence. Use server-confirmed restore or `recoverPurchaseResult` plus backend verification to reconcile interrupted operations.

The commerce adapter reports trusted physical checkout closure through `commerce.presentation`. The common runtime subscribes automatically, separately from grant status. Unknown/transport/timeout results retain native ownership and the runtime presentation gate. SDK `resume` never proves closure. Reload to recover an unresolved native surface, then reconcile the server intent; do not automatically reopen checkout with a new key.

## Hosting and real-app tests

The artifact is non-installable. Register an HTTPS execution URL with HTTP 200 and TLS 1.2 or newer in ONEconsole. `_headers` includes a `Content-Security-Policy: frame-ancestors https://*.onestore.co.kr https://*.onestore.net` rule for compatible static hosting providers. Other servers must configure the equivalent HTTP response header themselves. An HTML meta tag cannot apply this policy. Verify the final CDN/WAF response and every ancestor; artifact smoke does not prove live hosting is configured.

Register the test URL and test account, then open ONE store → My → Usage information → Web game test → My test games. Browser fixtures check gateway contracts and gameplay, but actual SDK ads, payments, app lifecycle and hosting validation need the real app. No public test placement IDs are provided; ONEconsole placement provisioning is required.

## Official references

- [SDK overview](https://onestore-dev.gitbook.io/dev/tools/web-sdk/ov)
- [Prerequisites and iframe requirements](https://onestore-dev.gitbook.io/dev/tools/web-sdk/pre)
- [Lifecycle, exit and back](https://onestore-dev.gitbook.io/dev/tools/web-sdk/lifecycle)
- [Advertising](https://onestore-dev.gitbook.io/dev/tools/web-sdk/iaa)
- [Advertising placement setup and signed SSV](https://onestore-dev.gitbook.io/dev/docs/apps/product/monetization/iaa)
- [IAP](https://onestore-dev.gitbook.io/dev/tools/web-sdk/iap)
- [Purchase server API](https://onestore-dev.gitbook.io/dev/tools/billing/v21/serverapi)
- [PNS](https://onestore-dev.gitbook.io/dev/tools/billing/v21/pns)
- [Real-app testing](https://onestore-dev.gitbook.io/dev/tools/web-sdk/test)
- [Release notes](https://onestore-dev.gitbook.io/dev/tools/web-sdk/releasenote)
