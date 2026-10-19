---
npm/@mpgd/adapter-ait: minor (Added)
npm/@mpgd/cli: minor (Changed)
npm/@mpgd/create-game: minor (Changed)
---

`@mpgd/adapter-ait/notification-config` exports `extractAitNotificationTopicConfig(catalog, { target, sourceLabel })`, which reads the `notificationTopics` of `installAitHostBridge` from a notification topic catalog's `targets.ait` mappings (`templateSetCode`, `agreement`). It refuses a malformed catalog, a duplicate topic, a blank template code, an unknown agreement, and an advertising topic mapped for Apps in Toss.

The generated Apps in Toss wrapper reads the game's notification topic catalog at build time (`MPGD_NOTIFICATION_TOPICS_FILE`, else `notifications/topics.json` when it exists) and passes its Apps in Toss topics to the host bridge, so notifications v2 agreements and landings work once the game maps its console templates. Without a catalog or a mapping the wrapper behaves as before.
