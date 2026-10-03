---
npm/@mpgd/cli: patch
---

Patch security advisories in CLI runtime dependencies: bump `undici` to `^7.29.1` (TLS certificate validation bypass, cross-user information disclosure, and denial-of-service fixes) and `sharp` to `0.35.4` (libheif fixes), and pin patched transitive versions of `nanoid`, `postcss`, `qs`, `brace-expansion`, `browserslist`, and `baseline-browser-mapping` through workspace overrides.
