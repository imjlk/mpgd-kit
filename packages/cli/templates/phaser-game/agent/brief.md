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
pnpm exec mpgd target build-all --targets-file ./mpgd.targets.json --kit-path ../mpgd-kit --targets web,ait,reddit --ait-variant wrapper
pnpm devvit:login
pnpm devvit:init
pnpm devvit:playtest
```
