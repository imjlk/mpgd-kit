---
npm/@mpgd/game-services: minor (Changed)
npm/@mpgd/adapter-capacitor: minor (Changed)
npm/@mpgd/capacitor-game-services: minor (Changed)
---

AR1 behaviour changes for outside callers. The FCM provider now refuses routing data keys that start with `mpgd.` (`rejected`, reason `configuration`), which the Android advertising renderer uses. The Capacitor notifications provider leaves `mpgd.` keys out of an open's `data`. `CapacitorGameServicesPlugin` gains `getAdvertisingPushRenderer()`, so a hand-written mock of the interface needs it.
