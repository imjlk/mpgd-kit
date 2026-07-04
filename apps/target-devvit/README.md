# @mpgd/target-devvit

Reddit Devvit Web wrapper for the Phaser game target.

The root `pnpm build:devvit` command builds `apps/game-phaser` with
`APP_TARGET=reddit`, embeds the effective target config, copies the game bundle
to `apps/target-devvit/dist/client`, and builds the Devvit server bundle to
`apps/target-devvit/dist/server/index.cjs`.

Local Reddit playtest still needs a Devvit login token:

```bash
pnpm --dir apps/target-devvit whoami
pnpm build:devvit
pnpm --dir apps/target-devvit dev
```

`devvit playtest`, `devvit upload`, and `devvit publish` are intentionally kept
as local commands because they use Reddit auth state from the developer machine.
