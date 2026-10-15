# ttsc toolchain maintenance

The root `package.json` pins `ttsc` and its graph, lint, paths, strip, and unplugin
packages to one exact release. Workspace manifests and the published CLI's game
templates use the same version. `pnpm validate:toolchain` detects drift before
`pnpm check` starts compiling, including nested generated target templates and
`pnpm-workspace.yaml` native-package age exceptions.

## TypeScript is the authored-source default

Author game code, tests, templates, and ordinary development tools in `.ts`.
Select them in an owning strict TypeScript project and include that project in
`check`. Execute scripts with `ttsx`; when a consumer needs JavaScript, build
JavaScript from the typed source instead of maintaining a second implementation.
An extension rename without type-check coverage is not a migration. Avoid `any`,
blanket assertions, and ignored diagnostics to get a green check: parse external
JSON as `unknown`, narrow it at the boundary, and use concrete internal contracts.

Generated Phaser and Lite games have a `tsconfig.tools.json` selecting
`tools/**/*.ts`. Their `check`, `lint`, `format`, and `fix` commands include both
the game and tools projects. `pnpm accept` executes the typed acceptance entry
through that project with no authored JavaScript bootstrap. The pinned ttsx
0.32.1 forwards terminal flags such as `--help` after the entry; the old 0.30.4
runner intercepted them even after `--`. Keep the argument-forwarding regression
check when changing the runner.
`pnpm test:template-tools` creates both templates in
supported standalone/workspace modes (Lite currently requires workspace), checks
the tools, introduces deliberate type errors in a nested tool, and verifies successful and failed assertions at runtime.
This does not migrate existing consumer checkouts automatically.

Authored `.mjs`, `.cjs`, or `.js` needs a concrete constraint and a nearby comment
explaining why it cannot use the normal typed path. The following are intentional
boundaries, not a precedent for unrelated scripts:

- `tools/run-ttsx.mjs`, `tools/ttsx-project-entry.mjs`, and the compiled runner/loader
  must start or select the TypeScript execution path before that path can run.
- The untransformed `tools/smoke/ttsx-assertions.mjs` must independently detect
  when compilation strips a failing assertion. Running that observer through
  the compiler under test could hide the same failure. Keep its source and
  compiled-path checks; see the assertion-preservation fix `8aa896f2`.
- Published-JavaScript import tests run in a plain Node consumer without TS
  loaders or source aliases. Browser-executed JS fixtures test that same boundary.
- The authored `.js` sibling fixture tests that runners preserve existing
  JavaScript sources.
- `strip.config.js` remains a small, type-checked loader boundary: the 0.32.1
  native strip loader resolves the config under the wrong root when macOS
  `TMPDIR` is a symlink. Its `@satisfies` contract is checked by the maintenance
  project. Do not normalize users' environments just to hide this limitation.
  The lint body is `tools/config/lint.ts` with `satisfies`, including exact
  Evidence rule option types. A minimal `lint.config.js` re-export lets Node 24
  load it directly: the 0.32.1 TS lint-config loader fails emitted-source
  ownership checks during concurrent Windows package builds.

Existing JavaScript is not automatically an approved exception. Review ordinary
scripts when touching them and convert those without a runtime constraint. This
change converts the share-link validator/tests and Evidence export validator;
other existing CI and browser-test orchestration remains a migration backlog,
not a claim that all `.mjs` files are required. New shipped game tools have no
JavaScript exceptions; `validate:starter-workflow` rejects them.

`tsconfig.maintenance-tools.json` keeps the converted metadata-only validators
and tests independent of generated i18n or built package output, so pre-build CI
can still run them. They also remain included in the full tools check.

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

The gate originally protected against ttsx 0.30.x's trailing-path-stem fallback:
an excluded `commerce-provider.test.ts` could run another project's same-named
file. The pinned 0.32.1 runtime fixes source ownership. An untransformed test in
`tools/run-ttsx.test.mjs` now proves the raw runner executes the requested source.
We retain the wrapper's narrower inclusion rule as repository policy: scripts
must also be covered by the selected project during ordinary `check`, not just
checked opportunistically when executed. The compiled lane already uses the
entry's exact mirrored path. Refused entries continue to record their CI timing.

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

Starting with 0.32, `ttscgraph` belongs to the exact-version
`@ttsc/graph-<platform>-<arch>` dependency of `@ttsc/graph`, not the compiler's
platform package. Keep those native packages in the lockfile and scoped release-age
exceptions. The local resolver delegates to the installed graph package;
`graph:preflight` exercises the JavaScript client and native producer together.

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

## Migrating existing generated games

Run the installed CLI from the game's workspace (Node 24.11 or newer):

```sh
pnpm exec mpgd kit migrate-tools --game ./games/puzzle-one --json
pnpm exec mpgd kit migrate-tools --game ./games/puzzle-one --apply
```

The first command only prints the plan. The second recomputes and applies it.
The command recognizes the generated acceptance runner and standard check/lint/
format/fix scripts, adds a strict tools project, and aligns compiler dependencies
with the shipped template. It preserves the runner's Kit location and unrelated
scripts. Custom runners, comments, scripts, configurations, or version specifiers
block automatic application; migrate those manually without discarding changes.

Standalone dependency changes refresh the game lockfile with lifecycle scripts
disabled. Failure restores managed files and the previous lockfile. Concurrent
migrations, changed plan inputs, and linked managed paths are rejected. A game
inside a parent pnpm workspace must have its toolchain aligned first: this command
does not modify the parent's manifest or lockfile. After applying, install the
updated dependencies normally and run `pnpm check` and `pnpm accept --help`.
