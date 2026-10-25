---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

iOS shells bundle an app-level `PrivacyInfo.xcprivacy`. `mpgd target init capacitor` adds it to the App group and Resources phase of a newly generated iOS project (no tracking, no tracking domains, and no required-reason APIs, since the App target's own code uses none; Capacitor core and `@mpgd/capacitor-game-services` ship their own manifests). A native build warns when an existing shell's App target does not bundle one.
