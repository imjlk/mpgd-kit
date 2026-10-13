---
npm/@mpgd/cli: patch
---

Fix Windows target builds by launching the active pnpm executable or JavaScript
entrypoint directly instead of a global pnpm.cmd shim. Generated Phaser games
enable pnpm's shell emulator so Microsoft Store scripts resolve their KIT path
and POSIX environment defaults correctly on Windows.
