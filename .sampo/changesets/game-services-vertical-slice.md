---
npm/@mpgd/game-services-client: minor (Added)
npm/@mpgd/backend-leaderboard-ledger: minor (Added)
npm/@mpgd/backend-purchase-verifier: patch (Changed)
npm/@mpgd/backend-ad-reward-ledger: patch (Changed)
---

Add a ledger-first Game Services vertical slice for reusable purchase, rewarded ad, and leaderboard flows. Platform callbacks are now treated as evidence, while grants and score records are accepted only after backend verifier or ledger APIs respond.
