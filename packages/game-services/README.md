# Game services

Client, contract, backend, and store helpers for authoritative game services.
See [backend integration](../../docs/GAME_SERVICES_BACKEND.md) for the existing
verification and ledger boundaries.

## App Store server-side transaction signatures

`@mpgd/game-services/app-store-server` exports
`createAppleSignedTransactionVerifier`, an `AppStoreSignedTransactionVerifier`
over the optional `@apple/app-store-server-library@3.1.0` peer. It verifies the
App Store JWS certificate chain and signature before exposing any decoded
one-time purchase field, keeps Apple's retryable certificate-status failures
pending (`AppStoreDependencyUnavailableError`), and rejects invalid signatures,
subscription payloads, and oversized transactions. Supply DER-encoded Apple
root certificates, the bundle ID, environment, and production App Apple ID,
and pass the result as `signedTransactionVerifier` to
`createAppStoreGameServicesEvidenceVerifier`. Backend only: the peer is not
installed by game clients, and no other subpath imports it. It moved here from
`@mpgd/adapter-capacitor/app-store-server`, whose deprecated re-export was
removed in commerce v2 PR C4.

## Commerce reconciler

`createCommerceReconciler` from `@mpgd/game-services/commerce-reconciler` is
the RFC "Reconciler" over a `CommerceProvider`: it journals every purchase as
a `commerce-purchase` record of the `MonetizationOperationStore`, sends the
saved verify request to the backend, finishes a purchase only after the ledger
grant, and never grants on the client. It is the only purchase path.
`createGameServicesClient` purchases through it whenever `gateway.commerce`
exists and exposes it as `commerceReconciler`;
`createRecoverableMonetizationClient` and `createGameServicesRuntime` run it
from `monetizationRecovery.reconcile()` and `restorePurchases()` over the
durable journal. See
[docs/MONETIZATION_RECOVERY.md](../../docs/MONETIZATION_RECOVERY.md).

A gateway without `gateway.commerce` sells nothing: `purchase()` answers
`rejected` with a failed platform result and the analytics reason
`commerce_unavailable`, opens no store UI, and never reaches the backend. The
v1 purchase path is gone (commerce v2 PR C4): there is no `recoverPurchaseResult`
(the reconciler learns results from the provider's `getAvailablePurchases` and
`purchaseUpdated` events), no target-name shortcut for adapter-settled
purchases, and no `createGooglePlayTokenTransactionId` (use
`createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce`). A leftover
v1 `purchase` journal record is retired: it stays readable and never reopens the
store UI or grants locally, but a record that was mid-verification has its saved
verify request sent to the backend once more by `reconcile()` (the backend's
answer closes it). Entitlements are not read from the
gateway: read the backend ledger on the server with
`listActiveEntitlementTransactions` from `@mpgd/game-services/commerce-ledger`.

## Commerce evidence registry

`createCommerceEvidenceRegistry` from
`@mpgd/game-services/commerce-evidence-registry` is the RFC "Evidence
registry": the backend routes every verify request by `evidence.schema` to the
registered verifier and finalizer, publishes the stores it accepts through
`getCommerceCapabilities` (`CommerceServiceCapabilities`), and rejects an
unknown schema (`EVIDENCE_SCHEMA_UNSUPPORTED`) or one registered for another
store (`EVIDENCE_SCHEMA_STORE_MISMATCH`) before any verifier runs. Reference
entries wrap the Play, App Store, Microsoft Store, and Apps in Toss verifiers,
and the server-push stores (`devvit.order.v1`, `verse8.agent8-event.v1`) get
lookup verifiers that answer the grant the host's fulfillment path already
wrote, never the client envelope. `@mpgd/game-services/commerce-ledger` adds
the `revoke` entry write path (`revokeEntitlementGrant`), the ledger status
read behind `getPurchaseLedgerStatus`, and `listActiveEntitlementTransactions`.
See [docs/GAME_SERVICES_BACKEND.md](../../docs/GAME_SERVICES_BACKEND.md).

## Registered rewarded-ad evidence

`createGameServicesClient`, `createRecoverableMonetizationClient`, and
`createGameServicesRuntime` accept `rewardEvidenceRegistry`. Create one with
`createClientRewardEvidenceRegistry` from
`@mpgd/game-services/client-reward-evidence`, or extend the default AdMob,
Verse8, and Apps in Toss decoders with
`createDefaultClientRewardEvidenceRegistry` from
`@mpgd/game-services/default-client-reward-evidence`.

Each explicit registration has a unique `schema` and a `normalize(reward)`
function returning `{ platformImpressionId? }` or `undefined`. The registry
passes a bounded, frozen copy of the evidence to the decoder. Decoder errors,
unknown schemas, and malformed candidates produce no claim. A decoder only
recognizes a claim candidate: the backend must independently verify proof
before a ledger grant. An SDK earned event may have `rewardGranted: false`
and still produce a pending or verified backend claim.

```ts
import { createDefaultClientRewardEvidenceRegistry } from
  '@mpgd/game-services/default-client-reward-evidence';

const rewardEvidenceRegistry = createDefaultClientRewardEvidenceRegistry([{
  schema: 'game-provider.reward.v1',
  normalize(reward) {
    const id = reward.evidence?.payload.impressionId;
    return typeof id === 'string' && id.trim() !== ''
      ? { platformImpressionId: id } : undefined;
  },
}]);
// Pass this registry to the client/runtime, and configure server verification separately.
```

Recovery uses the same registered decoder and checks the journaled claim
against the original evidence and impression identity. Missing registrations
or altered evidence leave reconciliation `action-required`; they cannot
reopen the SDK display. Supply the same registrations after a restart.

For existing v1 consumers that supply neither a registry nor `ads.provider`,
the completed SDK reward flag still forwards a legacy candidate to the
backend. A registered schema that fails decoding cannot take this fallback.
Explicit registries and versioned providers reject unknown schemas even if
an SDK reports a reward. Existing `admob-client-reward` exports remain
available for compatibility. Target routing and server verifier registration
are separate integration boundaries.

## Optional operation progress

`purchase(input, options?)` and `claimRewardedAd(input, options?)` accept optional
`onProgress` observers. Existing one-argument calls and client doubles remain
compatible. Types are available from `@mpgd/game-services/client` and the package
root. No UI runtime or Phaser dependency is added.

Headless consumers can import `GameServicesOperationClient` and operation types
from `@mpgd/game-services/operations`. This entrypoint's declarations support
`lib: ["ES2022"]`, `types: []`, and `skipLibCheck: false`; they do not require
catalog validators, transport declarations, or DOM globals. Existing response
type exports from `@mpgd/game-services/types` remain compatible.

```ts
await client.purchase(input, {
  correlationId: 'view-operation-42',
  onProgress: (event) => updateStatus(event),
  onObserverError: (error) => reportUiObserverError(error),
});
```

| Phase | Observed fact |
| --- | --- |
| `platform-requested` | The platform API request is about to be attempted |
| `platform-result` | The platform API resolved; `status` retains its result code |
| `server-requested` | The request has been constructed and the backend verification/claim call is about to be attempted |
| `server-result` | The backend resolved; `accepted` mirrors verification or claim acceptance |
| `completed` | The local invocation returned a normal result; `status` equals that result's status |
| `exception` | The invocation threw; `at` identifies platform, server, or local processing |

Purchase and rewarded-ad progress are discriminated by `kind` and `phase`. A
purchase goes through the reconciler, which journals a store failure as a
`failed` result and a backend outage as `pending`, so those end with a
`completed` event rather than `exception`; `exception` marks a failure of the
call itself, such as a journal write that rejects before the store opens.
`sequence` starts at one per invocation and increases for each actual event.
Events are frozen and calls have independent observers, sequences, and optional
correlation IDs. Callback invocation order is deterministic; asynchronous callback
completion order belongs to the callback. There is no event history, polling,
retry, or cancellation mechanism.

A platform request is not proof that a native screen opened, and a server stage
is not proof that it closed. Native UI visibility cannot be inferred from these
events. Platform ad completion/reward flags, backend acceptance, and the final
service result remain separate. Progress is observation, never grant evidence.

Successful verified purchases and claimed ads normally emit all five non-error
stages. Cancelled, pending, failed, skipped, or unavailable platform results
complete without fabricating backend stages. Unsupported targets emit only the
local completed result, retaining existing rejected-result semantics. An
authoritative Microsoft Store completion emits no duplicate verification.
Verse8 purchases preserve the existing Agent8 grant restrictions and pending
semantics. Backend rejection is normal completion; an exception leaves the
outcome uncertain and does not mean the server denied a grant.

Events do not copy receipts, provider evidence, auth headers, player IDs, ledger
IDs, idempotency keys, raw responses, or provider exception details. A correlation
ID is caller-supplied UI/diagnostic metadata: use an opaque, non-sensitive value.
It is independent of the backend idempotency key and confers no grant authority.

Synchronous callback exceptions and rejected callback promises are isolated.
Observer promises are not awaited: slow or unsettled observers cannot delay a
platform call, verification, claim, or business result. Optional `onObserverError`
observes only observation failures; its own exceptions/rejections are consumed.
There is no forced global logging or transport. Original business exceptions
still reject the client promise unchanged. Existing analytics, purchase recovery,
and retry policy are not redesigned by this observer API.

The root `pnpm test` pipeline includes compiled client JS and public declaration
consumption checks alongside the client and target conformance suites.

## oRPC version and error compatibility

The oRPC transport (`createGameServicesOrpcClient`, `createGameServicesRouter`,
`createGameServicesRpcFetchHandler`) is built on oRPC `2.0.0-beta.46`, pinned
exactly. Pin the same exact version if a game or Worker also uses oRPC directly.

oRPC 2.0.0-beta.34 removed the `inferable` flag from RPC error bodies, and each
side rejects the other's shape: an older client would see a malformed response
instead of `BAD_REQUEST` or `NOT_FOUND`, and so would a newer client talking to
an older Worker. Games and Workers deploy separately, so this package bridges
the change in `src/orpc-error-compat.ts`:

- `createGameServicesRpcFetchHandler` adds `inferable: false` to oRPC error
  bodies, so clients from `@mpgd/game-services` 0.30.5 or older (oRPC
  2.0.0-beta.14) still decode error codes;
- `createGameServicesOrpcClient` (0.31.0 or later) removes a boolean `inferable`
  from error bodies before oRPC validates them, so it still decodes errors from
  Workers on 0.30.5 or older.

Success responses are unchanged. Any other oRPC 2.0.0-beta.34+ client that calls
a game-services Worker's `/rpc` route (for example a plain `RPCLink` in a game)
must wrap its fetch with `withLegacyOrpcErrorCompat` from
`@mpgd/game-services/client`, or it sees the legacy flag as a malformed error. A
Worker that no longer serves clients from 0.30.5 or older can pass
`legacyOrpcErrorFlag: false` to `createGameServicesRpcFetchHandler`. The shim is
removed once the oldest supported game client and every supported Worker come
from `@mpgd/game-services` 0.31.0 or later (oRPC 2.0.0-beta.46). Other oRPC changes picked up with it: RPC routes accept
only POST, PUT, PATCH, and DELETE (a GET answers 404, and the kit clients always
POST), and `Infinity` inputs are encoded with their own meta marker, which a Worker
on 0.30.5 or older (oRPC 2.0.0-beta.14) cannot decode.

## Runtime backend transport

`createGameServicesRuntime` accepts `httpTransport` for its HTTP JSON backend
path. This is a `GameServicesBackendTransport` with fixed Game Services
endpoints, not a general `fetch` implementation. It is never used for the
`orpc` path. A production runtime still requires a valid public HTTPS
`baseUrl`; supplying a custom transport does not enable a local backend or
silently fall back to the default network path.

```ts
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';
import type { GameServicesBackendTransport } from '@mpgd/game-services/client';

declare const gateway: Parameters<typeof createGameServicesRuntime>[0]['gateway'];
declare const nativeJsonTransport: GameServicesBackendTransport;
declare const currentAccessToken: () => string;

const runtime = createGameServicesRuntime({
  gateway,
  playerId: 'game-player',
  authorityMode: 'production',
  baseUrl: 'https://api.example.com',
  transport: 'http',
  httpTransport: nativeJsonTransport,
  getHeaders: () => ({ authorization: `Bearer ${currentAccessToken()}` }),
});
```

`headers` remains available for static values. `getHeaders` is evaluated for
every backend request, including default HTTP and oRPC requests, so session
rotation does not retain an old token. An injected HTTP transport receives
those headers only with a Game Services endpoint request and must itself
enforce its configured HTTPS origin, redirect policy, and response limits;
the runtime cannot inspect a transport's internal network destinations.
Static headers are overridden by refreshed headers, then by explicit
per-request headers, with names compared case-insensitively. If `getHeaders`
fails, the runtime throws a sanitized
`GameServicesHeaderResolutionError` **before** sending the request; this is
distinct from an uncertain network outcome.
Non-2xx HTTP transport responses still become `GameServicesBackendError` and
are not retried through default fetch. Invalid responses and thrown native
transport errors become `GameServicesBackendTransportError` without embedding
the original exception, which might contain credentials. A failed request can
still have completed on the server: reconcile it before retrying a purchase
or reward claim. Do not forward these headers to an unrelated origin or copy
them into analytics or logs.

All published entrypoints use explicit internal ESM module paths and are smoke-tested
with native Node imports, without a bundler or TypeScript runtime loader.

## One player per runtime

A runtime, its purchase journal records, and its reconciler belong to
`playerId` for their whole life, while `getHeaders` and a store provider's
account binding follow the live session. When the session can change player
within a run (an account switch), pass `sessionPlayerId: () => session.current()?.playerId`:

- It is read before every backend request and again once that request's
  headers are resolved, and by the commerce reconciler before each pass,
  queued event, record step, store read, restore, and finish, and right
  before a store UI opens.
- Another player closes the runtime for good: nothing more is verified,
  restored, or finished for this player with the other player's credentials
  (a backend answers that with a permanent account-mismatch rejection), and
  no store UI opens for a purchase journaled here once the session names
  someone else. The provider resolves its account binding a few steps after
  that last check, so the binding resolver must follow the runtime's player
  too (bind nothing for anyone else, as the generated game's
  `setStarterCommerceServicesPlayer` does) for a purchase never to be
  journaled here and bound to the other account; a binding refused while the
  session changed keeps the attempt retryable. Purchases
  answer `failed` with the retryable diagnostic `GAME_SERVICES_PLAYER_CHANGED`
  before any store UI, rewarded-ad claims answer `unavailable` before any
  ad, recovery runs nothing, and Restore Purchases rejects with
  `GameServicesRuntimeClosedError`.
- No player (signed out) refuses the same way with
  `GAME_SERVICES_SESSION_REQUIRED` and leaves the runtime open for its player.

Refusals end no journal record: a runtime created for the player later
resumes them. `runtime.dispose()` closes a runtime the same way
(`GAME_SERVICES_RUNTIME_DISPOSED`) and resolves once a purchase whose store
sheet is open has journaled its answer and the reconciler has stopped (each
wait bounded by `gameServicesDisposeWaitMs`, 3 minutes); call it, and wait,
before creating the runtime for another player or reloading. A custom
`httpTransport` must send only the headers the runtime resolved for each
request, or the after-resolution check cannot cover it. A refusal keeps its
`GameServicesRuntimeClosedError` through header resolution and the HTTP
transport (it is not turned into `GameServicesHeaderResolutionError` or
`GameServicesBackendTransportError`). A reconciler started while the session
is signed out still subscribes to the store; its work waits for the session.

Pass `commerceAccountBinding` too: this player's store account binding,
derived from `playerId` the way the store provider binds the player's new
purchases (Google Play's obfuscated account id, StoreKit's app account
token). The reconciler then leaves a store purchase bound to another account
alone (reported, never journaled or verified for this player). After a
restart as another player, Google Play still lists the previous player's
unacknowledged purchases; sending one with this player's session would be
rejected for good, and its derived key would then block the other player's
own recovery. The player's explicit Restore Purchases still takes a durable
bound to another account (restore sharing). StoreKit's provider already
filters transactions by app account token the same way.

`dispose()` is a required member of `GameServicesRuntime`: a runtime built by
hand (a test fake, a custom wrapper) adds `dispose: async () => undefined`.

A game adopting this creates its runtime from its server session's player
(never a platform placeholder), passes `sessionPlayerId` and
`commerceAccountBinding`, keeps its store account binding resolver on the
same player (bind nothing for anyone else), and disposes the runtime (and
waits) before it creates one for another player.

## Guest session and account binding foundation

`createGuestSessionCoordinator` from `@mpgd/game-services/guest-session`
accepts a `GuestSessionBackend` and a dedicated `SecureCredentialStore`.
The client never issues tokens or infers server authentication from
`installationId` or a local `playerId`; the reference guest identity Worker
in the kit repository (`apps/game-identity-worker`) is one backend that does,
over `createGuestSessionHttpBackend`. The backend must
authenticate opaque refresh tokens, verify external account proofs, atomically
deduplicate account binding by idempotency key, return `conflict` for an account
owned by another server user, and revoke sessions durably. It must define
token rotation, expiry, replay response, idempotent revocation, and database
transactions. The session ID may rotate during refresh or binding, but the
server user ID must remain the same; the
injected contract is not a production identity provider by itself.

The coordinator loads and saves the refresh token only through secure native
credential storage. A load failure never silently starts a new guest, and a
failed save cannot expose a new access token as active. Concurrent refreshes
share one backend call; logout closes header access immediately and waits for
in-flight token changes before revoking the latest token and removing the
credential. Failed revocation or native removal leaves the credential intact
and allows a later logout retry; callers must treat an uncertain logout as a
server-side session that may still be live. Backend and native load errors are
normalized to token-free coordinator codes, not forwarded with raw messages.
`getHeaders()` can be passed as the Game Services runtime's
`getHeaders` resolver. The public session view omits both bearer tokens.

Each view also carries `sessionFamilyId`, the stable session-family id: one
value for the session's whole life, whatever its `sessionId` does on refresh.
A backend should send it (`sessionFamilyId` in its session answers, the same
id its identity service answers to the notifications Worker). A backend that
omits it gets a derived id that changes only where the backend's family might
have: at a new guest, at a bound account whose `sessionId` changed, and at a
restore whose saved family (`<credentialKey>.family` in the same secure
storage, written before the token and removed at logout) cannot be read. Such
a backend must give a binding that starts a new family a new `sessionId`.
`current()` reads the active view and `onSession(listener)` hears each new one.
`createGuestServerSession(coordinator)` reads the coordinator as the
server-backed session the notifications client and the starter's
`setStarterServerSession` take: `current()` answers the server user as
`playerId` and the family id as `sessionId`, `onAuthenticated` hears a new
family (not a refresh), and `getHeaders()` refreshes an expired access token
before answering, and one that expires within a minute in the background
(once per token, at most every ten seconds).

`createGuestSessionHttpBackend({ baseUrl })` is a `GuestSessionBackend` over
the HTTP routes in `guestIdentityHttpRoutes`, which the reference identity
Worker (`apps/game-identity-worker`) serves. It takes an `https:` base URL (or
`http:` on a local development host), never follows a redirect, and times a
request out after 15 seconds; a `200` that is not a JSON object is a failure,
so a logout is never assumed revoked. A refresh token the service refuses for
good on a refresh or a binding (revoked, replayed, expired, or unknown) throws
`GuestSessionRejectedError`, which the coordinator reports as
`GUEST_SESSION_REJECTED`; it then stops using that session (`current()` is
`undefined` and later calls fail with `GUEST_SESSION_NOT_READY` without a
request). Log out (it removes the dead token) and start a new coordinator for
a new guest. Any other failure stays `GUEST_SESSION_BACKEND_FAILED`.

Binding an external account never switches to a different server user on a
client callback. It does not merge purchases, currency, or progress. Use the
existing `progress-link` nonce/idempotency service separately for a
server-verified guest-progress handoff. A platform player ID and store purchase
binding remain distinct from the server user and external provider subject.
The tests use a fake backend and secure-storage port; they do not prove an
OAuth provider, durable session database, or device Keychain/Keystore is
correctly configured.

Headless consumers can import operation input/result/progress types and the two-method
`GameServicesOperationClient` port from `@mpgd/game-services/operations`. This entrypoint
has no runtime implementation and its declarations require no DOM or fetch globals.
The full client continues to re-export the same operation types for compatibility.

## Apps in Toss anonymous authentication

`createAppsInTossPartnerApiClient({ mtls, timeoutMs })` exposes
`exchangeAnonymousAuthorizationCode({ code, signal })`, returning
`{ anonymousKey }` only after `@ait-kit/api-core` authenticates the SDK 3.6
single-use code through mTLS. The existing response-size limit, timeout, caller
cancellation, and configured proxy path are preserved. Redirects are rejected.

Create a game-scoped session from the verified key on the server; never accept
a client-supplied key as the account authority. `verifyAnonymousKey()` remains
available for existence checks, but does not authenticate the caller. Codes are
not retried automatically: an indeterminate request needs a fresh SDK code.
Purchase account binding and ledger idempotency remain the application's job.
