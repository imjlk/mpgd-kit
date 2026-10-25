---
npm/@mpgd/game-services: minor (Added)
---

Android advertising pushes the shell renders (AR1). The notifications service keeps a device registration's `rendersAdvertising` only for a target in `notificationShellRenderedAdvertisingTargets` (`android`), and under the Korean rules sends an advertising topic to an Android installation only when its latest registration says its shell renders advertising; another one is `suppressed: purpose-unsupported`. The FCM provider sends such a push as a data message without a `notification` block (`fcmShellRenderedDataKeys`: the rendered title and body, the channel, the opt-out action's title, and the expiry in epoch milliseconds, next to `topic`, `route`, and the send's data), at FCM's default normal priority, which the shell's messaging service renders with the opt-out action. Routing data keys that start with `mpgd.` are now refused before a send, as FCM's own reserved keys are. iOS sends and every other purpose are unchanged.
