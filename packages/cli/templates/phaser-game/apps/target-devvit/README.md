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

The client bundle is copied into `dist/client` by the mpgd target build. The server bridge is
compiled to `dist/server/index.cjs` and keeps Devvit SDK imports out of Phaser scenes.
The game root pins `@mpgd/cli`, so these commands use the same CLI version as the generated
starter's other `@mpgd/*` dependencies.

The default post entry uses `index.html` for a lightweight inline preview. Its
Play button requests the `game` entrypoint, which loads the separate
`game.html` Phaser document. Keep inline UI free of game runtime imports so the
card remains lightweight before expansion.

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

Keep operation definitions and `@devvit/web/server` imports inside this target
app. The canonical `{ mpgd, launch, payload }` envelope is public and untrusted;
keep private content and authoritative records in server-side storage. Exercise
first success, duplicate calls, interruption,
response loss, lease expiry with concurrent reconciliation, malformed durable
state, invalid launch metadata, and cross-scope key isolation before enabling a
scheduled or user-triggered publication flow.
