---
npm/@mpgd/platform: minor
npm/@mpgd/adapter-browser: minor
npm/@mpgd/game-runtime: minor
npm/@mpgd/target-config: minor
npm/@mpgd/catalog: patch
npm/@mpgd/cli: minor
---

Add a CrazyGames web target and the browser adapter's `/crazygames` entry point with official v3 SDK initialization, loading/gameplay reporting, and interstitial ads using the shared presentation contract. Basic Launch keeps monetization disabled; Full Launch enables configured interstitial placements. Rewarded ads and purchases remain unavailable pending independent backend verification. Generated starters enter free play directly and retain scene, lifecycle, and native presentation ownership through game-owned gameplay scopes.
