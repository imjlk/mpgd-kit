---
npm/@mpgd/adapter-ait: patch (Changed)
npm/@mpgd/adapter-browser: patch (Changed)
npm/@mpgd/adapter-capacitor: patch (Changed)
npm/@mpgd/adapter-devvit: patch (Changed)
npm/@mpgd/adapter-verse8: patch (Changed)
npm/@mpgd/analytics: patch (Changed)
npm/@mpgd/bridge: patch (Changed)
npm/@mpgd/capacitor-game-services: patch (Changed)
npm/@mpgd/catalog: patch (Changed)
npm/@mpgd/cli: patch (Changed)
npm/@mpgd/create-game: patch (Changed)
npm/@mpgd/game-runtime: patch (Changed)
npm/@mpgd/game-services: patch (Changed)
npm/@mpgd/i18n: patch (Changed)
npm/@mpgd/input-controls: patch (Changed)
npm/@mpgd/phaser-assets: patch (Changed)
npm/@mpgd/platform: patch (Changed)
npm/@mpgd/runtime-diagnostics: patch (Changed)
npm/@mpgd/target-config: patch (Changed)
npm/@mpgd/tutorial: patch (Changed)
---

Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.

Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root.
