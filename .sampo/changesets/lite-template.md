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

Until the private lite-shell package is initially published, lite generation
requires `--workspace`. Generated lite guidance identifies Canvas2D ownership.
Windows template paths are normalized before overlay selection, and persisted
browser history navigation keeps the game alive. Inline budgets include static
and stylesheet imports even when a filename appears in `deferredChunks`; only
dynamic-import edges can be deferred.
