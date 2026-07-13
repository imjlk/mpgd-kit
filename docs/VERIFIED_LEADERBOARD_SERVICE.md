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

The bundled memory implementation is for tests and local orchestration. It
retains every definition and processed attempt for the lifetime of the process,
does not evict inactive boards, and performs a full sort of retained attempts
for each write and snapshot read. Do not use it for long-lived or large-board
deployments without adding bounded retention and an indexed ranking strategy.
Durable platforms should implement the same `VerifiedLeaderboardService`
interface.

## Devvit Adapter Shape

A Devvit server can implement the interface over Redis while keeping its
game-specific attempt session and completion validator in the application:

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

For D1 persistence, use separate definition, verified-attempt decision, and
retained-entry tables. Enforce unique `(leaderboard_id, attempt_id)` and
`(leaderboard_id, participant_id)` keys, make definition policies immutable,
and perform the idempotency decision plus retained-entry update atomically.
Prepared statements are required. Use the primary/session for read-after-write
responses; public snapshot reads may use replicas when stale reads are
acceptable. KV is not suitable as the authoritative write store for a hot
leaderboard because writes are eventually consistent and rate-limited per key.
