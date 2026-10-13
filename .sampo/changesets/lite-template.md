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

Lite generation configures its Reddit inline budget, preserves feed and history
lifecycle, removes visibility listeners on disposal, and verifies HTML content
and artifact boundaries along with linked first-load resources.
Windows template paths are normalized before overlay selection, and persisted
browser history navigation keeps the game alive. Inline budgets include static
and stylesheet imports even when a filename appears in `deferredChunks`; only
dynamic-import edges can be deferred.

Explicit game disposal releases its owned audio binding, runtime and shell once. HTML first-load asset tags and attributes are matched case-insensitively.

HTML media and preload bytes count toward the inline budget. LiteShell size and resize notifications report the Canvas renderer's effective DPR, and repeated fits skip redundant backing-store resizes.

Responsive image candidates count conservatively toward the first-load budget, while data URLs remain embedded in the HTML byte count. Canvas DPR caps must be positive and finite. Inline layouts reserve all four native safe-area insets, including short screens, in both the example and generated lite template.

Only primary pointer activations trigger gameplay taps. Generated Devvit guides substitute the game's title and slug.
