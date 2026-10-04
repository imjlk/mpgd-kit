---
npm/@mpgd/game-services: patch
---

`createAppsInTossProductionEvidenceVerifier` now rejects purchases whose catalog product has `type: 'subscription'` with the stable reason `APPS_IN_TOSS_SUBSCRIPTION_UNSUPPORTED`, before the order-status authority is called. This mirrors the Google Play and App Store verifiers so the Apps in Toss path no longer relies on the adapter hiding `SUBSCRIPTION` products or on target config leaving subscriptions disabled. The conformance suite gains a `purchase-subscription-unsupported` scenario.
