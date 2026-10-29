---
npm/@mpgd/cli: patch (Changed)
---

The Phaser template's `PlayScene` follows `runtime.actions.subscribeAvailability`: while any purchase (one from the shop included) or ad holds the screen, or the actions wait for reconciliation, its rewarded-ad hint reads `rewardNotReady` without a key press, and it returns to the hint once they are ready. The scene's own request does not show it, and a result or error text is never replaced by the hint. The key-press check of `getAvailability()` stays as the guard.
