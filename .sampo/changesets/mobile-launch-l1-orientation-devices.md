---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

Native shells follow the game's design orientation and iOS device family. `mpgd.game.json` takes `native.orientation` (`portrait`, `landscape` or `any`; the Phaser template sets `landscape`) and the ios target in `mpgd.targets.json` takes `metadata.iosDeviceFamily` (`universal`, the default, or `iphone`). `mpgd target init capacitor` writes them into newly generated projects: the iPhone `UISupportedInterfaceOrientations` (iPad keeps all four, as Apple's TN3192 asks), `TARGETED_DEVICE_FAMILY`, and the Android launcher's `android:screenOrientation` plus `android:appCategory="game"`, which keeps the lock on Android 16 large screens. A native build fails in `production` when an existing shell contradicts a configured setting.
