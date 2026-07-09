# Starter Acceptance

The starter is accepted when it remains a minimal game shell and still proves the reusable mpgd wiring.

## Automated

```sh
pnpm validate:starter-workflow
pnpm --dir examples/phaser-starter check
pnpm --dir examples/phaser-starter build
```

## Manual

- The first screen shows app title, target, viewport orientation policy, effective config, player, and game-services mode.
- Pointer or Enter starts `PlayScene`.
- `PlayScene` animates from serializable simulation state.
- No scene imports Capacitor, Apps in Toss, StoreKit, Play Billing, Devvit, or ad SDK modules.
- Any purchase, rewarded ad, or leaderboard feature remains behind `PlatformGateway` and `@mpgd/game-services`.
- Orientation locks are soft prompts unless a platform adapter explicitly supplies hard-lock support.

## Apps in Toss Target

Before changing AIT behavior, use the apps-in-toss MCP and search Korean docs for:

- `웹뷰 개발`
- `인앱 결제`
- `인앱 광고`
- `샌드박스`
- `심사`
- `저장소`

AIT IAP and ad callbacks are evidence only. Backend ledger APIs remain the source of truth for grants.
