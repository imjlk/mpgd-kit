# __GAME_TITLE__ Devvit Target

This directory is the Reddit Devvit app root for `__GAME_NAME__`.

`devvit.json` belongs to the generated game, not to the mpgd-kit checkout. That keeps the
Reddit app name, menu entry, upload history, and playtest state owned by this game.
Its `name` is generated as a Devvit-safe slug; edit it before `pnpm devvit:init`
if you want a different Reddit app name.

## First Playtest

```sh
pnpm install -w
pnpm devvit:login
pnpm devvit:whoami
pnpm devvit:init
pnpm build:devvit
pnpm devvit:playtest
```

`devvit:init` performs the first App Directory upload/link step with Devvit's
logged-in account. It may open a browser for authorization. Use
`pnpm devvit:init:copy-paste` from the game root if the browser flow is not
available and the CLI asks for a manual code. After that, use
`pnpm devvit:playtest`, `pnpm devvit:upload`, and `pnpm devvit:publish` from the
game root.

The official `@devvit/start/vite` plugin builds the game client into
`dist/client` and the CommonJS server bridge into `dist/server/index.cjs` in one
pass. The mpgd target build wraps that unified build with release provenance and
effective-target evidence while keeping Devvit SDK imports out of Phaser scenes.
The game root pins `@mpgd/cli`, so these commands use the same CLI version as the
generated starter's other `@mpgd/*` dependencies.

The bridge endpoint at `/api/mpgd/rpc` uses the direct oRPC Node HTTP adapter
from `@mpgd/bridge/orpc/node`; Express, Hono, and Fetch request conversion are
not required. Devvit-owned menu, scheduler, trigger, and form callbacks remain
thin `/internal/...` routes and delegate to shared service functions. oRPC
Publisher helpers can broadcast results after a task completes, but they do not
replace the `devvit.json` scheduler endpoint and should not use process-local
memory when delivery must cross instances. The generated target exposes only
the oRPC bridge route; the former JSON compatibility route is not generated.

The default post entry uses `index.html` for a lightweight inline preview. Its
Play button requests the `game` entrypoint, which loads the separate
`game.html` Phaser document. Keep inline UI free of game runtime imports so the
card remains lightweight before expansion.

The generated bridge does not advertise or accept a generic platform
leaderboard. Devvit ranking should be owned by a server completion handler that
validates the game-specific attempt, records it through the verified leaderboard
provider from `@mpgd/adapter-devvit/server`, and exposes only an authenticated
game-scoped snapshot route. Do not enable `nativeLeaderboard` or trust a raw
client score submission for that flow.

`devvit playtest` runs the official unified Vite build in watch mode, so a
separate client/server watcher or staging prebuild is not required.

## Durable Post Operations

Use `src/server/postOperationStore.ts` with `@mpgd/adapter-devvit/server` for a
server action or scheduler that may receive the same custom-post operation more
than once. Use `{ appScope, subredditId }` as the scope, a stable `operationType`
in the definition, and an `operationId` for each logical publication slot. Validate
the public payload and launch parameters, then inject the Redis-backed store into
`createDevvitPostOperationCoordinator`.

The contract is duplicate-safe and ambiguity-safe, not exactly-once. It persists
the attempt before invoking Reddit. If Reddit accepts the post but its response is
lost, or the process stops before the receipt is saved, repeating `execute` returns
`reconciliation-required` and never blindly calls the submit function again. An
explicit recovery endpoint or scheduler calls `reconcile`, which requires an exact
match of the full canonical envelope. A missing match from a bounded listing
remains unresolved rather than restoring submit permission.

The generated Redis wrapper implements `DevvitIndexedDurableOperationStore`.
Use `listPending()` with a small limit and its scope-bound continuation cursor to
discover prepared, attempted, and terminal work without scanning Redis keys.
Listing is read-only; prepared work still requires an explicit `execute` decision,
attempted work must use `reconcile`, and terminal ambiguity remains fail-closed.

Keep operation definitions and `@devvit/web/server` imports inside this target
app. The canonical `{ mpgd, launch, payload }` envelope is public and untrusted;
keep private content and authoritative records in server-side storage. Exercise
first success, duplicate calls, interruption,
response loss, lease expiry with concurrent reconciliation, malformed durable
state, invalid launch metadata, and cross-scope key isolation before enabling a
scheduled or user-triggered publication flow.

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
`pnpm devvit:playtest`.

The MCP server is an agent-side aid only. It is not required by the generated
game build, must not be bundled into target artifacts, and does not replace
Devvit CLI authentication or release verification.
