# Game services

Client, contract, backend, and store helpers for authoritative game services.
See [backend integration](../../docs/GAME_SERVICES_BACKEND.md) for the existing
verification and ledger boundaries.

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

Purchase and rewarded-ad progress are discriminated by `kind` and `phase`.
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

## Guest session and account binding foundation

`createGuestSessionCoordinator` from `@mpgd/game-services/guest-session`
accepts a game-owned `GuestSessionBackend` and a dedicated
`SecureCredentialStore`. The kit does **not** issue tokens or infer server
authentication from `installationId` or a local `playerId`. The backend must
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
