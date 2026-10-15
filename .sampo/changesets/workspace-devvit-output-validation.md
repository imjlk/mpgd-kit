---
npm/@mpgd/cli: minor (Added)
---

Validate Devvit bundle names before writing files, including case collisions on
Windows and conflicts with the configured public directory. Improve workspace
build diagnostics for dependencies linked to another game's installation or the
Kit store when a different workspace owns the active build.

Expose the shared collision guard through `@mpgd/cli/devvit` and register it in
shipped wrapper Vite configurations so staging watch/playtest builds enforce the
same output rules as production builds.
