---
npm/@mpgd/phaser-assets: minor
---

Add the opt-in `@mpgd/phaser-assets/packs` entrypoint for reusable image,
spritesheet and JSON atlas packs. Acquire shared dependency textures with
per-caller cancellation, preparation deadlines, bounded file retries and optional
size/SHA-256 verification; release them explicitly or on scene shutdown.
Existing manifest and enqueue helpers remain compatible.

Isolate cleanup failures and bound acquisition with separate request deadlines, download/decode permits and encoded-byte reservations.
