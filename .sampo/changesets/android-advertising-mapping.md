---
npm/@mpgd/catalog: patch
npm/@mpgd/game-services: patch
---

An advertising topic must not map to `android` until the shell renders the opt-out action. `validateNotificationTopicCatalog` reports that mapping, and a notifications service will not start on a catalog that has it. iOS advertising mappings are unchanged. The Android client still declares `advertising` so it pairs with the standard FCM registry.
