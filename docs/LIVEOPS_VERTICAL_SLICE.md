# LiveOps Vertical Slice

The reusable monetization and social path is ledger-first:

1. A target adapter collects platform evidence.
2. `@mpgd/liveops-client` submits that evidence to backend APIs.
3. Backend verifier or ledger packages decide whether a grant or score is accepted.
4. Game save state changes only after the backend response is accepted.

This keeps client callbacks from becoming the source of truth.

## Packages

- `@mpgd/liveops-client`: reusable client orchestration for purchase, rewarded ad,
  and leaderboard score flows.
- `@mpgd/backend-purchase-verifier`: verifies product availability and records
  purchase grants in the entitlement ledger.
- `@mpgd/backend-ad-reward-ledger`: records rewarded ad grants from completed
  rewarded placements.
- `@mpgd/backend-leaderboard-ledger`: records idempotent leaderboard score
  submissions.
- `@mpgd/backend-entitlement-ledger`: shared idempotent grant ledger.

The in-repo demo uses in-memory backend implementations. Production should replace
the same interfaces with HTTP clients that call real backend endpoints.

## Target Notes

- Android purchase flow should follow Google Play Billing's server verification,
  grant, then acknowledge or consume sequence.
- iOS purchase flow should send StoreKit/App Store signed transaction evidence to
  the backend verifier.
- Apps in Toss IAP should support pending order recovery and complete product
  grant after partner backend grant succeeds.
- Rewarded ads should treat SDK reward callbacks as evidence. For AdMob-backed
  targets, server-side verification callbacks should be the backend grant signal.
- Apps in Toss rewarded ads must follow `loadFullScreenAd` then `showFullScreenAd`;
  rewards are tied to `userEarnedReward`, not `dismissed`.

## Smoke

```sh
pnpm smoke:liveops
```

The smoke runs Android, iOS, and Apps in Toss target simulations through purchase,
rewarded ad, and leaderboard flows. It asserts that purchase and reward grants
appear in the entitlement ledger and that leaderboard submissions appear in the
leaderboard ledger.
