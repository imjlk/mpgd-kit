---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

`mpgd deploy run` stamps the reserved Android `versionCode`/`versionName` and iOS `CURRENT_PROJECT_VERSION`/`MARKETING_VERSION` into the build's staged copy of the native shell, so a release no longer needs a commit of the next numbers. The source shell keeps every other identity check (package/bundle ID, suffixes, setters, xcconfig), and the signed AAB or archived app and IPA are still checked against the reserved numbers. Manual `mpgd target build` runs opt in with `MPGD_NATIVE_VERSION_STAMP=1`; without it the source must hold the exact numbers, as before.
