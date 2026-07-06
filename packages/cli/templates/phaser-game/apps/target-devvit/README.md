# __GAME_TITLE__ Devvit Target

This directory is the Reddit Devvit app root for `__GAME_NAME__`.

`devvit.json` belongs to the generated game, not to the mpgd-kit checkout. That keeps the
Reddit app name, menu entry, upload history, and playtest state owned by this game.
Its `name` is generated as a Devvit-safe slug; edit it before `pnpm devvit:init`
if you want a different Reddit app name.

## First Playtest

```sh
pnpm install --filter . --filter ./apps/target-devvit
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
