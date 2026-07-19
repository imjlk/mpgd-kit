# __GAME_TITLE__ Brief

Build a Phaser 4 game on top of the mpgd platform boundary.

Read `AGENTS.md`, `agent/game-manifest.json`, and the generated
`.agents/skills/use-mpgd-kit/SKILL.md` router before changing kit-facing
capabilities or target workflows.

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
pnpm exec mpgd target build-all --targets-file ./mpgd.targets.json --kit-path ../mpgd-kit --targets __RECOMMENDED_MATRIX_TARGETS__ --profile staging --ait-variant wrapper
pnpm devvit:login
pnpm devvit:init
pnpm devvit:playtest
```

<!-- mpgd:microsoft-store:start -->
For Microsoft Store releases, use the generated
`.agents/skills/release-microsoft-store/SKILL.md` workflow. Build and preflight
the game-owned PWA before package generation, then run package acceptance on
Windows before Partner Center submission. WACK remains an optional recommended
evidence source, not a universal prerequisite.
<!-- mpgd:microsoft-store:end -->
