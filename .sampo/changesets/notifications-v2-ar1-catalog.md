---
npm/@mpgd/catalog: minor (Changed)
---

`validateNotificationTopicCatalog` accepts an advertising topic mapped to `android` when the deployment sets `shellRendersAdvertising: true`, the switch for a shell that renders advertising pushes with the opt-out action (AR1). Without it the mapping is still refused, now with a message that names the switch.
