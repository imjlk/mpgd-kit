---
npm/@mpgd/capacitor-storekit: patch (Changed)
---

Bump the pinned OpenIAP Apple core to `4.0.7` (from `4.0.5`; the SwiftPM pin stays exact). Upstream, the core no longer finishes inactive (expired, revoked, or upgraded) auto-renewable subscription transactions on its own, so it no longer finishes any transaction unless asked (the plugin never enables its automatic finish). The plugin sells only consumables and non-consumables, so purchases, recovery, revocation events, and the finish gate behave as before. A game rebuilding its iOS app resolves the new tag through SwiftPM on the next `cap sync ios`.
