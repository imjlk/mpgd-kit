---
npm/@mpgd/adapter-devvit: patch
---

Page Devvit paid orders until the cursor ends, and fail the listing when the scan cap leaves pages unread, so a still-paid order behind newer canceled orders is not treated as delivered. A verified-leaderboard Redis transaction now ends with a commit marker and treats an empty or nil-only EXEC as an abort.
