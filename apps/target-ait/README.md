# MPGD Apps in Toss Target

This package owns the Apps in Toss WebView wrapper and bridge.

Current scope:

- SDK 2.x-compatible `granite.config.ts`
- `ait build` script
- Game Center leaderboard bridge methods
- no iframe embedding

The game build is copied into `public/game` by `pnpm build:ait`. The wrapper
loads that bundle into the same document after installing the Apps in Toss
bridge, and rewrites entry HTML `/assets/*` references to `/game/assets/*`.
The target build also mirrors the copied game's `assets` directory to
`public/assets` so root-absolute runtime asset requests still resolve during
local devtools, phone tunnel, and wrapper-web sessions without iframe embedding.
