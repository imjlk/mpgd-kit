---
npm/@mpgd/adapter-devvit: minor (Added)
---

`@mpgd/adapter-devvit/server` adds `createDevvitRedisNotificationStore`, a `NotificationStore` for the notifications v2 service of `@mpgd/game-services/notifications` over Devvit Redis. Each atomic step is one WATCH/MULTI/EXEC transaction, so a send is written only while it still has the version the caller read: a claim whose lease another worker took over cannot write its answer back. It implements the S2 scheduler steps too: schedule entries with a due index (ties by player, then id, in code-point order), `countPendingReminders`, `countHistory` per provider (counted by rank), and `pruneConsent` with the notices given about the pruned records, in one transaction. A time that does not parse is refused with a `TypeError` before anything is written. It passes `runNotificationStoreConformance`.
