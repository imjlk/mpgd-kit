---
npm/@mpgd/adapter-capacitor: minor (Added)
---

Android advertising pushes rendered by the shell (AR1). `createCapacitorNotificationProvider` takes `advertisingRenderer`, and `readCapacitorAdvertisingPushRenderer` from `@mpgd/adapter-capacitor/notifications` reads it from `@mpgd/capacitor-game-services`. On Android, with a catalog that maps an advertising topic, the provider reads it once and registers `rendersAdvertising: true` when the shell's messaging service is the kit's renderer, so the backend sends that installation advertising as a data message the shell shows with the opt-out action. An open from the renderer's opt-out action, which the messaging plugin reports as a `tap` with `mpgd.action` in its data, opens the topic's declared `optOutRoute`, and `mpgd.` keys never reach an open's `data`.
