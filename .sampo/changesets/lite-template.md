---
npm/@mpgd/cli: minor
---

`mpgd game create` adds `--template lite` (default `phaser`) and
`--renderer canvas` for a Phaser-free starter. The lite template reuses every
platform gateway, target wrapper, and release workflow of the Phaser template,
drops the Phaser scenes and asset manifest, depends on `@mpgd/lite-shell`, and
makes the Devvit inline surface playable with the same lite shell. Devvit
targets accept optional `inlineEntry` and `inlineBudget`
(`maxGzipKb`, `forbidModules`, `deferredChunks`); `mpgd target smoke` checks
the inline first-load graph only when `inlineEntry` is set, so existing
targets are unchanged.
