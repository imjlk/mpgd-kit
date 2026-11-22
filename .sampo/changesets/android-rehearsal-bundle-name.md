---
npm/@mpgd/cli: patch (Changed)
---

An Android `MPGD_NATIVE_BUILD_MODE=rehearsal-archive` build now writes its unsigned bundle as `app-rehearsal-unsigned.aab` in its run directory instead of `app-release.aab`, so a rehearsal cannot be mistaken for, or copied over, a signed submission bundle. Signed, staging, and development archives keep `app-release.aab`. The release manifest's `targets.<target>.artifact` records the new path, and its `nativeDelivery` record is unchanged (`rehearsal: true`). A script that assumes `app-release.aab` for a rehearsal should read the bundle path from the manifest instead.
