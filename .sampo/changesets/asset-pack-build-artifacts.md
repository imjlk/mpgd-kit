---
npm/@mpgd/cli: minor
npm/@mpgd/phaser-assets: minor
---

Add `mpgd assets build-packs` for deterministic asset pack delivery builds.
A JSON build config (image, spritesheet and JSON atlas assets with pack ids,
logical revisions, dependencies and per-asset compression overrides) produces
individual files or per-pack ZIP artifacts plus an external versioned delivery
manifest: per-file media types, original bytes and SHA-256 digests, archive
digests, entry methods and counts. ZIP v1 uses STORE/DEFLATE only with fixed
metadata for reproducible bytes; pack artifacts are immutable per revision
while the manifest tracks the latest successful build. The new
`@mpgd/phaser-assets/pack-format` subpath publishes the shared pure contract
(types, untrusted-input validation, entry path rules) free of Node, DOM, Phaser
and compression concerns, and the CLI now depends on the package at runtime.
