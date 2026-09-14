# @mpgd/phaser-assets

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

