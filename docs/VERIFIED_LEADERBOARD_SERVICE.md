# Verified Leaderboard Service Boundary

`@mpgd/game-services/verified-leaderboard` defines a provider-neutral boundary
for leaderboards whose entries come from authoritative attempt completion.
It is intended for per-content boards such as a daily challenge, a published
community level, or a tournament round.

The boundary deliberately separates reads from trusted writes:

```text
game client ───────────────> VerifiedLeaderboardReader
                                  |
authoritative attempt coordinator ─> TrustedLeaderboardRecorder
```

The attempt coordinator owns game-specific verification. It may validate a
server-issued session, puzzle identity, elapsed time, completion state, hint and
mistake policy, or any other rules required by the game. Only after that
verification succeeds does it create `LeaderboardVerificationEvidence` and call
`recordVerifiedAttempt()`.

Do not expose `TrustedLeaderboardRecorder` through a public HTTP or game-client
RPC endpoint. Its input is an internal command, not proof that an arbitrary
client score is valid. The public `gameServicesContract.leaderboard.recordScore`
API remains a separate platform-score ledger and is not a substitute for the
verified-attempt flow.

## Content and Ranking Model

`leaderboardId` is an opaque content scope. Games can use IDs such as
`daily:<date>` or `level:<published-id>` without the kit learning those schemas.
Leaderboard and attempt IDs must be well-formed Unicode and may contain at most
512 JavaScript characters; this keeps every valid keyset cursor request within
the bundled Worker's URL size cap, including worst-case JSON and URL escaping.
The definition also fixes two policies for the lifetime of that board:

- `scoreOrder`: `ascending` for elapsed time and `descending` for points.
- `attemptSelection`: `first` retains the earliest verified `completedAt`
  (breaking exact timestamp ties by locale-independent ordinal `attemptId`
  order) for one-shot ranked play, while `best` uses the configured score order
  for conventional high-score play.

Completion and verification timestamps must include `Z` or a numeric timezone
offset and may carry at most millisecond precision. Invalid calendar dates and
sub-millisecond values fail closed so every supported runtime compares the same
instant.

An attempt ID is idempotent within a leaderboard. Reusing it with different
participant, score, time, or verification evidence fails closed. The optional
participant label is presentation metadata and may be changed or omitted by a
retry without changing attempt identity. Retries return the original retention
decision even if another attempt later replaces the retained entry. A snapshot
returns top entries, total participant count, and an optional participant entry
even when that participant falls outside the requested top-entry limit.

Snapshot reads support opaque cursor pagination. A returned `nextCursor` is a
versioned base64url keyset bound to the leaderboard ID, definition policies,
score, completion instant, and ordinal attempt ID. Pass it back as `cursor` to
continue after the final entry in the previous page. It is a continuation hint,
not an authentication credential, and clients must not parse or modify it.
Ranks are recalculated from the current board on every read. Because the board
can change between requests, traversal has weak snapshot consistency: retained
attempt updates may move entries across an already-read page boundary.

The bundled memory implementation is for tests and local orchestration. It
retains every definition and processed attempt for the lifetime of the process,
does not evict inactive boards, and performs a full sort of retained attempts
for each write and snapshot read. Do not use it for long-lived or large-board
deployments without adding bounded retention and an indexed ranking strategy.
Durable platforms should implement the same `VerifiedLeaderboardService`
interface.

## Bundled Cloudflare D1 Provider

`apps/game-services-worker` includes a D1 implementation behind its private
`WorkerEntrypoint` service-binding methods. With `MPGD_STORE = "d1"`,
`recordVerifiedAttempt()` and `getSnapshot()` use the configured `DB` binding;
the memory provider remains the local default.

Apply `apps/game-services-worker/migrations/0002_verified_leaderboards.sql`
after the base game-services migration. Each write uses one D1 `batch()` so the
definition check, attempt-id decision, retained-entry update, and original
response snapshot commit atomically. Snapshot and read-after-write operations
use a `first-primary` D1 session. Attempt IDs carry a derived UTF-16 code-unit
ordinal key so SQLite ranking matches JavaScript ordering for both BMP and
supplementary characters.

The Miniflare smoke runs the public provider conformance suite against the real
D1 API, including concurrent idempotency, rollback, mutation isolation, and
cross-encoding tie cases. Cursor reads use keyset predicates while preserving
global ranks and an independently scoped participant entry. The current D1
query computes a full-board `ROW_NUMBER()` window before applying the keyset so
rank values remain current; very large or hot boards may need cached/materialized
ranks or an application-level participant cap.

## Authenticated Read Transport

`@mpgd/game-services/verified-leaderboard-transport` provides a composable GET
handler and fetch client for read-only snapshots. The handler authenticates the
request before reading and injects the authenticated `participantId`; it rejects
client-supplied participant scope and never accepts verified-attempt writes.

```ts
const snapshotFetch = createVerifiedLeaderboardSnapshotFetchHandler({
  reader: verifiedLeaderboard,
  authenticate: (request) => sessions.authenticate(request),
});

const response = await snapshotFetch(request);
```

The default route is
`GET /game-services/verified-leaderboard/snapshot?leaderboardId=<id>&limit=<n>&cursor=<opaque>`.
The fetch client preserves a path prefix in `baseUrl`, so a base such as
`https://services.example/api/` targets `/api/game-services/...`.
Unknown routes return `undefined` so the handler can compose with an existing
router. Missing or invalid credentials return `401`; invalid cursors return
`400`; unknown leaderboards return `404`. Responses are always marked
`Cache-Control: private, no-store` because `participantEntry` is identity scoped.

The bundled Worker mounts this route only when `VERIFIED_LEADERBOARD_AUTH` is
configured. That private auth service binding receives the Authorization header
and returns `{ participantId }` after verification. Keep token verification in
the identity service; do not derive participant IDs from client query values.

## Provider Conformance

Durable provider packages can validate their implementation with the
test-framework-independent helper exported from
`@mpgd/game-services/verified-leaderboard-conformance`:

```ts
const report = await runVerifiedLeaderboardConformance({
  createFixture: async ({ scenario, now }) => ({
    service: await createIsolatedProvider({ scenario, now }),
  }),
});
```

The fixture factory is called once per scenario and must return isolated state,
or namespace each scenario in a shared test database. The suite covers first
and best retention, original retry-decision preservation, deterministic ties,
identity and definition conflicts, concurrent duplicate writes, caller-mutation
isolation, cursor traversal across UTF-16 ties, snapshot behavior, and runtime
validation. Optional `dispose()` cleanup runs even when a scenario fails.

## Devvit Adapter Shape

`@mpgd/adapter-devvit/server` includes
`createDevvitRedisVerifiedLeaderboardService()`. Pass the server-scoped Redis
client to it; the adapter does not import the Devvit SDK itself:

```ts
import { redis } from '@devvit/web/server';
import { createDevvitRedisVerifiedLeaderboardService } from '@mpgd/adapter-devvit/server';

const leaderboard = createDevvitRedisVerifiedLeaderboardService(redis);
```

Keep the game-specific attempt session and completion validator in the
application:

```ts
const completion = await attemptCoordinator.complete(command);

if (completion.ranked) {
  await leaderboard.recordVerifiedAttempt({
    definition: completion.leaderboardDefinition,
    attempt: completion.verifiedLeaderboardAttempt,
  });
}
```

The client bridge should expose only a game-scoped snapshot read plus the
game-specific completion command. Completion performs the write internally; a
generic client score-submit bridge must not be added.

The adapter hashes board and attempt IDs into bounded Redis keys and fields,
then checks stored identities so a digest collision fails closed. Each write
watches the board definition, idempotency decisions, retained-entry hash, and
ranking set before committing them with `MULTI/EXEC`. Contention is retried with
a bounded budget, and an attempt retry returns its originally persisted
decision even after a later attempt replaces the retained entry.

Redis sorted-set order is not used as the final tie breaker because Redis and
JavaScript order non-ASCII strings differently. The adapter loads retained
entries and applies the public JavaScript ordering before calculating ranks or
cursor pages. This makes it a correctness-first provider for modest boards; it
retains all processed attempt decisions and performs an O(n log n) retained-entry
sort on writes and snapshots. Large or hot boards should add an application
participant cap or a materialized ranking design while continuing to run the
public provider conformance suite.

## Cloudflare Service Binding Shape

The contracts contain only structured-clone-friendly data and promises, so a
Worker can expose the trusted writer to another Worker through a private service
binding while exposing only reads to Pages or public clients:

```ts
interface Env {
  LEADERBOARD: VerifiedLeaderboardService;
}

await env.LEADERBOARD.recordVerifiedAttempt(verifiedCommand);
const snapshot = await env.LEADERBOARD.getSnapshot({
  leaderboardId,
  participantId,
  limit: 10,
});
```

Bind the service in the calling Worker's `wrangler.toml`:

```toml
[[services]]
binding = "LEADERBOARD"
service = "game-leaderboard"
```

Access the binding from each request's `env`; do not cache it in module-global
state.

The bundled D1 provider uses separate definition, verified-attempt decision,
and retained-entry tables. It enforces unique `(leaderboard_id, attempt_id)` and
`(leaderboard_id, participant_id)` keys, immutable definition policies, and an
atomic idempotency plus retained-entry decision. Public snapshot reads added by
an application may use replicas when stale reads are acceptable. KV is not
suitable as the authoritative write store for a hot leaderboard because writes
are eventually consistent and rate-limited per key.
