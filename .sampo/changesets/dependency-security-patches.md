---
npm/@mpgd/cli: patch
---

Patch security advisories in CLI runtime dependencies. `@mpgd/cli` now requires `undici` `^7.29.1` (TLS certificate validation bypass, cross-user information disclosure, and denial-of-service fixes) and `sharp` `0.35.5` (libheif fixes plus the librsvg use-after-free in GHSA-wq5f-xc86-pv6w, which affects SVG icon inputs on glibc-based Linux). These two bumps ship in the published package.

The patched transitive versions of `postcss`, `nanoid`, `qs`, `brace-expansion`, `browserslist`, `baseline-browser-mapping`, and `protobufjs` are pinned through `pnpm-workspace.yaml` overrides, which apply only to this repository's workspace and CI; pnpm does not carry overrides into published packages. Consumers keep their own resolved transitive versions and should run `pnpm audit` and apply their own overrides as needed.
