---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/adapter-capacitor: minor (Added)
npm/@mpgd/game-services: minor (Changed)
---

Restore Purchases now reaches restore sharing after a reinstall or on a new device. `GetAvailablePurchasesInput.restore?: boolean` (and `StoreSdkGetAvailablePurchasesInput.restore`, which `createStoreCommerceProvider` passes through) marks the player's explicit Restore Purchases read: a store whose recovery list hides owned non-consumables (Google Play's acknowledged items, StoreKit entitlements bound to another app account token) lists them too. The commerce reconciler's `restorePurchases()` makes that read (an event provider directly, a polled one through the pass it runs), so those purchases reach the backend as discovered purchases with `intent: 'restore'`; `start()`, `reconcile()`, and event passes keep the recovery read, so an acknowledged durable is not resent on every launch. Providers without such a filter ignore the field. The commerce bridge payload schema for `commerce.v2.getAvailablePurchases` accepts `restore`; a bridge host built before it rejects the field, so update host and game bundles together.
