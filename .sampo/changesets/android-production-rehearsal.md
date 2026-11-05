---
npm/@mpgd/cli: minor (Added)
---

Native builds accept `MPGD_NATIVE_BUILD_MODE=rehearsal-archive` for an Android production rehearsal: an unsigned AAB built from the production profile and reserved version numbers without upload credentials. Its release manifest delivery is recorded as `rehearsal: true` and is never a submission candidate. Recording a native build refuses a rehearsal manifest, and `runPinnedNativeBuild` now rejects every mode except the submission modes it is used with: `signed-archive` for Android and `store-export` for iOS (an iOS `signed-archive` is no longer accepted there). iOS production builds are unchanged.
