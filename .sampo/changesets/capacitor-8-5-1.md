---
npm/@mpgd/capacitor-game-services: patch
---

Require Capacitor 8.5.1: the plugin's @capacitor/core dependency range and the
Swift Package Manager pin now target capacitor-swift-pm 8.5.1, picking up the
upstream fix that blocks navigation to the internal HTTP proxy path and the
core removeListener correction. Consumers must build against Capacitor 8.5.1,
which also adopts the iOS UIScene lifecycle required by Xcode 27.
