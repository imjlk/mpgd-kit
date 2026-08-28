# MPGD Apps in Toss Target

This package owns the Apps in Toss WebView wrapper and bridge.

Current scope:

- SDK 3 `apps-in-toss.config.ts`
- `ait build` script
- SDK-backed anonymous game identity through `User.getAnonymousKey()`
- persistent progress through the native `Storage` API
- SDK-backed sharing and Ads 2.0 callbacks
- Game Center leaderboard bridge methods
- fail-closed commerce until a game installs verified purchase callbacks
- no iframe embedding

The game build is copied into `public/game` by `pnpm build:ait`. The wrapper
loads that bundle into the same document after installing the Apps in Toss
bridge, and rewrites entry HTML `/assets/*` references to `/game/assets/*`.
The target build also mirrors the copied game's `assets` directory to
`public/assets` so root-absolute runtime asset requests still resolve during
local wrapper-browser sessions without iframe embedding.

The wrapper installs `installAitSafeAreaCssVariables()` before the game mount.
It mirrors the official WebView `SafeArea.get()` and `SafeArea.subscribe()`
values into `--mpgd-safe-area-top`, `right`, `bottom`, and `left`, and exposes
`--mpgd-ait-navigation-content-top` for a full-width HUD below transparent game
navigation controls. CSS `env(safe-area-inset-*)` remains the local and
older-host fallback. Custom wrappers should import the installer from
`@mpgd/adapter-ait/safe-area` instead of reading the SDK inside a Phaser scene.
The 52px navigation band and 10px edge gap match the current game navigation
treatment; wrappers with measured custom host geometry can override both
values through the installer options.

The production bridge maps the stable anonymous `User.getAnonymousKey()` hash
to `PlatformGateway.identity.getPlayer()` and serializes gateway storage values
through the native `Storage` API. `dev` and `dev:plain` install a deliberately
limited local SDK mock for browser layout work only; they do not validate native
identity, IAP, promotion, or ad behavior. `dev:sandbox` explicitly disables that
mock and fixed identity so the official Apps in Toss Sandbox host can inject its
native SDK. Games must provide their own staging commerce and authority settings
to that process. Game identity requires Toss app 5.232.0 or newer, while Game
Center requires Toss app 5.221.0 or newer. Verify IAP in the Sandbox and then
verify the uploaded bundle through the Toss-app QR before publishing.

SDK 3 bundles require API servers to allow both the production
`https://<appName>.web.tossmini.com` origin and the QR-test
`https://<appName>.private-web.tossmini.com` origin. Releasing SDK 3 is
irreversible for that app: a later release cannot roll back to SDK 2. Complete
the QR test and CORS verification before publishing.

Purchases remain unavailable until a game configures the authoritative IAP
contract. The generic bridge intentionally supports only one-time consumable
and non-consumable products; subscription purchase, renewal, and expiry require
their own server-authoritative lifecycle and remain hidden until that contract
exists. Rewarded Ads 2.0 must be preloaded and only return completion after
the native `userEarnedReward` event and dismissal; dismissal by itself never
grants. The returned callback envelope remains evidence only. Use the public
`@mpgd/game-services/apps-in-toss-evidence-verification` boundary with a
partner-server authority before granting catalog products or rewards. The
generic `createGameServicesClient().purchase()` path runs too late for the SDK
callback; wire `createAppsInTossProductGrantCallback()` directly into
`processProductGrant` with an abort-aware verification port that enforces the
helper's 25-second ledger deadline. Construct that nominal port with
`createAppsInTossProductGrantVerificationPort()`; the legacy one-argument
backend API is intentionally not accepted. The purchase authority is
responsible for authenticated Toss-login identity and the mTLS order-status
lookup; the reward authority validates a game-issued correlation id because the
official `userEarnedReward` event has no impression id. The game-owned reward
authority, not `userEarnedReward`, returns the explicit-zone verification
timestamp. Purchase success events occur too late to grant; only the
product-grant callback and pending-order restore are accepted.
See
[Apps in Toss Production Evidence](../../docs/APPS_IN_TOSS_PRODUCTION_EVIDENCE.md)
for pending-order restoration, product-grant completion, sandbox scenarios, and
runtime-only credential requirements.

Game targets that set `authoritativeGameServices: false` keep native identity,
storage, sharing, and Game Center while their effective config disables IAP and
ads. Set the flag to `true`, add app-owned product/ad ids, and configure the
public HTTPS game-services backend before enabling authoritative grants.
