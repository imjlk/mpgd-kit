# MPGD Apps in Toss Target

This package owns the Apps in Toss WebView wrapper and bridge.

Current scope:

- SDK 2.x-compatible `granite.config.ts`
- `ait build` script
- SDK-backed game identity through `getUserKeyForGame`
- Game Center leaderboard bridge methods
- no iframe embedding

The game build is copied into `public/game` by `pnpm build:ait`. The wrapper
loads that bundle into the same document after installing the Apps in Toss
bridge, and rewrites entry HTML `/assets/*` references to `/game/assets/*`.
The target build also mirrors the copied game's `assets` directory to
`public/assets` so root-absolute runtime asset requests still resolve during
local devtools, phone tunnel, and wrapper-web sessions without iframe embedding.

The production bridge maps the game-specific `getUserKeyForGame()` hash to
`PlatformGateway.identity.getPlayer()`. Toss app 5.232.0 or newer is required,
and the mini-app must be registered as a game. The `dev:plain` script enables a
local identity provider explicitly with `VITE_MPGD_AIT_MOCK_IDENTITY=1`; release
builds never use that fixed local player id. Sandbox results are still provided
by the Apps in Toss SDK and should be verified with a QR test in the Toss app.

Purchase and rewarded-ad callbacks remain evidence only. Use the public
`@mpgd/game-services/apps-in-toss-evidence-verification` boundary with a
partner-server authority before granting catalog products or rewards. The
generic `createGameServicesClient().purchase()` path runs too late for the SDK
callback; wire `createAppsInTossProductGrantCallback()` directly into
`processProductGrant`. The current gateway bridge does not synthesize purchase
or reward evidence from a completed result. The purchase authority is
responsible for authenticated Toss-login identity and the mTLS order-status
lookup; the reward authority validates a game-issued correlation id because the
official `userEarnedReward` event has no impression id. See
[Apps in Toss Production Evidence](../../docs/APPS_IN_TOSS_PRODUCTION_EVIDENCE.md)
for pending-order restoration, product-grant completion, sandbox scenarios, and
runtime-only credential requirements.
