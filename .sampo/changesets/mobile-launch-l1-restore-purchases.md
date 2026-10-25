---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

Generated games show a Restore Purchases control: a lobby button in the Phaser template and a corner button in the lite template, on targets that sell through a store and have a Game Services client. It runs `monetizationRecovery.restorePurchases()` (`src/platform/restorePurchases.ts`), so grants still come only from the backend ledger, and reports how many purchases were confirmed. On the App Store and Google Play, where purchases are bound to the signed-in player, it asks the player to sign in instead of restoring without an authenticated session.
