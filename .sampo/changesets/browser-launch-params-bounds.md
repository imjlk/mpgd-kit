---
npm/@mpgd/adapter-browser: patch (Fixed)
---

Browser launch and inbound-share parameters now use the same caps as the Apps in Toss host: nested `queryParams` longer than 4096 characters are ignored, at most 32 nested entries are read, and each forwarded key and value is limited to 256 characters. `puzzleId` and `challengeToken` that contain an ASCII control character are dropped instead of being copied into launch or inbound-share state. Direct search parameters still win over nested ones.

`leaderboard.submitScore()` returns `{ submitted: false }`. The browser gateway does not install a native leaderboard (`nativeLeaderboard` is false), matching WeChat, Verse8, ONE play, and CrazyGames. Callers that treated `submitted: true` as proof a score was sent, including a game-services record on a browser or Microsoft Store gateway that still uses this leaderboard, no longer record a score that was never submitted.
