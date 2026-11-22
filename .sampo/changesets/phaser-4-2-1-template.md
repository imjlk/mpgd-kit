---
npm/@mpgd/cli: patch (Changed)
---

The Phaser game template now pins `phaser` 4.2.1 (from 4.2.0), a bug-fix release: the scale manager re-measures its parent on each window resize, tweens with a `startDelay` start, `stencilInvert` and framebuffer stencil clears work, and the ESM build that Vite bundles no longer throws a `ReferenceError` from `CombineColorMatrix`, `ImageLight`, or `Texture.setSmoothPixelArt`.
