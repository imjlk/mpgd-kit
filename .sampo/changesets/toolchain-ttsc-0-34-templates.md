---
npm/@mpgd/cli: patch (Changed)
---

Generated games, and `mpgd kit migrate-tools`, now pin `ttsc` and `@ttsc/unplugin` 0.34.2 (from 0.32.1), and the CLI's runtime `typia` dependency moves to 15.2.1. ttsc 0.34 builds its plugins with Go 1.27. It uses the Go 1.27.3 it bundles unless `TTSC_GO_BINARY` names another Go, which then must be 1.27 or later.
