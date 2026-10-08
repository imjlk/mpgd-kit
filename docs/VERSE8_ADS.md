# Verse8 advertising behavior

`@mpgd/adapter-verse8` exposes `gateway.ads.provider` using `mpgd.ads.v2`.
The existing v1 methods delegate to that provider and always return
`rewardGranted: false`; only independently verified backend ledger operations
can grant a reward. The original invocation id becomes the SDK `requestId`.
The separate operation idempotency key remains the claim journal identity.

## Native closure integration

The pinned `@verse8/ads@0.4.0` SDK resolves a rewarded H5 view at `adViewed`,
before `adBreakDone`. A rewarded Promise therefore confirms local eligibility,
not screen closure. Its `VERSE8_ADS_EVENT` protocol is a reserved no-op, and
`render_result_dispatched` telemetry is not a closure fact. The SDK also removes
a pending request on timeout, so late host results cannot be recovered by
reopening the same SDK request.

Provide the game-owned target assembly with `adPresentation`, a
`Verse8AdPresentationSource` backed by trusted host observations. Each event
must carry the original `requestId`, a positive increasing sequence, and one
of `open`, `closed`, `not-started`, or `unknown`. The adapter ignores foreign
and stale facts. A `not-started` fact after observed presentation becomes
unknown instead of freeing a potentially live surface.

Without that port, rewarded availability is configuration-required and the
SDK is not opened. Interstitials may use the SDK's documented `dismissed`
result as closure. Preparation is deferred because the SDK has no separate
preload API. This is an integration requirement, not a host event implemented
by the kit: the current SDK alone cannot certify normal rewarded closure.

Wrap the gateway with one game-owned `createCoordinatedPlatformGateway` and
`createFullScreenPresentationScope` from `@mpgd/game-runtime`. The same scope
coordinates purchases, rewarded ads, and interstitials. Keep it above scene
lifetimes, and attach the application-owned evidence recovery observer to the
original operation journal.

## Uncertainty and evidence

Both caller wait limits and SDK timeouts preserve unknown native occupancy
and retain the host observer. A new gateway using the same SDK client remains
unavailable until the original host reports closure. SDK reward completion
never releases that owner. A separately observed close releases execution
while an outstanding SDK or backend verification result may arrive later.

The requested and eligible evidence use `verse8.ads.reward.v1`, with the SDK
request id and resolved native placement. SDK reward amount/type are ignored.
The request id is a correlation token, not an authorization credential.
Independent server verification must match provider/schema/deployment,
player, placement, and invocation before the replay-safe ledger grants.
Do not generate a second SDK request to reconcile a pending claim.

## Verification scope

`adapters/verse8/src/ad-conformance.test.ts` drives fake SDK Promises and a
scoped host presentation source through the actual adapter and shared runtime.
It covers eight presentation vectors: configuration-required, policy-disabled,
preparation-deferred, timeout-late-close, full-screen-arbitration,
background-ownership, interstitial-shown, and show-failure.

The fixture has no server grant port. It does not certify ledger/recovery
vectors, an undocumented rewarded close event in SDK 0.4, or a live Verse8
host. SDK-specific eligibility, foreign request ids, late evidence after
closure, stale closure, and recreated-gateway quarantine have separate tests.
