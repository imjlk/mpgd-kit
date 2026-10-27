# @mpgd/target-devvit

## SDK freshness before upload or playtest

`dev`, `upload`, and `publish` run `mpgd kit devvit-check --project <target-directory>` first. Generated targets also run it for initial uploads and playtest. The gate reads current npm stable tags and every directly declared `devvit` / `@devvit/*` package, including the SDK resolved by `@mpgd/adapter-devvit`. Missing installs, stale versions, ranges/prereleases and registry failures stop before Reddit receives a build. No cached last-known result authorizes an upload.

Update the exact versions and lockfile, then rebuild and run target checks before retrying. The gate never installs dependencies between a verified build and upload. A reviewed root override can temporarily align an older published adapter's SDK; it must actually resolve to the current version and be recorded with the release. The pre-upload check cannot detect every other library's nested SDK or replace a compatible-build test.

Devvit 0.15.0 is the tested baseline. Its exact first-party packages have a documented release-age exception for this user-requested update; future SDK releases require their own compatibility and dependency-policy review. See the [official changelog](https://developers.reddit.com/docs/changelog).

Reddit Devvit Web wrapper for the Phaser game target.

Custom wrappers may enable `permissions.realtime` for multiplayer or live updates.
The target artifact smoke accepts `true`, `false`, or an omitted field, matching
the [Devvit configuration contract](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration).
Other types are rejected. The generated wrapper keeps its disabled default;
this capability does not enable payments or relax their separate readiness checks.

The root `pnpm build:devvit` command delegates the configured game client and
Devvit server to the official `@devvit/start/vite` plugin. The plugin emits the
client into `dist/client` and the CommonJS server bundle into
`dist/server/index.cjs`; the mpgd target build then embeds release evidence and
the effective target config. In this repository the configured game app is
`examples/phaser-starter`.

The client build emits `index.html` for a lightweight inline mode launch screen
that can start gameplay inside the post after a user click, and `game.html` for
the separate expanded mode game entry. `devvit.json` maps the default and `game`
entrypoints to those documents respectively.

The game client talks to the Devvit server through the shared
`@mpgd/bridge/orpc` contract at `/api/mpgd/rpc`. The server uses the direct oRPC
Node HTTP adapter from `@mpgd/bridge/orpc/node`; Express, Hono, and Fetch request
conversion are not required. Devvit-owned menu, scheduler, trigger, and form
callbacks remain thin `/internal/...` HTTP routes and should delegate their
business logic to shared service functions. The generated target exposes only
the oRPC bridge route; the former JSON compatibility route is not generated.

The bridge client (game `@mpgd/adapter-devvit`) and the bridge server
(`src/server`) must ship in the same app build: they share one `@mpgd/bridge`
and therefore one oRPC version. oRPC error bodies are not compatible across
oRPC 2.0.0-beta.34 (`@mpgd/bridge` 0.16.4 and older used 2.0.0-beta.14), so a
client and server from different kit releases would turn every oRPC error into a
malformed-response failure. Bridge method errors and request-validation
failures travel inside the bridge response envelope and are unaffected; only
internal server errors and oRPC transport errors (413, undecodable bodies) use
the oRPC error body.

The bridge method handlers live in `src/server/bridge.ts` so they can be tested
with an in-memory Redis double (`pnpm test`); `src/server/index.ts` only wires
the Devvit `context`, `reddit`, and `redis` clients into them. Cloud saves are
bound to the authenticated Reddit user from the request context and stored
under `mpgd:save:<user>:<key>`. Each value is capped at `maxStorageValueBytes`
and each user may hold at most `maxStorageKeysPerPlayer` distinct keys, tracked
in the `mpgd:save-keys:<user>` hash and enforced inside a WATCH/MULTI/EXEC
transaction; saves past the cap fail with `DEVVIT_STORAGE_KEY_LIMIT`. Saves do
not expire by default; set `storageEntryTtlSeconds` to let idle saves age out.

oRPC Publisher helpers are appropriate when a completed task also needs to
broadcast live updates, but they do not replace Devvit Scheduler. Scheduler
delivery is still configured in `devvit.json` and received as a `TaskRequest` at
the configured internal endpoint. Do not use an in-memory publisher when events
must cross Devvit server instances.

Server actions and schedulers that create repeatable custom posts can use the
Redis-backed wrapper in `src/server/postOperationStore.ts` with
`@mpgd/adapter-devvit/server`. The coordinator is duplicate-safe and
ambiguity-safe: it records an attempt before calling Reddit, then returns
`reconciliation-required` for an uncertain outcome without blindly posting again.
An explicit recovery endpoint or scheduler calls `reconcile`. The coordinator does
not claim exactly-once delivery. The Redis wrapper also provides the indexed store
capability used by `listPending()` so a bounded recovery scheduler can discover
prepared, attempted, and terminal records without scanning Redis keys. Listing is
read-only and never restores submit permission. See
[Devvit durable post operations](../../docs/DEVVIT_DURABLE_POST_OPERATIONS.md) for
the operation, retry, and launch-metadata contract.

Authoritative completion handlers can create a durable verified-leaderboard
provider with `src/server/verifiedLeaderboard.ts`. It injects the server-only
Devvit Redis client into `@mpgd/adapter-devvit/server`; the adapter package keeps
the platform SDK outside its reusable implementation. Call
`recordVerifiedAttempt()` only after the application validates completion, and
expose snapshots through an authenticated game-scoped read route. Do not add a
generic client score-submit endpoint. Cursor pagination and provider semantics
are documented in
[Verified Leaderboard Service Boundary](../../docs/VERIFIED_LEADERBOARD_SERVICE.md).
This server-owned provider does not make Devvit a native `PlatformGateway`
leaderboard target: the default Devvit capability and target feature remain
disabled until an application supplies its own verified completion and snapshot
flow.

Local Reddit playtest still needs a Devvit login token:

```bash
pnpm --dir apps/target-devvit whoami
pnpm --dir apps/target-devvit dev
```

`devvit playtest` runs the official unified Vite build in watch mode, so a
separate client/server watcher or a staging prebuild is no longer necessary.

`devvit playtest`, `devvit upload`, and `devvit publish` are intentionally kept
as local commands because they use Reddit auth state from the developer machine.

## AI-assisted Devvit development

Devvit provides an optional MCP server for targeted documentation search and
deployed-app log inspection. See the official
[Devvit AI Tools guide](https://developers.reddit.com/docs/guides/ai), then
register it once in the developer's global Codex configuration:

```sh
codex mcp add devvit -- mise --no-config exec node@22 -- npx -y @devvit/mcp@0.0.27
```

The repository's `.mcp.json` runs the same command for Claude Code. Why it
looks like this:

- `@devvit/mcp` 0.0.27 depends on `better-sqlite3` 11.9.1. Its prebuilt
  binaries cover Node 22 but not 24, where it compiles from source and can
  outlast an MCP client's startup timeout, and it does not build on Node 26.
- `--no-config` keeps mise from loading project or global config: the server
  gets no mise-managed secrets, never evaluates another project's config, and
  does not need this repository's Go toolchain.
- The versioned spec gets its own npx directory, so a plain
  `npx -y @devvit/mcp` started on another Node cannot overwrite its native
  build, and a new upstream release is adopted deliberately.

The command needs `mise` on the MCP client's `PATH`; a client launched from the
Dock may need mise's absolute path. Without mise, register
`npx -y @devvit/mcp@0.0.27` only if the client's `PATH` resolves `npx` from
Node 22, because the client's environment, not the shell you register from,
picks the Node. Running `codex mcp add devvit` again replaces an older
registration. The first start may download Node 22 and install the server's
dependencies, which can outlast a client's startup timeout; start it again if
it does. If `devvit_search` fails with a native-module error after a start on
another Node, delete that npx directory and start the server again:

```sh
rm -rf "$(npm config get cache)/_npx/fb3672217c090d4a"
```

Drop the Node pin once `@devvit/mcp` depends on `better-sqlite3` 12.10 or
later, which ships prebuilt binaries for Node 22, 24, and 26.

Restart Codex or begin a new task after registering it. Use `devvit_search`
before broad Devvit documentation exploration. Use the experimental
`devvit_logs` tool for a deployed app and subreddit when diagnosing production
or playtest behavior, and confirm its findings with local tests and
`devvit playtest`.

The MCP server is an agent-side aid only. It is not required by the game build,
must not be bundled into target artifacts, and does not replace Devvit CLI
authentication or the repository's release checks.
