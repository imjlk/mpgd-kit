---
npm/@mpgd/cli: patch (Changed)
---

Generated games, and `mpgd kit migrate-tools`, now pin `ttsc` and `@ttsc/unplugin` 0.37.1 (from 0.34.2), and the CLI's runtime `typia` dependency moves to 15.4.1. ttsc 0.37 still builds its plugins with Go 1.27 or later; it uses the Go 1.27.4 it bundles unless `TTSC_GO_BINARY` names another Go.
