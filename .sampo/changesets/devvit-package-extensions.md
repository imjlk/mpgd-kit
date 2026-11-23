---
npm/@mpgd/cli: patch (Fixed)
---

A generated game's `pnpm-workspace.yaml` now declares `packageExtensions` for the Devvit 0.15.4 packages that import modules they do not declare: `@devvit/media` (`@devvit/shared-types`), `@devvit/protos` (`long`), and `@devvit/build-pack`, whose devvit.json entry template for `devvit upload` and `devvit playtest` imports `@devvit/public-api` and `@devvit/scheduler`. A hoisted install resolved these by accident; under pnpm's global virtual store or another isolated layout, `pnpm build:devvit` stopped on an unresolved import and the upload bundle could not be built. An existing game can copy the block from the template into its root `pnpm-workspace.yaml` and run `pnpm install`. When a game updates its Devvit pins, it moves these keys and their Devvit versions to the same release.
