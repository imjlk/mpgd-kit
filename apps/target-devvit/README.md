# @mpgd/target-devvit

Reddit Devvit Web wrapper for the Phaser game target.

The root `pnpm build:devvit` command delegates the configured game client and
Devvit server to the official `@devvit/start/vite` plugin. The plugin emits the
client into `dist/client` and the CommonJS server bundle into
`dist/server/index.cjs`; the mpgd target build then embeds release evidence and
the effective target config. In this repository the configured game app is
`examples/phaser-starter`.

The client build emits `index.html` for the lightweight inline post preview and
`game.html` for the expanded Phaser surface. `devvit.json` maps the default and
`game` entrypoints to those documents respectively.

The game client talks to the Devvit server through the shared
`@mpgd/bridge/orpc` contract at `/api/mpgd/rpc`. The server uses the direct oRPC
Node HTTP adapter from `@mpgd/bridge/orpc/node`; Express, Hono, and Fetch request
conversion are not required. Devvit-owned menu, scheduler, trigger, and form
callbacks remain thin `/internal/...` HTTP routes and should delegate their
business logic to shared service functions. The generated target exposes only
the oRPC bridge route; the former JSON compatibility route is not generated.

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
not claim exactly-once delivery. See
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
codex mcp add devvit -- npx -y @devvit/mcp
```

Restart Codex or begin a new task after registering it. Use `devvit_search`
before broad Devvit documentation exploration. Use the experimental
`devvit_logs` tool for a deployed app and subreddit when diagnosing production
or playtest behavior, and confirm its findings with local tests and
`devvit playtest`.

The MCP server is an agent-side aid only. It is not required by the game build,
must not be bundled into target artifacts, and does not replace Devvit CLI
authentication or the repository's release checks.
