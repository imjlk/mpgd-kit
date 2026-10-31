---
npm/@mpgd/phaser-assets: minor (Added)
---

Add opt-in `@mpgd/phaser-assets/residency` for keeping fixed-key asset groups (images, spritesheets, atlases, JSON, binary, audio) resident under a decoded-byte budget across scene changes. Owners claim groups, with scene-shutdown release and `dependsOn` closures. Released groups stay warm until room is needed, then go least-recently-used first. Claims evict against estimates before loading, and prefetch only fills free budget. Runtime-generated textures can be attached to a group's lifetime. The engine-free policy is exported from `@mpgd/phaser-assets/residency-policy`. Existing entrypoints are unchanged.
