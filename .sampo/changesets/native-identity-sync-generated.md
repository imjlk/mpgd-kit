---
npm/@mpgd/cli: patch (Fixed)
---

Production native builds no longer fail on a clean checkout because the Android release preflight required `capacitor-cordova-android-plugins/cordova.variables.gradle` before `cap sync` generated it. The source check now tolerates only missing scripts in that git-ignored directory; the staged shell still requires and inspects every applied script after sync. The preflight also accepts the standard `clean` task when it deletes `rootProject.layout.buildDirectory`.
