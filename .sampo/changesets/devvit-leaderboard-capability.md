---
npm/@mpgd/adapter-devvit: patch (Fixed)
npm/@mpgd/target-config: patch (Fixed)
npm/@mpgd/cli: patch (Fixed)
npm/@mpgd/create-game: patch (Fixed)
---

Stop advertising a native Devvit leaderboard and disable the generic client
score submission path in both the shared target and generated starters. Devvit
games continue to use the server-only verified leaderboard provider from
authoritative completion handlers.
