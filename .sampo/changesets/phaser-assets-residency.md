---
npm/@mpgd/phaser-assets: minor (Added)
---

Add opt-in `@mpgd/phaser-assets/residency` for keeping fixed-key asset groups (images, spritesheets, atlases, JSON, binary, audio) resident under a decoded-byte budget across scene changes. Owners claim groups, with scene-shutdown release and `dependsOn` closures. Released groups stay warm until room is needed, then go least-recently-used first. Claims evict against estimates before loading. Prefetch only fills free budget and never evicts: a prefetched group that no longer fits when it loads is unloaded again. Audio the device cannot play, or that the game's audio config disables, counts as 0 bytes and is listed in the snapshot's `skippedAudio`. Runtime-generated textures can be attached to a group's lifetime. The engine-free policy is exported from `@mpgd/phaser-assets/residency-policy`. Existing entrypoints are unchanged.
