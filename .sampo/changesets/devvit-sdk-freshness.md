---
npm/@mpgd/cli: minor
npm/@mpgd/adapter-devvit: patch
---

Check current stable Devvit SDK and CLI versions before target upload, publish, and playtest, including every directly declared `devvit` / `@devvit/*` package and the adapter-resolved SDK. Fail before upload on stale installs or unavailable registry checks; preserve exact pins and require rebuilding after upgrades. Update the adapter and starter to Devvit 0.15.0.
