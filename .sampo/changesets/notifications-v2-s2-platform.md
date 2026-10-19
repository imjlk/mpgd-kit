---
npm/@mpgd/platform: minor
---

`NotificationConformanceReminderSetStatus` gains `capacity-exceeded` and `unavailable`, which a backend under test may answer when it caps a player's pending server reminders or when no provider the player can be reached on maps the topic. The fake backend answers neither; the reference runtime passes them through as the reminder's status.
