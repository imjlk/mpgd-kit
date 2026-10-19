---
npm/@mpgd/adapter-ait: minor (Added)
npm/@mpgd/cli: minor (Changed)
npm/@mpgd/create-game: minor (Changed)
---

`@mpgd/adapter-ait/notification-config` exports `extractAitNotificationTopicConfig(catalog, { target, sourceLabel })`, which reads the `notificationTopics` of `installAitHostBridge` from a notification topic catalog's `targets.ait` mappings (`templateSetCode`, `agreement`). The catalog is checked with `validateNotificationTopicCatalog` from `@mpgd/catalog` (now a dependency) and the Apps in Toss registry entry, so for the Apps in Toss target the wrapper refuses what `pnpm validate:notifications` refuses, including an advertising topic mapped for Apps in Toss; other targets' mappings and the deployment are left to `pnpm validate:notifications`.

The generated Apps in Toss wrapper reads the game's notification topic catalog at build time (`MPGD_NOTIFICATION_TOPICS_FILE`, else `notifications/topics.json` when it exists) and passes its Apps in Toss topics to the host bridge, so notifications v2 agreements and landings work once the game maps its console templates. Without a catalog or a mapping the wrapper behaves as before.
