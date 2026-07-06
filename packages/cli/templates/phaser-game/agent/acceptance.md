# Acceptance

Run these checks before handing off a generated game starter:

```sh
pnpm check
pnpm build
pnpm --dir ../mpgd-kit mpgd target build-all --targets-file "$PWD/mpgd.targets.json" --targets web,microsoft-store,ait,reddit --ait-variant wrapper
pnpm --dir ../mpgd-kit mpgd target smoke-all --targets-file "$PWD/mpgd.targets.json" --targets web,microsoft-store,ait,reddit
pnpm --dir ../mpgd-kit mpgd target doctor --targets-file "$PWD/mpgd.targets.json" --targets web,microsoft-store,ait,reddit
```

For Apps in Toss changes, use the apps-in-toss MCP before implementation and
keep SDK calls inside adapters or target wrappers.

For Reddit Devvit changes, keep Devvit SDK calls inside the target wrapper and
continue to expose game-facing behavior through `PlatformGateway`. The Devvit
app root is game-owned in `apps/target-devvit`; run `pnpm devvit:init` once
after login before upload or playtest.

For Microsoft Store changes, keep the first pass as a PWA/web target that uses
the browser adapter. Add a dedicated Store commerce adapter only when wiring
Digital Goods API and Payment Request through backend ledger verification.
