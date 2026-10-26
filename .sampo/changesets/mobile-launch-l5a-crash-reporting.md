---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/adapter-capacitor: minor (Added)
npm/@mpgd/cli: minor (Added)
---

Crash reporting for the Capacitor shells. `@mpgd/platform/crash-reporting` adds the `CrashReporter` port (`recordError`, `log`, `setCollectionEnabled`, `getStatus`), redaction and stack-frame helpers, and `installCrashErrorCapture` for WebView `error` and `unhandledrejection` events; `PlatformGateway` gains an optional `crashReporter`. `@mpgd/adapter-capacitor` implements it on Firebase Crashlytics (`@capacitor-firebase/crashlytics` 8.x, a new optional peer reached by its registered plugin name, so games do not depend on the npm package): `createCapacitorPlatformGateway` exposes `crashReporter` and, when the shell has the plugin, reports uncaught errors and unhandled rejections as non-fatal (`crashReporting: false` opts out). Reports carry only the target, build id, app version, and adapter; never a player id. `mpgd target init capacitor --providers crash-reporting` installs the plugin into the shell and the Crashlytics Gradle plugin 3.0.8 into a newly generated Android project, and refuses an existing Android project without that Gradle plugin, whose app would stop at startup. Games and shells that do not request the provider are unchanged.
