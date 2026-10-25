---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

iOS shells declare export compliance. `mpgd target init capacitor` writes `ITSAppUsesNonExemptEncryption` = false into a newly generated iOS project's `Info.plist` (keeping a value the game already set) and replaces the template's 32-bit `armv7` device capability with `arm64`; a native build warns when an existing shell lacks either. The TestFlight submission now reads the build's TestFlight internal state (`asc builds build-beta-detail view`) after processing: a build waiting for the export-compliance answer is `action-required`, a still-processing one is `processing`, and only `READY_FOR_BETA_TESTING`/`IN_BETA_TESTING` builds are added to the internal group and can be `testflight-ready`.
