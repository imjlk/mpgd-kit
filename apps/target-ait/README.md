# MPGD Apps in Toss Target

This package owns the Apps in Toss WebView wrapper and bridge.

Current scope:

- SDK 2.x-compatible `granite.config.ts`
- `ait build` script
- Game Center leaderboard bridge methods
- no iframe embedding

The game build is copied into `public/game` by `pnpm build:ait`. A follow-up should wire the copied game bundle into the wrapper without iframe usage.
