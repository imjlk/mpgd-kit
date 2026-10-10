---
npm/@mpgd/game-services: patch
---

Fix the Google Play Publisher and ONE play purchase clients on Cloudflare
Workers, which reject `redirect: 'error'`. Requests now use `redirect: 'manual'`,
and any redirect response is still rejected instead of being treated as success.
