---
npm/@mpgd/cli: patch (Changed)
---

Generated games now pin `@capacitor/core` 8.6.2 and `@capacitor/app` 8.1.2 (from 8.5.2 and 8.1.1), so `mpgd target init capacitor` gives a new shell `@capacitor/android`, `@capacitor/ios`, and `@capacitor/cli` 8.6.2. `--providers notifications` adds `@capacitor-firebase/messaging` 8.6.0 and `--providers crash-reporting` adds `@capacitor-firebase/crashlytics` 8.6.0 (from 8.5.2) when the game or shell does not list them yet. An existing game keeps the Capacitor and plugin versions it already pins.
