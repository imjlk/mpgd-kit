---
npm/@mpgd/adapter-devvit: minor (Added)
npm/@mpgd/cli: patch (Changed)
npm/@mpgd/create-game: patch (Changed)
---

The Devvit notifications service's own work runs on the Devvit scheduler. `@mpgd/adapter-devvit/server` adds `devvitNotificationSchedulerTasks` (`mpgd-notifications-dispatch` every minute and `mpgd-notifications-purge` every five minutes, with their `/internal/scheduler/...` endpoints), `devvitNotificationTaskForEndpoint`, and `runDevvitNotificationTask(service, task)`. A dispatch run is one `runScheduler` run of the service, so server reminders and consent notice pushes fire on Devvit along with the due sends: rounds of at most 10 due schedule entries and 10 due sends, starting no round after 20 seconds. A purge run deletes at most the store's `purgeLimit` rows of each kind; `createDevvitNotificationService` now builds its Redis store with `purgeLimit` 200 unless `storeOptions` names one. The generated Devvit app declares both tasks in `devvit.json` and routes them through `src/server/notificationTasks.ts`; without a notifications service the tasks do no work.
