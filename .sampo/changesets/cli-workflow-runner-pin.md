---
npm/@mpgd/cli: patch (Changed)
---

`mpgd deploy workflow init` now writes `runs-on: ubuntu-24.04` for the PR validation and Android deployment jobs instead of `ubuntu-latest`, so a GitHub runner image roll-over no longer silently changes the toolchains a game's release is built with. The iOS job keeps `macos-26`. Workflows generated earlier are not rewritten; edit their `runs-on:` lines to adopt the pin.
