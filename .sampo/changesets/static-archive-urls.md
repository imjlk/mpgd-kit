---
npm/@mpgd/phaser-assets: patch
---

Preserve literal @ in artifact URL paths so pack archives load on static hosts
that do not percent-decode request paths, while encoding unsafe characters once.
