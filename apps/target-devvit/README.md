# @mpgd/target-devvit

Reddit Devvit Web wrapper for the Phaser game target.

The root `pnpm build:devvit` command builds the configured game app with
`APP_TARGET=reddit`, embeds the effective target config, copies the game bundle
to `apps/target-devvit/dist/client`, and builds the Devvit server bundle to
`apps/target-devvit/dist/server/index.cjs`. In this repository that configured
game app is `examples/phaser-starter`.

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
