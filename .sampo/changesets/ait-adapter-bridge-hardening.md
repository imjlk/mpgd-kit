---
npm/@mpgd/adapter-ait: patch
---

Harden the Apps in Toss host bridge: reject game `storage.save`/`storage.load` keys under the adapter-reserved `mpgd:ait:` prefix so game code cannot forge completed purchase or promotion markers, bound the client-supplied rewarded-ad `idempotencyKey` to 1-256 visible characters and document it as evidence the backend reward authority must verify, restrict `fetchAitAuthority` to `https:` resources (plain `http:` only for `localhost`/`127.0.0.1`), and cap launch-intent `puzzleId`/`challengeToken` values and nested `queryParams` size and entry count.
