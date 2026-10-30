---
npm/@mpgd/cli: patch (Changed)
---

`mpgd deploy workflow init` now writes `runs-on: ubuntu-24.04` for the PR validation and Android deployment jobs instead of `ubuntu-latest`, so a GitHub `ubuntu-latest` roll-over no longer moves a game's release builds to a new Ubuntu release, with different preinstalled toolchains, without a workflow change. The iOS job keeps `macos-26`. Workflows generated earlier are not rewritten; edit their `runs-on:` lines to adopt the pin.
