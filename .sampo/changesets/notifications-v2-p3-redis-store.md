---
npm/@mpgd/adapter-devvit: minor (Added)
---

`@mpgd/adapter-devvit/server` adds `createDevvitRedisNotificationStore`, a `NotificationStore` for the notifications v2 service of `@mpgd/game-services/notifications` over Devvit Redis. Each atomic step is one WATCH/MULTI/EXEC transaction, so a send is written only while it still has the version the caller read: a claim whose lease another worker took over cannot write its answer back. It passes `runNotificationStoreConformance`.
