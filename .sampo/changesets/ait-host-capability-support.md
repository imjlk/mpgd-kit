---
npm/@mpgd/adapter-ait: patch (Fixed)
---

Treat missing Apps in Toss Ads 2.0 support constants as an unsupported capability instead of
failing the game wrapper during startup. Preload and display requests remain fail-closed until
both native full-screen ad APIs report support.
