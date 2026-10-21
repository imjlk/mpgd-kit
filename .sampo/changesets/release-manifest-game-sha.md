---
npm/@mpgd/cli: patch
npm/@mpgd/release-manifest: patch
---

`mpgd target build` no longer records `uncommitted` or the kit commit as the game revision when the game checkout cannot be resolved. A missing or invalid `MPGD_SOURCE_GIT_SHA` fails the build. Release manifests now require `gitSha` to be a lowercase 40-character SHA, matching `kitGitSha`, and require effective-config and icon digests to be lowercase 64-character SHA-256 hex.
