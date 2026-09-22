# ttsc toolchain maintenance

The root `package.json` pins `ttsc` and its graph, lint, paths, strip, and unplugin
packages to one exact release. Workspace manifests and the published CLI's game
templates use the same version. `pnpm validate:toolchain` detects drift before
`pnpm check` starts compiling, including nested generated target templates and
`pnpm-workspace.yaml` native-package age exceptions.

## Updating the toolchain

1. Start from the current integration branch in an isolated worktree. Read its
   `AGENTS.md` and the target release notes.
2. Update the root and workspace `ttsc`/`@ttsc/*` dependencies, shipped templates,
   and matching version-specific age exceptions. Keep TypeScript, typia, Node,
   and Go changes scoped to compatibility requirements. Regenerate the lockfile
   with pnpm and verify a frozen install and peer dependencies.
   `pnpm format` uses `tsconfig.format.json` so tools, Vite configs, and generated
   template sources are formatted along with workspace code. Installed dependency
   sources and generated Paraglide output stay outside the lint/format scope.
3. Run `pnpm test:tooling`, `pnpm check`, `pnpm test`, and `pnpm graph:preflight`.
   Exercise the generated starter and the affected target builds. The assertion
   and CLI-output canaries must pass from both source and compiled entrypoints.
4. Add Sampo changesets for affected publishable package metadata and templates.
   Record the cold/warm build timings and unresolved environment limitations in
   the PR. Do not update historical changelogs or pinned submission worktrees.

`mise exec -- <command>` uses the checked-in Node and Go versions. The project's
`TTSC_GO_BINARY` override keeps Go and GOROOT aligned. `tools/run-ttsx.mjs` keeps
TypeScript-Go resolution and application arguments consistent; emitted runtime
files are owned by ttsx. It does not delete authored `.js` or `.d.ts` source siblings.

The shared tsconfig pins `rootDir` to the repository root. Workspace projects
include/import sibling sources; a narrower inferred root can make TypeScript-Go
emit those outside-root files beside their sources when ttsx loads a Vite config
as a separate dependency project. The runtime-boundary canary verifies that this
path leaves source siblings unchanged. Package builds still explicitly set their
own `src` root and `dist` output in the generated build configuration.

## Cache ownership and measurement

Run `pnpm cache:paths` to distinguish compiled plugin binaries (`requiredRoots`)
from Go build objects (`acceleratorRoots`). For inspection without pnpm's
automatic dependency reconciliation, invoke the installed launcher directly:

```sh
node node_modules/ttsc/lib/launcher/ttsc.js cache paths --json
```

Go objects accelerate future plugin rebuilds; an already-matching compiled
plugin does not need them to run. The `ttsx` runtime cache and graph JSON exports
are separate outputs. Measure each category rather than attributing all of
`node_modules/.cache/ttsc` to graph dumps. Filesystem clone/hardlink sharing also
means directory-size sums are not an exact estimate of reclaimable disk space.

The current default Go cache has an 8 GiB maintenance ceiling and a 6 GiB target;
active builds and recent objects can delay eviction. This is a per-root policy,
not a budget across all worktrees. Older inactive worktrees do not gain the new
policy just because another checkout upgrades.

CI restores and saves only `node_modules/.cache/ttsc/plugins`, after installation,
with OS, architecture, and lockfile keys. Go objects and runtime output are not
part of that persisted cache. Native plugin content keys independently reject
incompatible restored binaries.

`TTSC_CACHE_DIR` and `TTSC_GO_CACHE_DIR` select caller-owned paths and disable the
corresponding automatic cleanup. Sharing a path across worktrees therefore needs
an explicit retention/size policy and coordination with active builds. Keep that
as a separate change from the toolchain upgrade; do not symlink entire
`node_modules` trees or bulk-delete other worktrees' caches. See the
[upstream cache guide](https://ttsc.dev/docs/ttsc/cache/) and
[Go cache lifecycle issue](https://github.com/samchon/ttsc/issues/1185).

## Graph compatibility

Local presets carry `{ reason, type }` in `draft`. Tours use the question plus
`request.reinterpretations` symbol names; details and traces keep their selected
handles. The runner preserves the outer `{ audit, next, result }` envelope and
requires answer-ready results with the preset's expected source anchors.

`pnpm graph:preflight` reuses one dump per cwd/tsconfig within the invocation.
The upstream resident graph session supports incremental refreshes, but this
runner does not claim persistent cross-worktree sharing. A future shared graph
store must account for compiler/schema versions, config and dependency changes,
uncommitted inputs, and reference-document changes before reusing graph shards.
