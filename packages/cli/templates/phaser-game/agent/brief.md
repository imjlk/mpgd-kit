# __GAME_TITLE__ Brief

Build a Phaser 4 game on top of the mpgd platform boundary.

Boundaries:

- Phaser scenes render and collect input only.
- Target services go through `PlatformGateway`.
- Purchases, rewarded ad grants, and leaderboard records should go through
  backend ledger APIs before mutating durable game save state.
- Platform SDK imports belong in adapters or target wrappers.
- Orientation policy should be chosen before adding resize behavior; treat
  locked modes as soft prompts unless a platform adapter supports hard locks.

Useful commands:

```sh
pnpm dev
pnpm check
pnpm build
pnpm icons:generate
pnpm icons:verify
pnpm exec mpgd target build-all --targets-file ./mpgd.targets.json --kit-path ../mpgd-kit --targets web,microsoft-store,verse8,ait,reddit --profile staging --ait-variant wrapper
pnpm devvit:login
pnpm devvit:init
pnpm devvit:playtest
```
