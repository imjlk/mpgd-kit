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

Each `ttsx` process type-checks and emits the whole tools program again, because
its execution cache is scoped to one process. Orchestrating commands that spawn
more tool processes, such as `build:target` and its validators and package build,
pass `--compile-once`. The runner then emits `tsconfig.ci-tools.json` once into
`node_modules/.cache/mpgd-tools-emit/<pid>-*` and runs the entry from that emit.
Nested `run-ttsx.mjs` invocations from the same checkout reuse it through
`MPGD_CI_EMIT_ROOT` and `MPGD_TOOLS_EMIT_SOURCE_ROOT`. A `--compile-once` command
never reuses an inherited emit that does not name this checkout. The directory is
removed when the command exits. If a signal kills the command, the next
`--compile-once` command prunes the leftover directory. The type-check gate still runs once
per top-level command. If the emit fails, the runner falls back to `ttsx`, which
reports the diagnostics. `MPGD_FORCE_TTSX=1` restores per-process `ttsx`.

`build:target` also passes `--reuse-unchanged` to `tools/package/build-packages.ts`.
A workspace package is not rebuilt when two things hold:

- Its input fingerprint matches the build recorded in
  `node_modules/.cache/mpgd-package-build/fingerprints/`. The fingerprint covers
  the package files (without `dist` and `node_modules`), the fingerprints of its
  workspace dependencies, and the build toolchain files.
- Its `dist` still hashes to the recorded output.

`@mpgd/cli` records the Kit Git SHA, so it is reused only from a clean checkout at
the same `HEAD`. `build:packages`, which release builds use, always rebuilds every
package. `MPGD_REBUILD_PACKAGES=1` forces a full rebuild from `build:target` too.

Packages that are rebuilt compile concurrently: each starts once the workspace
packages it depends on (including dev and peer dependencies) are built, up to
`os.availableParallelism()` at a time. `MPGD_PACKAGE_BUILD_CONCURRENCY=1` builds
one package at a time. The compilers run with Node directly rather than through
`pnpm exec`, which costs about two seconds per call. Each package runs `ttsc`
(JavaScript and lint) and then `tsc --emitDeclarationOnly`: published
declarations come from the stock TypeScript printer, because ttsc's declaration
emit formats some types differently.

The shared tsconfig pins `rootDir` to the repository root. Workspace projects
include/import sibling sources; a narrower inferred root can make TypeScript-Go
emit those outside-root files beside their sources when ttsx loads a Vite config
as a separate dependency project. The runtime-boundary canary verifies that this
path leaves source siblings unchanged. Package builds still explicitly set their
own `src` root and `dist` output in the generated build configuration.
Generated standalone games use their own root; `--workspace` games explicitly
use the common ancestor of the game and kit. Target wrappers inherit that game
setting, so a sibling checkout does not inherit the kit's narrower root.

## Entries must belong to the selected project

`run-ttsx.mjs` runs the entry through the project named by `--project` (or
`TTSC_PROJECT`, default `tsconfig.tools.json`). The entry must be one of that
project's root files, that is, matched by its `files`/`include` globs after
`exclude`. The runner asks TypeScript-Go for that set (`tsgo --showConfig`,
a few milliseconds) and refuses any other entry before ttsx starts, naming the
project and the fix. Being imported by a project file is not enough: the entry
itself must be selected. `--project <directory>` names that directory's
`tsconfig.json`, as with `tsc -p`. A project whose globs match nothing is
reported as a project problem (`tsgo --showConfig` exits 0 and prints no
`files`); other config errors, such as unreadable JSON or a missing `extends`
target, still yield a file set and are reported by ttsx when it builds.

The rule exists because ttsx compiles the whole project and then looks up the
entry's emitted JavaScript. The ttsc launcher documents an entry-only build for
files the project does not select, but its lookup first falls back to
trailing-path-stem matching across the project emit
(`resolveEmittedJavaScript` in `ttsc/lib/compiler/internal`, reached from
`prepareExecution`). With `rootDir` at the repository root, an entry such as
`native-plugins/capacitor-storekit/src/commerce-provider.test.ts` run through
`tsconfig.tools.json` is answered with the emit of
`adapters/ait/src/commerce-provider.test.ts`, and that unrelated file executes
under the requested entry's URL (its relative imports then fail with
`ERR_MODULE_NOT_FOUND` against the wrong directory, or worse, succeed). The
runner's gate makes that substitution impossible. It is deliberately narrower
than ttsc's own behaviour: ttsx would also build an entry outside the project's
`rootDir` through a synthesized entry-only project, and this repository turns
that lane off on purpose so every entry runs inside a project that selects it.
The compiled `--compile-once`/`MPGD_CI_EMIT_ROOT` lane is unaffected because it
only runs an emit at the entry's own mirrored path; the gate runs before a
`--compile-once` emit is spent on an entry, and a refused entry still records a
`refused` row in the CI timing summary. The gate guards a ttsc launcher
behaviour (ttsc 0.30.x); when upstream stops answering an out-of-project entry
with a stem match, revisit whether it can be narrowed to the documented
entry-only lane. `tools/run-ttsx.test.mjs` holds the reproduction.

Workspace packages whose sources are outside `tsconfig.tools.json` (the
`native-plugins/capacitor-storekit` and `native-plugins/capacitor-play-billing`
test scripts) pass `--project native-plugins/<plugin>/tsconfig.json`; those
configs select `src/**` and the `test/**` fixtures. `tools/run-ttsx.test.mjs`
keeps the gate and that wiring under test.

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
requires answer-ready results that cite each preset's `namedEntrypoints` by
file and symbol name. It does not check which directories the ranked anchors
land in, because that ranking drifts with unrelated code; see
[`tools/graph/README.md`](https://github.com/imjlk/mpgd-kit/blob/main/tools/graph/README.md)
for the preset contract,
how to add a preset, and why feature PRs must not edit presets to make
`pnpm graph:preflight` pass.

`pnpm graph:preflight` reuses one dump per cwd/tsconfig within the invocation.
The upstream resident graph session supports incremental refreshes, but this
runner does not claim persistent cross-worktree sharing. A future shared graph
store must account for compiler/schema versions, config and dependency changes,
uncommitted inputs, and reference-document changes before reusing graph shards.
