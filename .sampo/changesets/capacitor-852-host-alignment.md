---
npm/@mpgd/capacitor-game-services: patch
npm/@mpgd/adapter-capacitor: patch
npm/@mpgd/cli: patch
---

Use the host's Capacitor core as a peer dependency throughout the native plugin and adapter, and include it in generated game dependencies. Allow compatible Capacitor 8 Swift Package Manager versions instead of pinning the native plugin to 8.5.1. The reference mobile shell now resolves Capacitor 8.5.2 consistently across npm, Android, and iOS.
