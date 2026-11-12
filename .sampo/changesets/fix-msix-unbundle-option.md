---
npm/@mpgd/cli: patch (Fixed)
---

Use supported Windows SDK options when inspecting MSIX/AppX bundles. Remove the unsupported `/l` option from `makeappx unbundle` while preserving package identity, payload, path, symlink and hash checks.
