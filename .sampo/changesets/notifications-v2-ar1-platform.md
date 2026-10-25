---
npm/@mpgd/platform: minor (Added)
---

Android advertising pushes rendered by the shell (AR1). A device registration's FCM address can say `rendersAdvertising: true`: the app renders advertising pushes itself, with the opt-out action. `NotificationDeployment.shellRendersAdvertising` says the game's shell does so on the targets in `notificationShellRenderedAdvertisingTargets` (`android`, whose FCM notification messages cannot carry actions). The policy gate takes `endpointShowsActions`; `false` makes an advertising send under the Korean rules `suppressed: purpose-unsupported`, as a registry entry without `actions` does. The JSON Schemas for the endpoint registration and the deployment carry both fields.
