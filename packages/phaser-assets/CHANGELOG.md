# @mpgd/phaser-assets

## 0.6.0 — 2026-09-14

### Minor changes

- [5ff0813](https://github.com/imjlk/mpgd-kit/commit/5ff08137ab98e7ec02609207ba41f874918dc947) Separate pack file delivery from texture preparation. `createPhaserAssetPackLoader`
  now accepts an optional `fileSource` implementing the public `PhaserPackFileSource`
  contract: per-file `open` → `read` → body `release`/`close` lifecycles keyed on
  `{ packId, revision, assetKey, role }`, with cancellation and shared transfer/byte
  budgets through the file context. Integrity verification (declared size equality
  and SHA-256), the `maxFileBytes` cap, byte admission, decoding, texture
  registration and lease ownership remain loader responsibilities for every source.
  The default URL transport keeps `resolveURL`, `requestCache`, deadlines, retries
  and streaming caps unchanged; omitting `fileSource` preserves the existing API
  and behavior. — Thanks @imjlk!
- [66e572d](https://github.com/imjlk/mpgd-kit/commit/66e572dce7eb4a0bbbd097bf40a9ee47db44ec6b) Add `mpgd assets build-packs` for deterministic asset pack delivery builds.
  A JSON build config (image, spritesheet and JSON atlas assets with pack ids,
  logical revisions, dependencies and per-asset compression overrides) produces
  individual files or per-pack ZIP artifacts plus an external versioned delivery
  manifest: per-file media types, original bytes and SHA-256 digests, archive
  digests, entry methods and counts. ZIP v1 uses STORE/DEFLATE only with fixed
  metadata for reproducible bytes; pack artifacts are immutable per revision
  while the manifest tracks the latest successful build. The new
  `@mpgd/phaser-assets/pack-format` subpath publishes the shared pure contract
  (types, untrusted-input validation, entry path rules) free of Node, DOM, Phaser
  and compression concerns, and the CLI now depends on the package at runtime. — Thanks @imjlk!

## 0.5.0 — 2026-09-14

### Minor changes

- [832638b](https://github.com/imjlk/mpgd-kit/commit/832638b072639946b605a5794eae71b86b44a059) Add the opt-in `@mpgd/phaser-assets/packs` entrypoint for reusable image,
  spritesheet and JSON atlas packs. Acquire shared dependency textures with
  per-caller cancellation, preparation deadlines, bounded file retries and optional
  size/SHA-256 verification; release them explicitly or on scene shutdown.
  Existing manifest and enqueue helpers remain compatible.
  
  Isolate cleanup failures and bound acquisition with separate request deadlines, download/decode permits and encoded-byte reservations. — Thanks @imjlk!

## 0.4.1 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

## 0.4.0 — 2026-07-08

### Added

- [33f2598](https://github.com/imjlk/mpgd-kit/commit/33f259881be5932e3f155dfc17c3b75f6f78da09) Add target-portable Phaser asset manifest helpers that accept Vite-emitted asset URLs for generated games. — Thanks @imjlk!

