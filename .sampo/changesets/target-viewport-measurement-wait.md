---
npm/@mpgd/target-config: minor
npm/@mpgd/cli: patch
---

Add `measureTargetViewport` and `waitForTargetViewportMeasurement` so a game that boots inside a zero-sized surface (a hidden iframe, a collapsed embed or a background tab) starts once the host lays it out instead of failing viewport validation, and use them in the generated game template.
