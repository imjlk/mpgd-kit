# @mpgd/target-devvit

Reddit Devvit Web wrapper for the Phaser game target.

The root `pnpm build:devvit` command builds the configured game app with
`APP_TARGET=reddit`, embeds the effective target config, copies the game bundle
to `apps/target-devvit/dist/client`, and builds the Devvit server bundle to
`apps/target-devvit/dist/server/index.cjs`. In this repository that configured
game app is `examples/phaser-starter`.

The client build emits `index.html` for the lightweight inline post preview and
`game.html` for the expanded Phaser surface. `devvit.json` maps the default and
`game` entrypoints to those documents respectively.

The game client talks to the Devvit server through the shared
`@mpgd/bridge/orpc` contract at `/api/mpgd/rpc`. The older JSON bridge endpoint
at `/api/mpgd/bridge` remains available for compatibility, but new
`PlatformGateway` traffic uses the oRPC transport by default. Adapter callers can
override the oRPC route with `rpcEndpoint`; the existing `endpoint` option keeps
targeting the legacy JSON bridge.

Server actions and schedulers that create repeatable custom posts can use the
Redis-backed wrapper in `src/server/postOperationStore.ts` with
`@mpgd/adapter-devvit/server`. The coordinator is duplicate-safe and
ambiguity-safe: it records an attempt before calling Reddit, then returns
`reconciliation-required` for an uncertain outcome without blindly posting again.
An explicit recovery endpoint or scheduler calls `reconcile`. The coordinator does
not claim exactly-once delivery. See
[Devvit durable post operations](../../docs/DEVVIT_DURABLE_POST_OPERATIONS.md) for
the operation, retry, and launch-metadata contract.

Local Reddit playtest still needs a Devvit login token:

```bash
pnpm --dir apps/target-devvit whoami
pnpm build:devvit
pnpm --dir apps/target-devvit dev
```

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
