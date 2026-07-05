# __GAME_TITLE__ Brief

Build a Phaser 4 game on top of the mpgd platform boundary.

Boundaries:

- Phaser scenes render and collect input only.
- Target services go through `PlatformGateway`.
- Purchases, rewarded ad grants, and leaderboard records should go through
  backend ledger APIs before mutating durable game save state.
- Platform SDK imports belong in adapters or target wrappers.

Useful commands:

```sh
pnpm dev
pnpm check
pnpm build
pnpm --dir ../mpgd-kit mpgd target build-all --targets-file "$PWD/mpgd.targets.json" --targets web,ait --ait-variant wrapper
```
