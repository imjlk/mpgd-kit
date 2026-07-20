---
npm/@mpgd/adapter-ait: patch (Fixed)
---

Treat a missing Apps in Toss operational-environment support constant as an unsupported Game
Center capability instead of failing wrapper startup. Leaderboard submission and opening remain
disabled until the host can verify the minimum native version.
